//! AI dust/hair inference: detector U-Net → probability map, MI-GAN inpaint over
//! masked tiles. Reuses the upscaler's `plan_tiles`/`Tile` tiling.
//!
//! PHASE-0 CONTRACT: the exact tensor names, channel layout, and normalization
//! below are the COMMON conventions for these model families and compile/run as
//! a scaffold, but MUST be reconciled with the real exported models recorded in
//! docs/superpowers/spikes/autodust-model-notes.md before shipping. Search this
//! file for `PHASE-0` for every spot that needs confirmation.

use crate::autodust::{DETECT_SHORT, TILE, TILE_PAD};
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

/// Build a session for `model`, registering CoreML on macOS. Windows runs on
/// CPU: the shared `onnxruntime.dll` is a DirectML build, so requesting the
/// DirectML EP actually engages D3D12/DirectML (it does NOT fall back to CPU as
/// once assumed) and crashes the process — a native access violation deep in
/// onnxruntime that Rust's `Result` cannot catch — on the detector/MI-GAN models
/// regardless of GPU (repro'd on an RTX 3080 Ti). Until a verified GPU path
/// exists, omit the Windows EP so ort defaults to the always-safe CPU provider.
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

/// sRGB transfer (linear [0,1] → gamma-encoded [0,1]) and its inverse. MI-GAN was
/// trained on gamma-encoded sRGB photos, so we encode before inference + decode
/// after (see `inpaint`'s base-neutralization).
fn srgb_encode(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }
}
fn srgb_decode(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.040_45 { x / 12.92 } else { ((x + 0.055) / 1.055).powf(2.4) }
}

/// Smallest film-base divisor (avoid divide-by-zero on a degenerate channel).
const BASE_EPS: f32 = 1e-4;

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

/// Round `v` to the nearest positive multiple of 16 (the detector's depth-4
/// UNet needs both spatial dims divisible by 16).
fn round16(v: usize) -> usize {
    (((v + 8) / 16) * 16).max(16)
}

/// Detection working dims for a `w`×`h` source: short side scaled to
/// `DETECT_SHORT` (never upscaling beyond native), both rounded to a multiple of
/// 16. Returns `(dw, dh)`.
fn detect_dims(w: usize, h: usize) -> (usize, usize) {
    if w == 0 || h == 0 {
        return (16, 16);
    }
    let short = w.min(h);
    let target = DETECT_SHORT.min(short); // don't upscale tiny sources
    let r = target as f64 / short as f64;
    (round16((w as f64 * r).round() as usize), round16((h as f64 * r).round() as usize))
}

