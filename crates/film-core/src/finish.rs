//! Creative finishing layer, applied to the gamma-encoded positive produced by
//! the inversion core. All params are 0.0 = identity. Tone/saturation are
//! per-pixel; texture (Task 2) is a spatial unsharp pass.

use crate::Image;

const EPS: f32 = 1e-5;

/// Creative controls. UI sends −100..100 (and EV for exposure, handled upstream);
/// these are pre-scaled to −1..1 by the caller. 0.0 everywhere = identity.
#[derive(Debug, Clone, Copy)]
pub struct FinishParams {
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub texture: f32,
    pub vibrance: f32,
    pub saturation: f32,
}

impl Default for FinishParams {
    fn default() -> Self {
        FinishParams {
            contrast: 0.0, highlights: 0.0, shadows: 0.0, whites: 0.0, blacks: 0.0,
            texture: 0.0, vibrance: 0.0, saturation: 0.0,
        }
    }
}

/// Per-channel parametric tone curve in [0,1] display space. Monotone region
/// weights; final clamp to [0,1]. Order: endpoints (whites/blacks) → region
/// (highlights/shadows) → contrast S-gain about mid-gray.
fn tone_curve(v: f32, p: &FinishParams) -> f32 {
    let mut v = v.clamp(0.0, 1.0);
    // Endpoints: strongest at the extremes.
    v += p.whites * 0.20 * v.powi(3);
    v -= p.blacks * 0.20 * (1.0 - v).powi(3);
    // Regions: lift/pull, zero at both ends.
    v += p.shadows * 0.30 * (1.0 - v).powi(2) * v;
    v += p.highlights * 0.30 * v.powi(2) * (1.0 - v);
    // Contrast: linear gain about 0.5.
    v = 0.5 + (v - 0.5) * (1.0 + p.contrast);
    v.clamp(0.0, 1.0)
}

/// Vibrance/saturation: push each channel away from luma. Saturation is uniform;
/// vibrance is weighted by (1 − current saturation) so vivid pixels move less.
fn apply_saturation(rgb: [f32; 3], p: &FinishParams) -> [f32; 3] {
    let y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let mx = rgb[0].max(rgb[1]).max(rgb[2]);
    let mn = rgb[0].min(rgb[1]).min(rgb[2]);
    let cur_sat = if mx > EPS { (mx - mn) / mx } else { 0.0 };
    let factor = 1.0 + p.saturation + p.vibrance * (1.0 - cur_sat);
    std::array::from_fn(|c| (y + (rgb[c] - y) * factor).clamp(0.0, 1.0))
}

/// Per-pixel finishing (tone curve per channel, then saturation across channels).
pub fn finish_pixel(rgb: [f32; 3], p: &FinishParams) -> [f32; 3] {
    let toned = [tone_curve(rgb[0], p), tone_curve(rgb[1], p), tone_curve(rgb[2], p)];
    apply_saturation(toned, p)
}

/// Apply finishing to a whole image. Texture (spatial) is added in Task 2.
pub fn finish_image(img: &Image, p: &FinishParams) -> Image {
    let pixels = img.pixels.iter().map(|&px| finish_pixel(px, p)).collect();
    // NOTE: texture (a spatial unsharp pass) is added here in Task 2.
    Image { width: img.width, height: img.height, pixels, ir: img.ir.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img_from(pixels: Vec<[f32; 3]>) -> Image {
        Image { width: pixels.len(), height: 1, pixels, ir: None }
    }

    #[test]
    fn default_is_identity() {
        let p = FinishParams::default();
        for v in [0.0_f32, 0.2, 0.5, 0.8, 1.0] {
            let px = [v, v * 0.5, v * 0.25];
            let out = finish_pixel(px, &p);
            for c in 0..3 {
                assert!((out[c] - px[c]).abs() < 1e-4, "v={v} c={c} out={}", out[c]);
            }
        }
    }

    #[test]
    fn positive_contrast_widens_spread() {
        let p = FinishParams { contrast: 0.5, ..Default::default() };
        let dark = tone_curve(0.25, &p);
        let bright = tone_curve(0.75, &p);
        assert!(dark < 0.25, "dark {dark}");
        assert!(bright > 0.75, "bright {bright}");
    }

    #[test]
    fn positive_whites_raises_highlights_more_than_mids() {
        let p = FinishParams { whites: 1.0, ..Default::default() };
        assert!(tone_curve(0.9, &p) - 0.9 > tone_curve(0.5, &p) - 0.5);
    }

    #[test]
    fn positive_blacks_darkens_shadows() {
        let p = FinishParams { blacks: 1.0, ..Default::default() };
        assert!(tone_curve(0.1, &p) < 0.1);
    }

    #[test]
    fn positive_shadows_raises_shadows_more_than_mids() {
        let p = FinishParams { shadows: 1.0, ..Default::default() };
        assert!(tone_curve(0.25, &p) - 0.25 > tone_curve(0.6, &p) - 0.6);
    }

    #[test]
    fn positive_saturation_increases_chroma() {
        let p = FinishParams { saturation: 0.5, ..Default::default() };
        let px = [0.6, 0.4, 0.3];
        let out = apply_saturation(px, &p);
        let chroma_in = px[0] - px[2];
        let chroma_out = out[0] - out[2];
        assert!(chroma_out > chroma_in, "in {chroma_in} out {chroma_out}");
    }

    #[test]
    fn vibrance_affects_muted_more_than_vivid() {
        let p = FinishParams { vibrance: 1.0, ..Default::default() };
        let muted = [0.52, 0.50, 0.48];
        let vivid = [0.90, 0.10, 0.05];
        let chroma = |px: [f32; 3]| px[0].max(px[1]).max(px[2]) - px[0].min(px[1]).min(px[2]);
        let ratio = |px: [f32; 3]| chroma(apply_saturation(px, &p)) / chroma(px);
        // Vibrance boosts low-saturation (muted) pixels more than already-vivid ones.
        assert!(ratio(muted) > ratio(vivid), "muted {} vivid {}", ratio(muted), ratio(vivid));
    }

    #[test]
    fn finish_image_default_returns_equal_image() {
        let src = img_from(vec![[0.2, 0.4, 0.6], [0.7, 0.5, 0.3]]);
        let out = finish_image(&src, &FinishParams::default());
        assert_eq!(out.width, src.width);
        assert_eq!(out.height, src.height);
        for (o, s) in out.pixels.iter().zip(src.pixels.iter()) {
            for c in 0..3 {
                assert!((o[c] - s[c]).abs() < 1e-4, "c={c} out={} src={}", o[c], s[c]);
            }
        }
    }
}
