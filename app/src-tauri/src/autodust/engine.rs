//! AI dust/hair inference: detector U-Net → probability map, MI-GAN inpaint over
//! masked tiles. Reuses the upscaler's `plan_tiles`/`Tile` tiling.
//!
//! PHASE-0 CONTRACT: the exact tensor names, channel layout, and normalization
//! below are the COMMON conventions for these model families and compile/run as
//! a scaffold, but MUST be reconciled with the real exported models recorded in
//! docs/superpowers/spikes/autodust-model-notes.md before shipping. Search this
//! file for `PHASE-0` for every spot that needs confirmation.

use crate::autodust::{TILE, TILE_PAD};
use crate::upscale::assets as up_assets;
use crate::autodust::assets;
use crate::upscale::engine::{plan_tiles, Tile};
use film_core::dust::Mask;
use film_core::Image;
use ndarray::Array4;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::Path;
use std::sync::Once;

static INIT: Once = Once::new();

/// Point `ort` at the shared (upscaler) runtime library exactly once per process.
fn init_runtime(app_data: &Path) {
    INIT.call_once(|| {
        std::env::set_var("ORT_DYLIB_PATH", up_assets::runtime_path(app_data));
    });
}

/// Build a session for `model`, registering the platform GPU EP with CPU
/// fallback (ort falls back to CPU automatically if a registered EP fails).
fn make_session(app_data: &Path, model: &Path) -> Result<Session, String> {
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
        .commit_from_file(model)
        .map_err(|e| format!("load model: {e}"))
}

/// Rec.709 luma of a linear RGB pixel, used as the detector's grayscale input.
fn luma(p: [f32; 3]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

/// Logistic sigmoid (for models that emit logits rather than probabilities).
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Indices of `tiles` whose inner rect overlaps any masked pixel. Used to skip
/// clean tiles so MI-GAN only runs where there is something to fill.
pub fn masked_tiles(tiles: &[Tile], mask: &Mask) -> Vec<usize> {
    let mut out = Vec::new();
    if mask.w == 0 || mask.h == 0 {
        return out;
    }
    for (i, t) in tiles.iter().enumerate() {
        let mut hit = false;
        'scan: for yy in t.oy..(t.oy + t.ih) {
            for xx in t.ox..(t.ox + t.iw) {
                // mask spans the whole frame (x0=y0=0); index directly.
                if xx < mask.w && yy < mask.h && mask.bits[yy * mask.w + xx] {
                    hit = true;
                    break 'scan;
                }
            }
        }
        if hit {
            out.push(i);
        }
    }
    out
}

/// Run the detector over `src` (positive RGB f32 [0,1]), tiled, and return a
/// whole-frame probability map (`prob[y*w+x]` in [0,1], higher = more likely a
/// defect).
///
/// PHASE-0: input is fed as 1-channel grayscale (Rec.709 luma) NCHW [1,1,h,w]
/// normalized to [0,1]; output is read as [1,1,h,w] and squashed with sigmoid
/// only when it falls outside [0,1]. Confirm the detector's true input channels
/// (1 vs 3), normalization (mean/std?), and whether the output is logits.
pub fn detect(app_data: &Path, src: &Image) -> Result<Vec<f32>, String> {
    let mut session = make_session(app_data, &assets::detector_path(app_data))?;
    let tiles = plan_tiles(src.width, src.height, TILE, TILE_PAD);
    let mut prob = vec![0f32; src.width * src.height];

    let input_name = session.inputs()[0].name().to_string();
    let output_name = session.outputs()[0].name().to_string();

    for t in &tiles {
        // Build the grayscale input from the padded tile.
        let mut input = Array4::<f32>::zeros((1, 1, t.sh, t.sw));
        for yy in 0..t.sh {
            for xx in 0..t.sw {
                let p = src.pixels[(t.sy + yy) * src.width + (t.sx + xx)];
                input[[0, 0, yy, xx]] = luma(p).clamp(0.0, 1.0);
            }
        }
        let tensor = Tensor::from_array(input).map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs![input_name.as_str() => tensor])
            .map_err(|e| format!("detector inference: {e}"))?;
        let view = outputs[output_name.as_str()]
            .try_extract_array::<f32>()
            .map_err(|e| e.to_string())?;
        let shape = view.shape();
        // Accept [1,1,h,w] or [1,h,w]; index the last two dims.
        if shape.len() < 2 {
            return Err(format!("unexpected detector output shape: {shape:?}"));
        }
        let (oh, ow) = (shape[shape.len() - 2], shape[shape.len() - 1]);
        if oh != t.sh || ow != t.sw {
            return Err(format!(
                "detector output {oh}x{ow} != input {}x{}",
                t.sh, t.sw
            ));
        }
        let flat = view.as_slice().ok_or("detector output not contiguous")?;
        // Copy the inner (unpadded) rect into the full-frame prob map.
        for yy in 0..t.ih {
            for xx in 0..t.iw {
                let v = flat[(t.iy + yy) * ow + (t.ix + xx)];
                let p = if (0.0..=1.0).contains(&v) { v } else { sigmoid(v) };
                prob[(t.oy + yy) * src.width + (t.ox + xx)] = p;
            }
        }
    }
    Ok(prob)
}