/// Run the detector over `src` (positive RGB f32 [0,1]) and return a whole-frame
/// probability map (`prob[y*w+x]` in [0,1], higher = more likely a defect).
///
/// Real BOPBTL contract: 1-channel grayscale NCHW [1,1,h,w] normalized to
/// [-1,1] = (luma - 0.5)/0.5; output `logits` [1,1,h,w] → sigmoid. The net is
/// fully convolutional, so we run it once at `DETECT_SHORT`-short-side and
/// nearest-upsample the probability map back to the source resolution.
pub fn detect(app_data: &Path, src: &Image) -> Result<Vec<f32>, String> {
    let mut session = make_session(app_data, &assets::detector_path(app_data))?;
    let input_name = session.inputs()[0].name().to_string();
    let output_name = session.outputs()[0].name().to_string();

    let (dw, dh) = detect_dims(src.width, src.height);
    let small = crate::convert::resize_to(src, dw as u32, dh as u32);

    // Grayscale, normalized to [-1,1].
    let mut input = Array4::<f32>::zeros((1, 1, dh, dw));
    for y in 0..dh {
        for x in 0..dw {
            let g = luma(small.pixels[y * dw + x]).clamp(0.0, 1.0);
            input[[0, 0, y, x]] = g * 2.0 - 1.0;
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
    if shape.len() < 2 {
        return Err(format!("unexpected detector output shape: {shape:?}"));
    }
    let (oh, ow) = (shape[shape.len() - 2], shape[shape.len() - 1]);
    let flat = view.as_slice().ok_or("detector output not contiguous")?;

    // Sigmoid the logits at detection scale, then nearest-upsample to full res.
    let mut prob = vec![0f32; src.width * src.height];
    for y in 0..src.height {
        let sy = (y * oh / src.height.max(1)).min(oh - 1);
        for x in 0..src.width {
            let sx = (x * ow / src.width.max(1)).min(ow - 1);
            prob[y * src.width + x] = sigmoid(flat[sy * ow + sx]);
        }
    }
    Ok(prob)
}

/// Inpaint the masked pixels of `img` (RGB f32 [0,1]) in place using MI-GAN,
/// tile by tile, only where the mask has content. On a per-tile inference error
/// the tile's pixels are left untouched (degrading a render beats aborting it —
/// same policy as `film_core::dust::inpaint_masked`).
///
/// MI-GAN `migan_pipeline_v2.onnx` contract (verified against the real model):
/// two uint8 NCHW inputs — `image` [1,3,h,w] and `mask` [1,1,h,w] where 255 =
/// KEEP and 0 = HOLE — and one uint8 output `result` [1,3,h,w]. The pipeline
/// crops around the hole, resizes to 512, inpaints, and blends back internally,
/// so we feed each masked tile at native size and keep fills sharp.
pub fn inpaint(app_data: &Path, img: &mut Image, mask: &Mask, base: [f32; 3]) -> Result<(), String> {
    if mask.w == 0 || mask.h == 0 {
        return Ok(());
    }
    let mut session = make_session(app_data, &assets::migan_path(app_data))?;
    let tiles = plan_tiles(img.width, img.height, TILE, TILE_PAD);
    let sel = masked_tiles(&tiles, mask);

    // Feed MI-GAN a NEUTRAL, gamma-encoded image: divide out the per-channel film
    // base (orange mask) so the three channels are balanced, then sRGB-encode. This
    // matches the model's training domain and — crucially — keeps the fill's
    // per-channel error balanced, so the Cineon inversion (`log10(px/base)` per
    // channel) no longer turns a tiny fill error into a complementary-colored halo
    // on smooth regions (e.g. sky). The output is decoded + re-based back to the
    // raw-negative linear space the GPU expects.
    let enc = |v: f32, b: f32| -> u8 {
        (srgb_encode((v / b.max(BASE_EPS)).clamp(0.0, 1.0)) * 255.0 + 0.5) as u8
    };
    let dec = |u: u8, b: f32| -> f32 { srgb_decode(u as f32 / 255.0) * b };

    for &i in &sel {
        let t = tiles[i];
        // image: uint8 RGB; mask: uint8 grayscale (0 = hole, 255 = keep).
        let mut image_t = Array4::<u8>::zeros((1, 3, t.sh, t.sw));
        let mut mask_t = Array4::<u8>::from_elem((1, 1, t.sh, t.sw), 255u8);
        for yy in 0..t.sh {
            for xx in 0..t.sw {
                let gx = t.sx + xx;
                let gy = t.sy + yy;
                let p = img.pixels[gy * img.width + gx];
                image_t[[0, 0, yy, xx]] = enc(p[0], base[0]);
                image_t[[0, 1, yy, xx]] = enc(p[1], base[1]);
                image_t[[0, 2, yy, xx]] = enc(p[2], base[2]);
                if gx < mask.w && gy < mask.h && mask.bits[gy * mask.w + gx] {
                    mask_t[[0, 0, yy, xx]] = 0; // hole
                }
            }
        }
        let image_v = match Tensor::from_array(image_t) { Ok(v) => v, Err(_) => continue };
        let mask_v = match Tensor::from_array(mask_t) { Ok(v) => v, Err(_) => continue };
        let outputs = match session.run(ort::inputs!["image" => image_v, "mask" => mask_v]) {
            Ok(o) => o,
            Err(_) => continue, // leave this tile untouched on inference error
        };
        let view = match outputs["result"].try_extract_array::<u8>() {
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
                    dec(view[[0, 0, sy, sx]], base[0]),
                    dec(view[[0, 1, sy, sx]], base[1]),
                    dec(view[[0, 2, sy, sx]], base[2]),
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
    fn enc_dec_roundtrips_within_quantization() {
        // The base-neutralize + sRGB transform must round-trip a normal (kept) pixel
        // so non-hole pixels aren't shifted. Test the valid sky range (neg ≤ base).
        let base = [0.85f32, 0.62, 0.42];
        for c in 0..3 {
            for &ratio in &[0.2f32, 0.5, 0.9] {
                let v = base[c] * ratio;
                let u = (srgb_encode((v / base[c]).clamp(0.0, 1.0)) * 255.0 + 0.5) as u8;
                let back = srgb_decode(u as f32 / 255.0) * base[c];
                assert!((back - v).abs() < 0.01, "roundtrip v={v} c={c} back={back}");
            }
        }
    }

    #[test]
    fn neutral_fill_has_no_color_cast_after_inversion() {
        // The fix's mechanism: a neutral fill value `g` (what MI-GAN produces on a
        // smooth region in the neutralized space) decodes to a negative whose
        // per-channel ratio to `base` is CONSTANT across channels — so the Cineon
        // inversion `log10(px/base)` yields only a luminance change, never a colored
        // halo. (The old raw path filled per-channel in the orange negative, so the
        // ratios diverged → complementary-colored halo on sky.)
        let base = [0.85f32, 0.62, 0.42];
        for &g in &[40u8, 120, 200] {
            let neg: [f32; 3] = std::array::from_fn(|c| srgb_decode(g as f32 / 255.0) * base[c]);
            let r: [f32; 3] = std::array::from_fn(|c| neg[c] / base[c]);
            assert!((r[0] - r[1]).abs() < 1e-6 && (r[1] - r[2]).abs() < 1e-6, "ratios {r:?}");
        }
    }

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

    #[test]
    fn detect_dims_scale_short_to_512_and_multiple_of_16() {
        // 6000x4000 → short 4000 scaled to 512 → ratio 0.128 → 768x512.
        let (dw, dh) = detect_dims(6000, 4000);
        assert_eq!((dw, dh), (768, 512));
        assert_eq!(dw % 16, 0);
        assert_eq!(dh % 16, 0);
    }

    #[test]
    fn detect_dims_never_upscales_small_sources() {
        // 300x200: short 200 < 512 → keep native, rounded to ÷16.
        let (dw, dh) = detect_dims(300, 200);
        assert!(dw <= 304 && dh <= 208, "got {dw}x{dh}");
        assert_eq!(dw % 16, 0);
        assert_eq!(dh % 16, 0);
    }
}
