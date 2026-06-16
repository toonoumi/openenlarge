//! Local color-toning match: derive develop params that make the current image's
//! CIELAB region statistics approach those of an imported reference image. Fully
//! local — no network, no LLM. See docs/superpowers/specs/2026-06-16-color-match-reference-design.md.

use film_core::Image;

/// Mean CIELAB of one tonal region.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RegionStats {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

/// Toning fingerprint of an image: per-region mean Lab, global L spread
/// (contrast proxy) and mean chroma (saturation proxy).
#[derive(Clone, Copy, Debug, Default)]
pub struct ImageStats {
    pub sh: RegionStats,
    pub mid: RegionStats,
    pub hi: RegionStats,
    pub l_std: f32,
    pub chroma: f32,
}

/// sRGB-encoded channel (0..1) → linear.
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// sRGB pixel (0..1 each) → CIELAB (D65). L in 0..100, a/b roughly -128..127.
fn srgb_to_lab(px: [f32; 3]) -> [f32; 3] {
    let r = srgb_to_linear(px[0].clamp(0.0, 1.0));
    let g = srgb_to_linear(px[1].clamp(0.0, 1.0));
    let b = srgb_to_linear(px[2].clamp(0.0, 1.0));
    // linear sRGB → XYZ (D65)
    let x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    // normalize by D65 white
    let (xn, yn, zn) = (0.95047, 1.0, 1.08883);
    let f = |t: f32| -> f32 {
        if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 }
    };
    let (fx, fy, fz) = (f(x / xn), f(y / yn), f(z / zn));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Compute the toning fingerprint of an image. Pixels are treated as sRGB 0..1
/// (engine/finish output and decoded reference are both display-encoded).
/// Tonal split by L*: shadows L<33, mid 33..=66, hi >66. Empty regions fall back
/// to the global mean so the optimizer always has a target.
pub fn compute_stats(img: &Image) -> ImageStats {
    let n = img.pixels.len().max(1) as f32;
    let mut g = RegionStats::default();
    let mut sums = [(RegionStats::default(), 0f32); 3]; // (accum, count) for sh/mid/hi
    let mut l_vals: Vec<f32> = Vec::with_capacity(img.pixels.len());
    let mut chroma_sum = 0f32;

    for &px in &img.pixels {
        let lab = srgb_to_lab(px);
        g.l += lab[0]; g.a += lab[1]; g.b += lab[2];
        l_vals.push(lab[0]);
        chroma_sum += (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        let idx = if lab[0] < 33.0 { 0 } else if lab[0] <= 66.0 { 1 } else { 2 };
        sums[idx].0.l += lab[0]; sums[idx].0.a += lab[1]; sums[idx].0.b += lab[2];
        sums[idx].1 += 1.0;
    }
    let global = RegionStats { l: g.l / n, a: g.a / n, b: g.b / n };
    let region = |i: usize| -> RegionStats {
        let (s, c) = sums[i];
        if c < 1.0 { global } else { RegionStats { l: s.l / c, a: s.a / c, b: s.b / c } }
    };
    let mean_l = global.l;
    let var = l_vals.iter().map(|&l| (l - mean_l) * (l - mean_l)).sum::<f32>() / n;
    ImageStats {
        sh: region(0), mid: region(1), hi: region(2),
        l_std: var.sqrt(),
        chroma: chroma_sum / n,
    }
}

/// Decode a reference image file, downscale to a small working size, and compute
/// its toning fingerprint. Returns Err with a readable message on decode failure.
pub fn reference_stats(path: &str) -> Result<ImageStats, String> {
    let dyn_img = image::open(path).map_err(|e| format!("reference decode: {e}"))?;
    let small = dyn_img.thumbnail(256, 256).to_rgb8(); // long edge ≤256, keeps aspect
    let pixels: Vec<[f32; 3]> = small
        .pixels()
        .map(|p| [p.0[0] as f32 / 255.0, p.0[1] as f32 / 255.0, p.0[2] as f32 / 255.0])
        .collect();
    let img = Image { width: small.width() as usize, height: small.height() as usize, pixels, ir: None };
    Ok(compute_stats(&img))
}

/// Weighted squared distance between two fingerprints. Region a*/b* (color cast)
/// dominate; L and global contrast/chroma are weighted lower so exposure/contrast
/// don't fight the cast match.
pub fn loss(cur: &ImageStats, target: &ImageStats) -> f32 {
    let region = |c: &RegionStats, t: &RegionStats| -> f32 {
        0.5 * (c.l - t.l).powi(2) + (c.a - t.a).powi(2) + (c.b - t.b).powi(2)
    };
    region(&cur.sh, &target.sh)
        + region(&cur.mid, &target.mid)
        + region(&cur.hi, &target.hi)
        + 0.25 * (cur.l_std - target.l_std).powi(2)
        + 0.25 * (cur.chroma - target.chroma).powi(2)
}

use crate::commands::{finish_from, mode_from, resolve_params, effective_base, effective_dmax};
use crate::session::InvertParams;
use film_core::finish::finish_image; // film-core does NOT re-export these at crate root
use film_core::engine::invert_image; // (lib.rs only re-exports `Image`)

/// Render `src` (a raw-negative thumbnail) to its developed positive under `p`,
/// reusing the exact live-preview pipeline, and return its toning fingerprint.
/// `dev_base`/`dev_d_max` are the develop-time auto values from `Developed`.
pub fn render_stats(p: &InvertParams, src: &Image, dev_base: [f32; 3], dev_d_max: f32) -> ImageStats {
    let mut ip = resolve_params(p, src, effective_base(p, dev_base));
    ip.d_max = effective_dmax(p, dev_d_max);
    let inv = invert_image(src, &ip, mode_from(&p.mode));
    let out = finish_image(&inv, &finish_from(p));
    compute_stats(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use film_core::Image;

    fn solid(rgb: [f32; 3], px: usize) -> Image {
        Image { width: px, height: 1, pixels: vec![rgb; px], ir: None }
    }

    #[test]
    fn white_is_near_l100_neutral() {
        let s = compute_stats(&solid([1.0, 1.0, 1.0], 16));
        assert!((s.mid.l).max(s.hi.l) > 95.0, "white L should be ~100");
        assert!(s.hi.a.abs() < 2.0 && s.hi.b.abs() < 2.0, "white is neutral a/b≈0");
    }

    #[test]
    fn warm_pixel_has_positive_b() {
        // A warm (orange) pixel should have positive b* (yellow) and positive a* (red).
        let s = compute_stats(&solid([0.8, 0.5, 0.2], 16));
        assert!(s.mid.b > 5.0 || s.hi.b > 5.0, "warm → +b*");
    }

    #[test]
    fn loss_is_zero_for_identical_stats() {
        let s = compute_stats(&solid([0.5, 0.4, 0.3], 32));
        assert!(loss(&s, &s) < 1e-6, "identical stats → ~0 loss");
    }

    #[test]
    fn loss_grows_with_cast_difference() {
        let warm = compute_stats(&solid([0.8, 0.5, 0.2], 32));
        let cool = compute_stats(&solid([0.2, 0.5, 0.8], 32));
        let neutral = compute_stats(&solid([0.5, 0.5, 0.5], 32));
        assert!(loss(&warm, &cool) > loss(&warm, &neutral), "opposite cast → larger loss");
    }
}
