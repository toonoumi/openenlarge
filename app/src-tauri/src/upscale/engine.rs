//! Real-ESRGAN tiled inference via ONNX Runtime. The model is a fixed 4x SR net
//! (RealESRGAN realesr-general-x4v3): input NCHW f32 RGB in [0,1], output 4x.

/// A tile to run through the model: source rect (with padding) + the inner rect
/// (without padding) used to crop the model output back to seamless content.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    pub sx: usize, // source x of the padded read (in input px)
    pub sy: usize,
    pub sw: usize, // padded read width
    pub sh: usize,
    pub ix: usize, // inner (unpadded) x relative to the padded tile
    pub iy: usize,
    pub iw: usize, // inner content width
    pub ih: usize,
    pub ox: usize, // output x of the inner content in the FULL input grid
    pub oy: usize,
}

/// Split a `w` x `h` input into tiles of up to `tile` px with `pad` overlap.
/// Each tile reads `pad` extra px on every interior edge; the padded margin is
/// cropped from the model output so seams disappear. Output coords are in INPUT
/// space (multiply by scale=4 when writing into the 4x buffer).
pub fn plan_tiles(w: usize, h: usize, tile: usize, pad: usize) -> Vec<Tile> {
    let mut tiles = Vec::new();
    let mut oy = 0;
    while oy < h {
        let ih = tile.min(h - oy);
        let mut ox = 0;
        while ox < w {
            let iw = tile.min(w - ox);
            let sx = ox.saturating_sub(pad);
            let sy = oy.saturating_sub(pad);
            let ex = (ox + iw + pad).min(w);
            let ey = (oy + ih + pad).min(h);
            tiles.push(Tile {
                sx, sy, sw: ex - sx, sh: ey - sy,
                ix: ox - sx, iy: oy - sy, iw, ih,
                ox, oy,
            });
            ox += iw;
        }
        oy += ih;
    }
    tiles
}

use crate::upscale::assets;
use film_core::Image;
use ndarray::Array4;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::Path;
use std::sync::Once;

static INIT: Once = Once::new();

/// Point `ort` at the downloaded runtime library exactly once per process.
fn init_runtime(app_data: &Path) {
    INIT.call_once(|| {
        let lib = assets::runtime_path(app_data);
        std::env::set_var("ORT_DYLIB_PATH", lib);
    });
}

/// Build a session for the model, registering the platform GPU EP with CPU
/// fallback (ort falls back to CPU automatically if a registered EP fails).
fn make_session(app_data: &Path) -> Result<Session, String> {
    init_runtime(app_data);
    let builder = Session::builder()
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = {
        use ort::execution_providers::CoreMLExecutionProvider;
        builder
            .with_execution_providers([CoreMLExecutionProvider::default().build()])
            .map_err(|e| e.to_string())?
    };
    #[cfg(target_os = "windows")]
    let builder = {
        use ort::execution_providers::DirectMLExecutionProvider;
        builder
            .with_execution_providers([DirectMLExecutionProvider::default().build()])
            .map_err(|e| e.to_string())?
    };

    let mut builder = builder;
    builder
        .commit_from_file(assets::model_path(app_data))
        .map_err(|e| format!("load model: {e}"))
}

