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
}
