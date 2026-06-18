//! Color-negative inversion: a single engine, Kodak Cineon densitometry
//! (darktable's negadoctor). Per channel it restores the negative's density in
//! log space, returns to linear, applies a paper inversion + tone curve with a
//! highlight soft-clip, and balances with white balance as a gain on the linear
//! print. See `invert_d` and the negadoctor inversion design spec.

use nalgebra::Matrix3;
use rayon::prelude::*;

/// All knobs for one inversion. Defaults give a reasonable neutral result.
#[derive(Debug, Clone)]
pub struct InversionParams {
    /// Per-channel film-base value (orange mask), from calibrate::sample_base.
    pub base: [f32; 3],
    /// Pre-log linear mix (sensor↔dye crosstalk). Default = identity.
    pub m_pre: Matrix3<f32>,
    /// Post-log density-space unmix. Default = identity.
    pub m_post: Matrix3<f32>,
    /// Exposure multiplier applied after unmix.
    pub exposure: f32,
    /// Black point subtracted (post-exposure), in [0,1)-ish density-output units.
    pub black: f32,
    /// Output gamma encoding exponent (sRGB-ish ~ 1/2.2 applied as power).
    pub gamma: f32,
    /// Per-channel white-balance gain applied in linear light before gamma.
    pub wb: [f32; 3],
    /// Cineon (Mode D) — scalar white / dynamic-range anchor (D_max).
    pub d_max: f32,
    /// Cineon (Mode D) — print exposure (ASC-CDL slope).
    pub print_exposure: f32,
    /// Cineon (Mode D) — paper black (ASC-CDL offset).
    pub paper_black: f32,
    /// Cineon (Mode D) — paper grade (ASC-CDL power; also the display encode).
    /// Valid range: `[0, ∞)`. A negative value yields `Inf` where `print_lin == 0`.
    pub paper_grade: f32,
    /// Cineon (Mode D) — highlight soft-clip threshold.
    pub soft_clip: f32,
    /// HDR mode: expand highlights above the knee into [knee, HDR_HEADROOM] instead
    /// of the SDR soft-clip toward 1.0. Used only for the HDR rendition (encode_hdr).
    pub hdr: bool,
    /// Positive passthrough: skip the Cineon inversion and render the decoded
    /// scan directly (display-encoded), applying only exposure (`print_exposure`)
    /// and white balance (`wb`). For already-positive sources (slides/prints).
    pub positive: bool,
}

impl Default for InversionParams {
    fn default() -> Self {
        InversionParams {
            base: [1.0, 1.0, 1.0],
            m_pre: Matrix3::identity(),
            m_post: Matrix3::identity(),
            exposure: 1.0,
            black: 0.0,
            gamma: 1.0 / 2.2,
            wb: [1.0, 1.0, 1.0],
            d_max: 1.5,
            print_exposure: 1.0,
            paper_black: 0.0,
            paper_grade: 0.95,
            soft_clip: 0.9,
            hdr: false,
            positive: false,
        }
    }
}

const EPS: f32 = 1e-5;
/// HDR highlight expansion: output above this knee is remapped into [knee, HDR_HEADROOM].
const HDR_KNEE: f32 = 0.8;
/// HDR headroom ceiling (linear-ish display units, ~1.3 stops over SDR white).
/// Tuned on real scans later; keep modest to avoid clipping.
const HDR_HEADROOM: f32 = 2.5;
/// Exposure → effective-d_max coupling. EV stops scale d_max by `2^(-K·EV)`:
/// lower EV → larger eff_d_max → flatter highlight slope (blown highlights
/// re-separate); EV=0 → identity. Mirrored verbatim in shaders.ts (INVERT_FRAG).
const EXPO_DMAX_K: f32 = 0.5;
const EFF_DMAX_LO: f32 = 0.5;
const EFF_DMAX_HI: f32 = 6.0;

/// Positive passthrough: the working buffer is linear, so display-encode it with
/// `1/2.2` (matching the raw-scan view), after applying exposure + WB gain.
/// `0 * wb == 0` keeps black neutral, mirroring the inversion's WB convention.
pub fn develop_positive_px(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    // `1/2.2` is hardcoded deliberately: `InversionParams.gamma` is vestigial —
    // the negative path uses `paper_grade` for its display encode and never reads
    // `p.gamma`, so there is no `p.gamma` to honour here either.
    const DISPLAY_GAMMA: f32 = 1.0 / 2.2;
    std::array::from_fn(|c| {
        let lit = (rgb[c] * p.print_exposure * p.wb[c]).max(0.0);
        lit.powf(DISPLAY_GAMMA)
    })
}