/// Run one padded tile (RGB f32 [0,1], NCHW) and return the 4x RGB f32 output.
fn run_tile(
    session: &mut Session,
    rgb: &[[f32; 3]],
    w: usize,
    h: usize,
) -> Result<(Vec<[f32; 3]>, usize, usize), String> {
    let mut input = Array4::<f32>::zeros((1, 3, h, w));
    for y in 0..h {
        for x in 0..w {
            let p = rgb[y * w + x];
            input[[0, 0, y, x]] = p[0];
            input[[0, 1, y, x]] = p[1];
            input[[0, 2, y, x]] = p[2];
        }
    }
    // Query the model's actual input/output names (community conversions vary).
    let input_name = session.inputs()[0].name().to_string();
    let output_name = session.outputs()[0].name().to_string();
    let tensor = Tensor::from_array(input).map_err(|e| e.to_string())?;
    let outputs = session
        .run(ort::inputs![input_name.as_str() => tensor])
        .map_err(|e| format!("inference: {e}"))?;
    // rc.12: `try_extract_array` yields an `ndarray::ArrayViewD` we can index.
    let view = outputs[output_name.as_str()]
        .try_extract_array::<f32>()
        .map_err(|e| e.to_string())?;
    let shape = view.shape();
    let (oh, ow) = (shape[2], shape[3]);
    let mut pixels = vec![[0f32; 3]; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            pixels[y * ow + x] = [
                view[[0, 0, y, x]].clamp(0.0, 1.0),
                view[[0, 1, y, x]].clamp(0.0, 1.0),
                view[[0, 2, y, x]].clamp(0.0, 1.0),
            ];
        }
    }
    Ok((pixels, ow, oh))
}

/// Upscale a finished `Image` (linear f32 RGB [0,1]) by the model's fixed 4x,
/// tiled with overlap, calling `on_tile(done, total)` after each tile.
pub fn upscale_4x(
    app_data: &Path,
    src: &Image,
    tile: usize,
    pad: usize,
    mut on_tile: impl FnMut(usize, usize),
) -> Result<Image, String> {
    const SCALE: usize = 4;
    let mut session = make_session(app_data)?;
    let tiles = plan_tiles(src.width, src.height, tile, pad);
    let total = tiles.len();
    let (ow, oh) = (src.width * SCALE, src.height * SCALE);
    let mut out = vec![[0f32; 3]; ow * oh];

    for (i, t) in tiles.iter().enumerate() {
        let mut buf = vec![[0f32; 3]; t.sw * t.sh];
        for yy in 0..t.sh {
            for xx in 0..t.sw {
                buf[yy * t.sw + xx] = src.pixels[(t.sy + yy) * src.width + (t.sx + xx)];
            }
        }
        let (up, uw, _uh) = run_tile(&mut session, &buf, t.sw, t.sh)?;
        for yy in 0..t.ih * SCALE {
            for xx in 0..t.iw * SCALE {
                let srcx = t.ix * SCALE + xx;
                let srcy = t.iy * SCALE + yy;
                let dstx = t.ox * SCALE + xx;
                let dsty = t.oy * SCALE + yy;
                out[dsty * ow + dstx] = up[srcy * uw + srcx];
            }
        }
        on_tile(i + 1, total);
    }

    Ok(Image { width: ow, height: oh, pixels: out, ir: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_tile_when_image_fits() {
        let t = plan_tiles(100, 80, 256, 16);
        assert_eq!(t.len(), 1);
        let only = t[0];
        assert_eq!((only.ox, only.oy, only.iw, only.ih), (0, 0, 100, 80));
        assert_eq!((only.sx, only.sy, only.sw, only.sh), (0, 0, 100, 80));
    }

    #[test]
    fn tiles_cover_every_pixel_exactly_once() {
        let (w, h) = (500usize, 300usize);
        let tiles = plan_tiles(w, h, 128, 8);
        let mut covered = vec![0u32; w * h];
        for t in &tiles {
            for yy in t.oy..t.oy + t.ih {
                for xx in t.ox..t.ox + t.iw {
                    covered[yy * w + xx] += 1;
                }
            }
        }
        assert!(covered.iter().all(|&c| c == 1), "every inner pixel covered once");
    }

    #[test]
    fn interior_tiles_have_padding() {
        let tiles = plan_tiles(500, 500, 128, 8);
        let interior = tiles.iter().find(|t| t.ox > 0 && t.oy > 0).unwrap();
        assert_eq!(interior.ix, 8);
        assert_eq!(interior.iy, 8);
    }
}
