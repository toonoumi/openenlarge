//! Estimating the film base (orange mask) from a region of the scan.

use crate::Image;

/// A rectangular region in pixel coords (inclusive top-left, exclusive bottom-right).
#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// Estimate per-channel film base from `rect` as a high percentile (95th) of the
/// region — robust to a few dark specks while tracking the bright clear-base value.
/// If `rect` is None, uses the whole image.
pub fn sample_base(img: &Image, rect: Option<Rect>) -> [f32; 3] {
    let r = rect.unwrap_or(Rect {
        x: 0,
        y: 0,
        w: img.width,
        h: img.height,
    });
    let mut chans: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for yy in r.y..(r.y + r.h).min(img.height) {
        for xx in r.x..(r.x + r.w).min(img.width) {
            let px = img.pixels[yy * img.width + xx];
            for c in 0..3 {
                chans[c].push(px[c]);
            }
        }
    }
    let mut base = [0.0f32; 3];
    for c in 0..3 {
        if chans[c].is_empty() {
            base[c] = 0.0;
            continue;
        }
        chans[c].sort_by(|a, b| a.partial_cmp(b).unwrap());
        let idx = ((chans[c].len() as f32) * 0.95) as usize;
        let idx = idx.min(chans[c].len().saturating_sub(1));
        base[c] = chans[c][idx];
    }
    base
}

/// Luma band for sampling the base from a deliberately-drawn CLEAR-FILM rect:
/// a central trimmed mean rejects dark specks and specular hot pixels.
pub const BASE_BAND_REBATE: (f32, f32) = (0.1, 0.9);
/// Luma band for the whole-frame FALLBACK: the brightest cluster is the clear
/// film / lightbox. Trims the very top to avoid clipped specular highlights.
pub const BASE_BAND_AUTO: (f32, f32) = (0.90, 0.99);

/// Sample the film base as a single COHERENT color: collect the region's pixels,
/// sort by luma, keep the [lo, hi] luma-rank band, and average RGB over that one
/// pixel set. Unlike [`sample_base`] (three independent per-channel percentiles)
/// the result is a real clear-film color, so it removes the orange mask without
/// injecting a per-channel cast. Returns `[0,0,0]` for an empty region.
pub fn sample_base_coherent(img: &Image, rect: Option<Rect>, lo: f32, hi: f32) -> [f32; 3] {
    let r = rect.unwrap_or(Rect {
        x: 0,
        y: 0,
        w: img.width,
        h: img.height,
    });
    let mut px: Vec<[f32; 3]> = Vec::new();
    for yy in r.y..(r.y + r.h).min(img.height) {
        for xx in r.x..(r.x + r.w).min(img.width) {
            px.push(img.pixels[yy * img.width + xx]);
        }
    }
    if px.is_empty() {
        return [0.0, 0.0, 0.0];
    }
    px.sort_by(|a, b| {
        let la = (a[0] + a[1] + a[2]) / 3.0;
        let lb = (b[0] + b[1] + b[2]) / 3.0;
        la.partial_cmp(&lb).unwrap()
    });
    let lo = lo.clamp(0.0, 1.0);
    let hi = hi.clamp(0.0, 1.0);
    let n = px.len();
    let i0 = ((n as f32 * lo) as usize).min(n - 1);
    let i1 = ((n as f32 * hi) as usize).clamp(i0 + 1, n);
    let band = &px[i0..i1];
    let mut sum = [0.0f64; 3];
    for p in band {
        for c in 0..3 {
            sum[c] += p[c] as f64;
        }
    }
    let k = band.len() as f64;
    [(sum[0] / k) as f32, (sum[1] / k) as f32, (sum[2] / k) as f32]
}

/// Default damping for [`auto_wb_gains`]: gains are shrunk toward neutral by this
/// factor. Gray-world is aggressive; applying it at full strength overshoots,
/// especially on film where highlights run warm. 0.7 corrects most of the cast
/// while leaving headroom for the user's manual temp/tint.
pub const AUTO_WB_STRENGTH: f32 = 0.7;