/// Kodak Cineon densitometry (darktable negadoctor). Per channel:
/// restore the negative's density in log space, return to linear, apply a paper
/// inversion + tone curve with a highlight soft-clip, and balance with WB as a
/// gain on the linear print. See docs/superpowers/specs/2026-06-07-negadoctor-inversion-design.md.
///
/// WB is applied as a gain on the positive `print_lin` (not as a log-space offset
/// on the negative): `0 * wb == 0`, so deep shadows stay neutral black instead of
/// being tinted/clamped per channel. A log-space offset converges shadows to
/// `print_exposure·(1 − 1/wb[c])`, which drives one channel to black before the
/// others and reads as a colour cast in the darkest tones (the "yellow shadow"
/// bug). A positive-domain gain spreads the WB tint evenly across tones instead.
pub fn invert_d(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    if p.positive {
        return develop_positive_px(rgb, p);
    }
    const THRESHOLD: f32 = 2.328_306_4e-10; // negadoctor's -32 EV floor
    // Exposure acts in the DENSITY domain, not as a linear print gain: EV stops
    // modulate the effective d_max about the black pivot. Lowering EV raises
    // eff_d_max → flatter highlight slope → blown highlights re-separate (I1);
    // EV=0 (print_exposure=1) → eff_d_max==d_max → byte-identical to before.
    let ev = p.print_exposure.max(EPS).log2();
    let eff_d_max =
        (p.d_max * 2f32.powf(-EXPO_DMAX_K * ev)).clamp(EFF_DMAX_LO, EFF_DMAX_HI);
    std::array::from_fn(|c| {
        let clamped = rgb[c].max(THRESHOLD);
        let dmin = p.base[c].max(EPS);
        let log_dens = (clamped / dmin).log10(); // = -log10(dmin/clamped)
        let corrected = log_dens / eff_d_max.max(EPS);
        let ten_to_x = 10f32.powf(corrected);
        // Linear print_exposure gain is DROPPED (folded into eff_d_max above) so the
        // white anchor stays put and exposure redistributes — not scales — highlights.
        let print_lin = ((1.0 + p.paper_black) - ten_to_x).max(0.0);
        // WB as a linear gain on the print; keeps black neutral (0·wb = 0).
        let out = (print_lin * p.wb[c]).powf(p.paper_grade);
        if p.hdr {
            // HDR: expand highlights above the knee into [knee, HDR_HEADROOM] so
            // speculars/lights exceed SDR white (the gain map captures this headroom).
            if out > HDR_KNEE {
                let t = ((out - HDR_KNEE) / (1.0 - HDR_KNEE)).clamp(0.0, 1.0);
                HDR_KNEE + t * (HDR_HEADROOM - HDR_KNEE)
            } else {
                out
            }
        } else if out > p.soft_clip {
            // Reciprocal (Reinhard-style) highlight rolloff. Matches the lower
            // branch's value AND slope at the knee, so nothing at or below
            // soft_clip changes — but it has a far longer tail than the old
            // exponential, so distinct bright highlights keep their separation
            // instead of all slamming to ~1.0. That preserved separation is the
            // latitude the Develop Highlights/Contrast sliders can then pull back.
            let comp = (1.0 - p.soft_clip).max(EPS);
            let u = (out - p.soft_clip) / comp;
            1.0 - comp / (1.0 + u)
        } else {
            out
        }
    })
}

/// Which inversion to run. One engine: Kodak Cineon (negadoctor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Kodak Cineon densitometry (darktable negadoctor).
    D,
}

