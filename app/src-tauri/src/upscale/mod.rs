//! Local image upscaling (Real-ESRGAN via ONNX Runtime). ALL ONNX/model/download
//! logic lives under this module — the rest of the app only sees the commands in
//! `commands.rs`. To swap the model or engine later, change `engine.rs`/`assets.rs`.

pub mod assets;
pub mod engine;

/// Longest-side cap for upscaled output.
pub const MAX_OUTPUT_EDGE: u32 = 8192;
/// Fixed scale factor of the bundled Real-ESRGAN model.
pub const MODEL_SCALE: u32 = 4;

/// Decide the upscale feed/output dims for a source of `in_w` x `in_h` targeting
/// `target_long` px on the longest side (aspect preserved). Output longest side is
/// `min(target_long, MAX_OUTPUT_EDGE)`; the model is fixed 4x, so we feed it an
/// image scaled to `out_long / MODEL_SCALE`. Returns `(feed_w, feed_h, out_w, out_h)`,
/// or `None` for a degenerate (zero-size) source.
pub fn target_dims(in_w: u32, in_h: u32, target_long: u32) -> Option<(u32, u32, u32, u32)> {
    let in_long = in_w.max(in_h);
    if in_long == 0 {
        return None;
    }
    let out_long = target_long.min(MAX_OUTPUT_EDGE).max(MODEL_SCALE);
    let feed_long = out_long / MODEL_SCALE;
    // Scale each dimension to the feed size, preserving aspect (rounded, min 1).
    let scale = |v: u32| -> u32 {
        ((v as u64 * feed_long as u64 + (in_long as u64) / 2) / in_long as u64).max(1) as u32
    };
    let feed_w = scale(in_w);
    let feed_h = scale(in_h);
    Some((feed_w, feed_h, feed_w * MODEL_SCALE, feed_h * MODEL_SCALE))
}

use film_core::Image;

/// Default tiling: 256 px tiles with 16 px overlap (bounded memory, seamless).
pub const TILE: usize = 256;
pub const TILE_PAD: usize = 16;

/// Result returned to the panel after an upscale (preview only; full-res is stashed).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleResult {
    pub preview_data_url: String,
    pub out_w: u32,
    pub out_h: u32,
}

/// Downscale `fin` to the model feed size, run tiled 4x, and resize to the exact
/// 8K-capped target. Returns the full-res upscaled image. `on_tile(done,total)`
/// reports inference progress.
pub fn run(
    app_data: &std::path::Path,
    fin: &Image,
    target_long: u32,
    on_tile: impl FnMut(usize, usize),
) -> Result<Image, String> {
    let (fw, fh, ow, oh) = target_dims(fin.width as u32, fin.height as u32, target_long)
        .ok_or("source image is empty")?;
    let feed = crate::convert::resize_to(fin, fw, fh);
    let up = engine::upscale_4x(app_data, &feed, TILE, TILE_PAD, on_tile)?;
    let up = if up.width as u32 == ow && up.height as u32 == oh {
        up
    } else {
        crate::convert::resize_to(&up, ow, oh)
    };
    Ok(up)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_k_target_landscape() {
        // 1000x667 @ 4K(3840) -> feed long 960 -> out 3840x2560.
        let (fw, fh, ow, oh) = target_dims(1000, 667, 3840).unwrap();
        assert_eq!((fw, ow), (960, 3840));
        assert!(oh <= ow && (fh, oh) == (640, 2560), "got {fh}x{oh}");
    }

    #[test]
    fn eight_k_target_caps_at_ceiling() {
        // target above the 8192 ceiling is clamped.
        let (_, _, ow, oh) = target_dims(4000, 3000, 99999).unwrap();
        assert!(ow.max(oh) <= MAX_OUTPUT_EDGE);
    }

    #[test]
    fn eight_k_is_4x_of_feed_and_preserves_aspect() {
        let (fw, fh, ow, oh) = target_dims(6000, 4000, 7680).unwrap();
        assert_eq!((ow, oh), (fw * 4, fh * 4));
        assert_eq!(ow.max(oh), 7680);
        let in_ar = 6000.0_f64 / 4000.0;
        assert!((in_ar - ow as f64 / oh as f64).abs() < 0.02, "ar off: {ow}x{oh}");
    }

    #[test]
    fn degenerate_source_is_none() {
        assert_eq!(target_dims(0, 0, 7680), None);
    }
}