/// Robust gray-world white-balance gains from an (already inverted) image:
/// per-channel multipliers that map a neutral-pixel estimate to gray. Returns
/// `[1,1,1]` for an empty image. Apply as `InversionParams.wb` on a subsequent
/// inversion to neutralize a global cast. Uses [`AUTO_WB_STRENGTH`] damping.
///
/// Unlike a naive average of the brightest pixels — which neutralizes warm
/// highlights (sun/tungsten/skin) and so reads the scene as warm, over-cooling
/// the result into a blue cast — this rejects strongly chromatic pixels (sky,
/// foliage, skin, warm highlights), near-clipped highlights, and shadow noise
/// before averaging, so only genuinely near-neutral pixels drive the estimate.
pub fn auto_wb_gains(img: &Image) -> [f32; 3] {
    auto_wb_gains_strength(img, AUTO_WB_STRENGTH)
}

/// [`auto_wb_gains`] with an explicit damping `strength` in 0..=1 (1 = full
/// gray-world correction, 0 = no correction / `[1,1,1]`).
pub fn auto_wb_gains_strength(img: &Image, strength: f32) -> [f32; 3] {
    if img.pixels.is_empty() {
        return [1.0, 1.0, 1.0];
    }
    // Average only near-neutral, well-exposed pixels. `sat_max` rejects chromatic
    // content that violates the gray assumption; `hi`/`lo` drop clipped highlights
    // (often warm-biased) and shadow noise.
    let accumulate = |sat_max: f32, hi: f32, lo: f32| -> ([f64; 3], u64) {
        let (mut sum, mut n) = ([0.0f64; 3], 0u64);
        for p in &img.pixels {
            let mx = p[0].max(p[1]).max(p[2]);
            let mn = p[0].min(p[1]).min(p[2]);
            let luma = (p[0] + p[1] + p[2]) / 3.0;
            if luma < lo || mx > hi {
                continue;
            }
            let sat = if mx > 1e-6 { (mx - mn) / mx } else { 0.0 };
            if sat > sat_max {
                continue;
            }
            for c in 0..3 {
                sum[c] += p[c] as f64;
            }
            n += 1;
        }
        (sum, n)
    };

    // Need a meaningful sample. If a strong global cast desaturates too few pixels,
    // relax saturation; if still empty (e.g. all clipped), fall back to everything.
    let min_keep = (img.pixels.len() as u64 / 20).max(1); // ≥5%
    let (mut sum, mut n) = accumulate(0.25, 0.95, 0.05);
    if n < min_keep {
        let r = accumulate(0.6, 0.95, 0.05);
        sum = r.0;
        n = r.1;
    }
    if n == 0 {
        let r = accumulate(1.0, 1.1, 0.0);
        sum = r.0;
        n = r.1;
    }
    if n == 0 {
        return [1.0, 1.0, 1.0];
    }

    let mean = [sum[0] / n as f64, sum[1] / n as f64, sum[2] / n as f64];
    let gray = (mean[0] + mean[1] + mean[2]) / 3.0;
    let raw = [
        (gray / mean[0].max(1e-6)) as f32,
        (gray / mean[1].max(1e-6)) as f32,
        (gray / mean[2].max(1e-6)) as f32,
    ];
    // Damp toward neutral so the auto seed corrects most of the cast without
    // overshooting; the user can push further with the manual temp/tint sliders.
    let k = strength.clamp(0.0, 1.0);
    [
        1.0 + k * (raw[0] - 1.0),
        1.0 + k * (raw[1] - 1.0),
        1.0 + k * (raw[2] - 1.0),
    ]
}