/// Invert a whole image (returns a new Image, same dims).
pub fn invert_image(img: &crate::Image, p: &InversionParams, _mode: Mode) -> crate::Image {
    // par_iter + collect into Vec preserves index order, so output is identical
    // to the sequential map; `invert_d` is pure (no shared state).
    let pixels = img.pixels.par_iter().map(|&px| invert_d(px, p)).collect();
    crate::Image {
        width: img.width,
        height: img.height,
        pixels,
        ir: img.ir.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Image;

    #[test]
    fn invert_image_is_per_pixel_and_order_preserving() {
        // A multi-pixel image must invert each pixel exactly as the scalar fn does,
        // in the same order — this guards the parallel collect() against reordering.
        // Non-default print_exposure exercises the eff_d_max path so the parallel
        // invert_image stays pinned to the scalar invert_d under the new semantics.
        let p = InversionParams {
            base: [0.8, 0.6, 0.4],
            print_exposure: 2f32.powf(-1.5),
            ..Default::default()
        };
        let pixels = vec![
            [0.8, 0.6, 0.4],
            [0.1, 0.2, 0.3],
            [0.5, 0.5, 0.5],
            [0.05, 0.9, 0.45],
        ];
        let img = Image {
            width: 2,
            height: 2,
            pixels: pixels.clone(),
            ir: None,
        };
        let out = invert_image(&img, &p, Mode::D);
        assert_eq!(out.width, 2);
        assert_eq!(out.height, 2);
        for (i, &px) in pixels.iter().enumerate() {
            let want = invert_d(px, &p);
            for (c, (&got, &exp)) in out.pixels[i].iter().zip(want.iter()).enumerate() {
                assert!((got - exp).abs() < 1e-5, "pixel {i} chan {c}");
            }
        }
    }

    #[test]
    fn mode_d_base_pixel_is_black() {
        // I == Dmin → log_dens 0 → ten_to_x 1 → print_lin = pe*(1+pb) - pe = pe*pb = 0.
        let p = InversionParams {
            base: [0.7, 0.6, 0.5],
            ..Default::default()
        };
        let out = invert_d([0.7, 0.6, 0.5], &p);
        for (c, &v) in out.iter().enumerate() {
            assert!(v.abs() < 1e-4, "ch {c} = {v}");
        }
    }

    #[test]
    fn mode_d_darker_negative_is_brighter_positive() {
        // A denser negative (lower transmission) = brighter scene = brighter positive.
        let p = InversionParams {
            base: [1.0, 1.0, 1.0],
            ..Default::default()
        };
        let dim = invert_d([0.5, 0.5, 0.5], &p);
        let bright = invert_d([0.1, 0.1, 0.1], &p);
        assert!(bright[0] > dim[0], "denser neg should be brighter: {bright:?} vs {dim:?}");
    }

    #[test]
    fn mode_d_recovers_neutrals_as_neutral() {
        // base*10^(-k*scene) for a neutral scene must invert back to neutral (wb=1).
        let base = [0.8, 0.55, 0.35];
        let k = 0.6;
        let p = InversionParams { base, ..Default::default() };
        for g in [0.2f32, 0.5, 0.8] {
            let neg = [
                base[0] * 10f32.powf(-k * g),
                base[1] * 10f32.powf(-k * g),
                base[2] * 10f32.powf(-k * g),
            ];
            let out = invert_d(neg, &p);
            let max = out.iter().cloned().fold(f32::MIN, f32::max);
            let min = out.iter().cloned().fold(f32::MAX, f32::min);
            assert!(max - min < 1e-3, "non-neutral recovery at g={g}: {out:?}");
        }
    }

    #[test]
    fn mode_d_wb_gain_brightens_channel() {
        // wb[c] > 1 must BRIGHTEN channel c in the positive (matches B/C convention),
        // even though WB is injected as a log-space offset on the negative side.
        let base = [0.7, 0.6, 0.5];
        let probe = [0.3, 0.25, 0.2];
        let neutral = InversionParams { base, ..Default::default() };
        let warmed = InversionParams { base, wb: [1.5, 1.0, 1.0], ..Default::default() };
        let a = invert_d(probe, &neutral);
        let b = invert_d(probe, &warmed);
        assert!(b[0] > a[0], "R wb 1.5 should brighten R: {} vs {}", b[0], a[0]);
        assert!((b[1] - a[1]).abs() < 1e-6, "G unchanged");
    }

    #[test]
    fn mode_d_shadow_stays_neutral_under_wb() {
        // Regression for the yellow-shadow bug: a pixel AT the film base is the
        // deepest shadow → must invert to neutral BLACK for ANY white balance,
        // because WB is a gain on the positive print (0·wb = 0). With the old
        // log-space WB offset this same input produced print_lin = pe·(1 − 1/wb[c]),
        // i.e. a bright, strongly per-channel-tinted (yellow) result — not black.
        let base = [0.7, 0.6, 0.5];
        let warm = InversionParams {
            base,
            wb: [1.3, 1.0, 0.7],
            ..Default::default()
        };
        let out = invert_d(base, &warm);
        let max = out.iter().cloned().fold(f32::MIN, f32::max);
        let min = out.iter().cloned().fold(f32::MAX, f32::min);
        assert!(max < 1e-4, "shadow at base should be ~black: {out:?}");
        assert!(max - min < 1e-4, "shadow not neutral under WB: {out:?}");
    }

    #[test]
    fn invert_d_hdr_false_matches_today() {
        let p = InversionParams { base: [0.7, 0.6, 0.5], ..Default::default() };
        let phdr = InversionParams { hdr: false, ..p.clone() };
        for probe in [[0.05f32, 0.04, 0.03], [0.3, 0.25, 0.2], [0.69, 0.59, 0.49]] {
            assert_eq!(invert_d(probe, &p), invert_d(probe, &phdr), "hdr=false must equal default");
        }
    }

    #[test]
    fn invert_d_hdr_expands_highlights_above_knee() {
        let base = [0.7, 0.6, 0.5];
        let bright_neg = [0.7e-3, 0.6e-3, 0.5e-3]; // dense neg → bright positive
        let sdr = invert_d(bright_neg, &InversionParams { base, hdr: false, ..Default::default() });
        let hdr = invert_d(bright_neg, &InversionParams { base, hdr: true, ..Default::default() });
        assert!(sdr[0] <= 1.0001, "SDR highlight caps ~1.0: {}", sdr[0]);
        assert!(hdr[0] > 1.05, "HDR highlight exceeds 1.0: {}", hdr[0]);
        assert!(hdr[0] <= 2.5001, "HDR highlight capped at headroom: {}", hdr[0]);
    }

    #[test]
    fn highlight_rolloff_retains_separation() {
        // Raise exposure (print_exposure 2.0): eff_d_max shrinks, so highlights move
        // toward white but the SDR rolloff still keeps them *below* white with a
        // visible gap between distinct luminances — latitude survives into Develop.
        let p = InversionParams { print_exposure: 2.0, ..Default::default() };
        let bright = invert_d([0.1, 0.1, 0.1], &p)[0]; // denser neg → brighter pos
        let dim = invert_d([0.3, 0.3, 0.3], &p)[0];
        assert!(bright > dim, "monotonic: {bright} vs {dim}");
        assert!(bright < 0.995, "brightest highlight keeps headroom: {bright}");
        assert!(bright - dim > 0.01, "highlight separation retained: {}", bright - dim);
        assert!(bright <= 1.0001, "still capped at white: {bright}");
    }

    #[test]
    fn highlight_rolloff_unchanged_below_knee() {
        // Nothing at or below the knee may shift — the look up to soft_clip is
        // identical; only the above-knee tail is gentler.
        let p = InversionParams::default();
        let mid = invert_d([0.5, 0.5, 0.5], &p);
        for c in 0..3 {
            assert!(mid[c] <= 0.9 + 1e-4, "mid below knee: {}", mid[c]);
        }
    }

    #[test]
    fn invert_d_hdr_below_knee_unchanged() {
        let base = [0.7, 0.6, 0.5];
        let mid = [0.35f32, 0.30, 0.25];
        let sdr = invert_d(mid, &InversionParams { base, hdr: false, ..Default::default() });
        let hdr = invert_d(mid, &InversionParams { base, hdr: true, ..Default::default() });
        if sdr[0] < 0.8 {
            assert!((sdr[0] - hdr[0]).abs() < 1e-5, "below-knee differs: {} vs {}", sdr[0], hdr[0]);
        }
    }

    #[test]
    fn invert_image_preserves_ir_plane() {
        let mut img = Image::new(2, 1);
        img.ir = Some(vec![0.5, 0.25]);
        let p = InversionParams::default();
        let out = invert_image(&img, &p, Mode::D);
        assert_eq!(out.ir, Some(vec![0.5, 0.25]));
        assert_eq!(out.width, 2);
        assert_eq!(out.height, 1);
    }

    #[test]
    fn positive_passthrough_neutral_is_display_encode() {
        // positive + neutral params (exposure 1, wb 1) must match the raw-scan
        // display encode pow(rgb, 1/2.2) — no inversion, no tint.
        let p = InversionParams { positive: true, ..Default::default() };
        for probe in [[0.04f32, 0.04, 0.04], [0.2, 0.3, 0.5], [0.9, 0.9, 0.9]] {
            let out = invert_d(probe, &p);
            for c in 0..3 {
                let want = probe[c].powf(1.0 / 2.2);
                assert!((out[c] - want).abs() < 1e-5, "ch {c}: {} vs {}", out[c], want);
            }
        }
    }

    #[test]
    fn positive_exposure_brightens() {
        let base = InversionParams { positive: true, ..Default::default() };
        let up = InversionParams { positive: true, print_exposure: 2.0, ..Default::default() };
        let a = invert_d([0.25, 0.25, 0.25], &base);
        let b = invert_d([0.25, 0.25, 0.25], &up);
        assert!(b[0] > a[0], "2x exposure should brighten: {} vs {}", b[0], a[0]);
    }

    #[test]
    fn positive_wb_gains_one_channel() {
        let neutral = InversionParams { positive: true, ..Default::default() };
        let warm = InversionParams { positive: true, wb: [1.5, 1.0, 1.0], ..Default::default() };
        let a = invert_d([0.3, 0.3, 0.3], &neutral);
        let b = invert_d([0.3, 0.3, 0.3], &warm);
        assert!(b[0] > a[0], "R gain should brighten R: {} vs {}", b[0], a[0]);
        assert!((b[1] - a[1]).abs() < 1e-6, "G unchanged");
    }

    #[test]
    fn positive_false_matches_today() {
        // Regression: the default (negative) path is byte-for-byte unchanged.
        let p = InversionParams { base: [0.7, 0.6, 0.5], ..Default::default() };
        assert!(!p.positive, "default must be negative");
        let probe = [0.3, 0.25, 0.2];
        let neg = invert_d(probe, &p);
        let p2 = InversionParams { positive: false, ..p.clone() };
        assert_eq!(neg, invert_d(probe, &p2));
    }

    #[test]
    fn lower_exposure_reseparates_blown_highlights() {
        // Heavily over-exposed Pro400H-style: two close, very dense (bright-scene)
        // probes the default render collapses near white. Lowering exposure must
        // pull them DOWN off white AND widen the gap between them (re-separate),
        // not merely dim a collapsed cluster (the old linear-gain "brightness" feel).
        let base = [1.0, 1.0, 1.0];
        let hi_a = [3.2e-3, 3.2e-3, 3.2e-3];
        let hi_b = [5.0e-3, 5.0e-3, 5.0e-3];
        let at = |ev: f32, neg: [f32; 3]| {
            let p = InversionParams {
                base, d_max: 1.5, print_exposure: 2f32.powf(ev), ..Default::default()
            };
            invert_d(neg, &p)[0]
        };
        let gap0 = (at(0.0, hi_a) - at(0.0, hi_b)).abs();
        let gap_dn = (at(-2.0, hi_a) - at(-2.0, hi_b)).abs();
        eprintln!(
            "OVER-EXPOSED HIGHLIGHT before/after: gap@EV0={gap0:.4} gap@EV-2={gap_dn:.4}  \
             a:{:.4}->{:.4}  b:{:.4}->{:.4}",
            at(0.0, hi_a), at(-2.0, hi_a), at(0.0, hi_b), at(-2.0, hi_b)
        );
        assert!(at(-2.0, hi_a) < at(0.0, hi_a), "lower EV must darken the highlight");
        assert!(gap_dn > gap0 * 2.0, "separation must widen: {gap0} -> {gap_dn}");
    }

    #[test]
    fn black_anchored_under_any_exposure() {
        // A pixel AT the film base is the deepest shadow → must invert to ~black for
        // ANY exposure, because eff_d_max only changes the slope about the black pivot.
        let base = [0.7, 0.6, 0.5];
        for ev in [-3.0f32, 0.0, 3.0] {
            let p = InversionParams { base, print_exposure: 2f32.powf(ev), ..Default::default() };
            let out = invert_d(base, &p);
            for &v in &out { assert!(v.abs() < 1e-4, "base must be black at EV {ev}: {out:?}"); }
        }
    }

    #[test]
    fn eff_dmax_clamped_no_blowup() {
        // Extreme exposure is bounded by the clamp band — finite, in-range, no NaN.
        let base = [1.0, 1.0, 1.0];
        for ev in [-20.0f32, 20.0] {
            let p = InversionParams { base, print_exposure: 2f32.powf(ev), ..Default::default() };
            let out = invert_d([0.01, 0.01, 0.01], &p);
            for &v in &out { assert!(v.is_finite() && (0.0..=1.0001).contains(&v), "EV {ev}: {v}"); }
        }
    }
}