/// Inpaint the masked pixels of `img` (RGB f32 [0,1]) in place using MI-GAN,
/// tile by tile, only where the mask has content. On a per-tile inference error
/// the tile's pixels are left untouched (degrading a render beats aborting it —
/// same policy as `film_core::dust::inpaint_masked`).
///
/// PHASE-0: the input is built as 4-channel NCHW [1,4,h,w] = (R,G,B, mask) with
/// the masked RGB zeroed and mask=1 inside the hole; output is read as [1,3,h,w]
/// RGB. Confirm MI-GAN's true input arity (single 4-ch tensor vs separate
/// image+mask inputs), mask polarity (1=hole vs 1=keep), and fixed input size
/// (if the model is static e.g. 512, resize the window to it and back here).
pub fn inpaint(app_data: &Path, img: &mut Image, mask: &Mask) -> Result<(), String> {
    if mask.w == 0 || mask.h == 0 {
        return Ok(());
    }
    let mut session = make_session(app_data, &assets::migan_path(app_data))?;
    let tiles = plan_tiles(img.width, img.height, TILE, TILE_PAD);
    let sel = masked_tiles(&tiles, mask);

    let input_name = session.inputs()[0].name().to_string();
    let output_name = session.outputs()[0].name().to_string();

    for &i in &sel {
        let t = tiles[i];
        // Build the 4-channel input (masked RGB + mask) for the padded window.
        let mut input = Array4::<f32>::zeros((1, 4, t.sh, t.sw));
        for yy in 0..t.sh {
            for xx in 0..t.sw {
                let gx = t.sx + xx;
                let gy = t.sy + yy;
                let masked = gx < mask.w && gy < mask.h && mask.bits[gy * mask.w + gx];
                let p = img.pixels[gy * img.width + gx];
                let m = if masked { 1.0 } else { 0.0 };
                // Zero the RGB inside the hole; pass mask in channel 3.
                input[[0, 0, yy, xx]] = if masked { 0.0 } else { p[0] };
                input[[0, 1, yy, xx]] = if masked { 0.0 } else { p[1] };
                input[[0, 2, yy, xx]] = if masked { 0.0 } else { p[2] };
                input[[0, 3, yy, xx]] = m;
            }
        }
        let tensor = match Tensor::from_array(input) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let outputs = match session.run(ort::inputs![input_name.as_str() => tensor]) {
            Ok(o) => o,
            Err(_) => continue, // leave this tile untouched on inference error
        };
        let view = match outputs[output_name.as_str()].try_extract_array::<f32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let shape = view.shape();
        if shape.len() != 4 || shape[1] < 3 || shape[2] != t.sh || shape[3] != t.sw {
            continue;
        }
        // Write back ONLY the masked pixels of the inner (unpadded) rect.
        for yy in 0..t.ih {
            for xx in 0..t.iw {
                let gx = t.ox + xx;
                let gy = t.oy + yy;
                if !(gx < mask.w && gy < mask.h && mask.bits[gy * mask.w + gx]) {
                    continue;
                }
                let (sy, sx) = (t.iy + yy, t.ix + xx);
                img.pixels[gy * img.width + gx] = [
                    view[[0, 0, sy, sx]].clamp(0.0, 1.0),
                    view[[0, 1, sy, sx]].clamp(0.0, 1.0),
                    view[[0, 2, sy, sx]].clamp(0.0, 1.0),
                ];
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masked_tiles_selects_only_tiles_overlapping_the_mask() {
        // 500x300 frame, 128px tiles. Put one masked pixel at (10,10) → only the
        // top-left tile should be selected.
        let (w, h) = (500usize, 300usize);
        let tiles = plan_tiles(w, h, 128, 8);
        let mut bits = vec![false; w * h];
        bits[10 * w + 10] = true;
        let mask = Mask { x0: 0, y0: 0, w, h, bits };
        let sel = masked_tiles(&tiles, &mask);
        assert_eq!(sel.len(), 1);
        let t = tiles[sel[0]];
        assert!(t.ox <= 10 && 10 < t.ox + t.iw && t.oy <= 10 && 10 < t.oy + t.ih);
    }

    #[test]
    fn masked_tiles_empty_for_empty_mask() {
        let tiles = plan_tiles(200, 200, 128, 8);
        let mask = Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
        assert!(masked_tiles(&tiles, &mask).is_empty());
    }
}