/// Auto-derive the Cineon `D_max` (negative density range) over a region: per
/// channel take a low transmission percentile (the densest neg / brightest scene),
/// convert to density `log10(base_c / I_low_c)`, and take the max across channels
/// so no channel clips past print white. Clamped to a sane `[1.0, 4.0]`. Sampling
/// within `rect` lets the caller exclude borders (the image-area crop).
pub fn sample_dmax(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32 {
    const LOW_PCT: f32 = 0.01; // 1st percentile transmission
    let r = rect.unwrap_or(Rect {
        x: 0,
        y: 0,
        w: img.width,
        h: img.height,
    });
    let mut chans: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for yy in r.y..(r.y + r.h).min(img.height) {
        for xx in r.x..(r.x + r.w).min(img.width) {
            let px = img.pixels[yy * img.width + xx];
            for c in 0..3 {
                chans[c].push(px[c]);
            }
        }
    }
    let mut d_max = 1.0f32;
    for c in 0..3 {
        if chans[c].is_empty() || base[c] <= 1e-6 {
            continue;
        }
        chans[c].sort_by(|a, b| a.partial_cmp(b).unwrap());
        let idx = ((chans[c].len() as f32) * LOW_PCT) as usize;
        let i_low = chans[c][idx.min(chans[c].len() - 1)].max(1e-5);
        let density = (base[c] / i_low).log10();
        d_max = d_max.max(density);
    }
    d_max.clamp(1.0, 4.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_dmax_recovers_density_range_and_clamps() {
        // base = 1.0; log-spaced transmission from 1.0 (i=0) down to 0.01 (i=99),
        // so the density range spans log10(1/0.01) = 2.0. The 1st-percentile pick
        // lands at the second-densest pixel (~0.0105 transmission → density ~1.98).
        let mut img = Image::new(100, 1);
        for i in 0..100 {
            let t = 10f32.powf(-2.0 * i as f32 / 99.0);
            img.pixels[i] = [t, t, t];
        }
        let d = sample_dmax(&img, [1.0, 1.0, 1.0], None);
        assert!((d - 2.0).abs() < 0.2, "expected ~2.0 density range, got {d}");

        // A near-clear region (all bright) → tiny range, clamped up to the floor 1.0.
        let flat = Image { width: 4, height: 1, pixels: vec![[0.9, 0.9, 0.9]; 4], ir: None };
        assert!((sample_dmax(&flat, [1.0, 1.0, 1.0], None) - 1.0).abs() < 1e-4, "floor 1.0");

        // A pitch-black region (transmission ~0) must not blow up — clamped to 4.0.
        let dark = Image { width: 4, height: 1, pixels: vec![[0.0001, 0.0001, 0.0001]; 4], ir: None };
        assert!((sample_dmax(&dark, [1.0, 1.0, 1.0], None) - 4.0).abs() < 1e-4, "ceil 4.0");
    }

    #[test]
    fn sample_base_returns_high_percentile() {
        let mut img = Image::new(10, 1);
        for i in 0..10 {
            let v = i as f32 / 10.0;
            img.pixels[i] = [v, 0.5, 0.5];
        }
        let base = sample_base(&img, None);
        assert!(base[0] >= 0.8, "got {}", base[0]);
        assert!((base[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn sample_base_respects_rect() {
        let mut img = Image::new(4, 4);
        for y in 0..4 {
            for x in 0..4 {
                img.pixels[y * 4 + x] = if x < 2 && y < 2 {
                    [0.9, 0.9, 0.9]
                } else {
                    [0.1, 0.1, 0.1]
                };
            }
        }
        let base = sample_base(
            &img,
            Some(Rect {
                x: 0,
                y: 0,
                w: 2,
                h: 2,
            }),
        );
        assert!((base[0] - 0.9).abs() < 1e-6);
    }

    #[test]
    fn sample_base_empty_region_is_zero_no_panic() {
        let img = Image::new(4, 4);
        // zero-area rect must not panic
        let base = sample_base(
            &img,
            Some(Rect {
                x: 0,
                y: 0,
                w: 0,
                h: 0,
            }),
        );
        assert_eq!(base, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn warm_highlights_do_not_trigger_blue_cast() {
        use crate::wb::gains_to_cct;
        // A neutral mid-gray scene (the real subject) with a bright WARM highlight
        // region — the common case (sun/tungsten/skin highlights). The estimator
        // must NOT read this as a warm illuminant and over-cool the image (the
        // white-patch-on-warm-highlights bug that made photos come out too blue).
        let mut pixels = vec![[0.45f32, 0.45, 0.45]; 800];
        pixels.extend(std::iter::repeat([0.90f32, 0.78, 0.62]).take(200));
        let img = Image {
            width: 1000,
            height: 1,
            pixels,
            ir: None,
        };

        let g = auto_wb_gains(&img);
        // Blue must not be strongly boosted over red (that is the cast).
        assert!(
            g[2] - g[0] < 0.12,
            "warm highlights over-cooled the image: gains {g:?}"
        );
        // And the seeded temperature must stay near daylight, not swing warm.
        let (temp, _tint) = gains_to_cct(g);
        assert!(temp >= 4900.0, "estimate read scene as warm: {temp}K");
    }

    #[test]
    fn auto_wb_gains_neutralize_a_global_cast() {
        // A uniformly magenta-cast gray (R,B high vs G) -> gains restore neutral.
        let cast = [0.6f32, 0.5, 0.4];
        let img = Image {
            width: 4,
            height: 4,
            pixels: vec![cast; 16],
            ir: None,
        };
        let spread = |p: [f32; 3]| {
            p.iter().cloned().fold(f32::MIN, f32::max) - p.iter().cloned().fold(f32::MAX, f32::min)
        };

        // Default (damped) gains: green reference, red/blue corrected toward it,
        // and the residual cast is reduced (but not fully removed — see below).
        let g = auto_wb_gains(&img);
        assert!(
            g[2] > g[1] && g[1] > g[0],
            "expected B>G>R gains, got {g:?}"
        );
        let corrected = [cast[0] * g[0], cast[1] * g[1], cast[2] * g[2]];
        assert!(
            spread(corrected) < spread(cast),
            "cast not reduced: {corrected:?}"
        );

        // At full strength the gray-world correction fully neutralizes the patch.
        let gf = auto_wb_gains_strength(&img, 1.0);
        let full = [cast[0] * gf[0], cast[1] * gf[1], cast[2] * gf[2]];
        assert!(
            spread(full) < 1e-4,
            "not neutral at full strength: {full:?}"
        );
    }

    #[test]
    fn coherent_base_is_a_trimmed_mean_of_one_pixel_set() {
        // A clear-film rect: mostly uniform orange, plus a dark speck and a bright
        // specular speck that a central luma band must trim away.
        let mut img = Image::new(10, 1);
        for i in 0..10 {
            img.pixels[i] = [0.43, 0.19, 0.11];
        }
        img.pixels[0] = [0.02, 0.01, 0.01]; // dark speck (trimmed by lo)
        img.pixels[9] = [0.99, 0.98, 0.97]; // specular speck (trimmed by hi)
        let b = sample_base_coherent(&img, None, 0.1, 0.9);
        for c in 0..3 {
            assert!((b[c] - [0.43, 0.19, 0.11][c]).abs() < 1e-3, "ch {c} = {}", b[c]);
        }
    }

    #[test]
    fn coherent_base_bright_band_picks_clear_film_cluster() {
        // A luma gradient (dark scene → bright clear film). The bright band must
        // return ~the bright end, not the per-channel max or the global mean.
        let mut img = Image::new(100, 1);
        for i in 0..100 {
            let v = i as f32 / 99.0;
            img.pixels[i] = [v, v * 0.45, v * 0.26]; // orange-tinted ramp
        }
        let b = sample_base_coherent(&img, None, 0.90, 0.99);
        assert!(b[0] > 0.88, "bright R cluster, got {}", b[0]);
        assert!((b[1] / b[0] - 0.45).abs() < 0.03, "G/R ratio {}", b[1] / b[0]);
        assert!((b[2] / b[0] - 0.26).abs() < 0.03, "B/R ratio {}", b[2] / b[0]);
    }
}
