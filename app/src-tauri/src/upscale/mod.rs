//! Local image upscaling (Real-ESRGAN via ONNX Runtime). ALL ONNX/model/download
//! logic lives under this module — the rest of the app only sees the commands in
//! `commands.rs`. To swap the model or engine later, change `engine.rs`/`assets.rs`.

pub mod assets;
pub mod engine;

/// Longest-side cap for upscaled output.
pub const MAX_OUTPUT_EDGE: u32 = 8192;
/// Fixed scale factor of the bundled Real-ESRGAN model.
pub const MODEL_SCALE: u32 = 4;

/// Decide the upscale target for a source of `in_w` x `in_h`.
///
/// Returns `Some((feed_w, feed_h, out_w, out_h))` when upscaling is beneficial:
/// `out` longest = min(MODEL_SCALE * in_long, MAX_OUTPUT_EDGE), and `feed` is the
/// input downscaled to `out/MODEL_SCALE` so the fixed-4x model lands on `out`.
/// Returns `None` when the source is already at/over the cap (nothing to gain).
pub fn target_dims(in_w: u32, in_h: u32) -> Option<(u32, u32, u32, u32)> {
    let in_long = in_w.max(in_h);
    if in_long == 0 || in_long >= MAX_OUTPUT_EDGE {
        return None;
    }
    let out_long = (MODEL_SCALE * in_long).min(MAX_OUTPUT_EDGE);
    let feed_long = out_long / MODEL_SCALE; // <= 2048
    let scale = |v: u32| -> u32 { ((v as u64 * feed_long as u64) / in_long as u64).max(1) as u32 };
    let feed_w = scale(in_w);
    let feed_h = scale(in_h);
    let out_w = feed_w * MODEL_SCALE;
    let out_h = feed_h * MODEL_SCALE;
    Some((feed_w, feed_h, out_w, out_h))
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
    on_tile: impl FnMut(usize, usize),
) -> Result<Image, String> {
    let (fw, fh, ow, oh) = target_dims(fin.width as u32, fin.height as u32)
        .ok_or("image is already at or above 8K on its longest side")?;
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
    fn small_source_upscales_4x() {
        // 1000x667 -> feed unchanged (1000<=2048) -> out 4000x2668
        assert_eq!(target_dims(1000, 667), Some((1000, 667, 4000, 2668)));
    }

    #[test]
    fn caps_output_at_8k_longest() {
        // 3000 long -> out capped 8192 -> feed 2048 long
        let (fw, fh, ow, oh) = target_dims(3000, 2000).unwrap();
        assert!(ow.max(oh) <= MAX_OUTPUT_EDGE);
        assert_eq!(fw.max(fh), 2048);
        assert_eq!(ow, fw * 4);
        assert_eq!(oh, fh * 4);
    }

    #[test]
    fn source_at_or_over_cap_is_noop() {
        assert_eq!(target_dims(8192, 5000), None);
        assert_eq!(target_dims(9000, 9000), None);
        assert_eq!(target_dims(0, 0), None);
    }

    #[test]
    fn preserves_aspect_within_one_px() {
        let (fw, fh, _, _) = target_dims(6000, 4000).unwrap();
        let in_ar = 6000.0_f64 / 4000.0;
        let feed_ar = fw as f64 / fh as f64;
        assert!((in_ar - feed_ar).abs() < 0.02, "feed {fw}x{fh}");
    }
}
