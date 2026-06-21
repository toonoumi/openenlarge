//! Pure tone math for the tone-calibration harness: the engine's neutral display
//! transfer (filmic S-curve or a gamma alternative), density→L*, and (later)
//! transfer metrics + fit. This REPLICATES the engine's neutral (wb=[1,1,1])
//! Gain-mode tone path so the fit can run on sampled patches without re-inverting
//! a full frame; it does not change the engine.

use crate::color::srgbf_to_lab;

/// Exposure sensitivity, mirrored from `engine.rs`.
pub const EXPO_K: f32 = 0.14;

/// Display transfer applied to normalized log-density `t` (>= 0) → display [0,1].
#[derive(Clone, Copy, Debug)]
pub enum Transfer {
    /// The engine's logistic filmic S-curve (default k=5.0, pivot=0.44, white_t=1.05).
    Filmic { k: f32, pivot: f32, white_t: f32 },
    /// A plain gamma alternative (no S-curve): `t.clamp(0,1)^(1/gamma)`.
    Gamma { gamma: f32 },
}

impl Transfer {
    pub fn default_filmic() -> Transfer {
        Transfer::Filmic { k: 5.0, pivot: 0.44, white_t: 1.05 }
    }
}

/// Map normalized log-density `t` to a display value in [0,1].
pub fn apply_transfer(t: f32, tr: &Transfer) -> f32 {
    match *tr {
        Transfer::Filmic { k, pivot, white_t } => {
            let l = |x: f32| 1.0 / (1.0 + (-k * (x - pivot)).exp());
            let l0 = l(0.0);
            let lw = l(white_t);
            ((l(t) - l0) / (lw - l0)).clamp(0.0, 1.0)
        }
        Transfer::Gamma { gamma } => t.clamp(0.0, 1.0).powf(1.0 / gamma),
    }
}

/// Replicate the engine's neutral tone path and return CIE L* of the rendered patch.
///
/// Per channel: `d = log10(base/scan).max(0)`, `t = d * scale`, `out = apply_transfer(t)`.
/// `scale = 2^(EXPO_K·ev)/d_max` collapses the engine's d_max + exposure into one density
/// scale (valid for wb=[1,1,1] Gain mode). The 3-channel display output is converted to L*.
pub fn output_lstar(scan: [f32; 3], base: [f32; 3], scale: f32, tr: &Transfer) -> f32 {
    const THRESHOLD: f32 = 2.328_306_4e-10;
    const EPS: f32 = 1e-5;
    let out: [f32; 3] = std::array::from_fn(|c| {
        let s = scan[c].max(THRESHOLD);
        let dmin = base[c].max(EPS);
        let d = (dmin / s).log10().max(0.0);
        apply_transfer(d * scale, tr)
    });
    srgbf_to_lab(out)[0]
}

/// Confidence weight for a patch at absolute scene EV. The C400/Ektar density onset is
/// ~−5 EV; below it the negative holds little real information (the reference tags those
/// patches with >0.3 EV error), so weight ramps from 1.0 at/above −5 EV down to ~0.05 by
/// −9 EV. This keeps deep-shadow noise from dominating the metrics/fit.
pub fn ev_weight(abs_ev: f32) -> f32 {
    let (lo, hi) = (-9.0f32, -5.0f32);
    let x = ((abs_ev - lo) / (hi - lo)).clamp(0.0, 1.0);
    let s = x * x * (3.0 - 2.0 * x); // smoothstep
    0.05 + 0.95 * s
}

/// One stitched wedge sample: the raw negative patch, its frame's base, the digital-SDR
/// target L*, the confidence weight, and the absolute scene EV (for reporting).
pub struct TonePoint {
    pub scan: [f32; 3],
    pub base: [f32; 3],
    pub target_l: f32,
    pub weight: f32,
    pub abs_ev: f32,
}

pub struct ToneMetrics {
    /// Confidence-weighted RMS of (our L* − target L*).
    pub rms_dl: f32,
    pub max_dl: f32,
    /// Fraction of (unweighted) patches within ΔL* < 5 of target.
    pub frac_within5: f32,
    /// Is our rendered L* monotone non-decreasing with scene EV (points pre-sorted by EV)?
    pub monotonic: bool,
}

/// Deviation of our rendered transfer (at `scale`, `tr`) from the digital-SDR target.
pub fn transfer_metrics(points: &[TonePoint], scale: f32, tr: &Transfer) -> ToneMetrics {
    let mut sw = 0.0f32;
    let mut swe2 = 0.0f32;
    let mut max_dl = 0.0f32;
    let mut within = 0usize;
    // Sort by EV for the monotonicity check without mutating the caller's slice.
    let mut idx: Vec<usize> = (0..points.len()).collect();
    idx.sort_by(|&a, &b| points[a].abs_ev.partial_cmp(&points[b].abs_ev).unwrap());
    let mut prev_l = f32::NEG_INFINITY;
    let mut monotonic = true;
    for &i in &idx {
        let p = &points[i];
        let our = output_lstar(p.scan, p.base, scale, tr);
        let dl = our - p.target_l;
        sw += p.weight;
        swe2 += p.weight * dl * dl;
        max_dl = max_dl.max(dl.abs());
        if dl.abs() < 5.0 {
            within += 1;
        }
        if our < prev_l - 1.0 {
            monotonic = false;
        }
        prev_l = our;
    }
    ToneMetrics {
        rms_dl: (swe2 / sw.max(1e-6)).sqrt(),
        max_dl,
        frac_within5: within as f32 / points.len().max(1) as f32,
        monotonic,
    }
}

#[derive(Clone, Copy, Debug)]
pub enum FitMode {
    /// Fit only the density scale (≡ d_max/exposure), keep the default filmic curve.
    ScaleOnly,
    /// Fit the density scale AND the filmic curve constants (k, pivot, white_t).
    ScaleCurve,
    /// Replace the filmic curve with a plain gamma; fit the scale + gamma (the
    /// "no S-curve" alternative, to settle filmic-vs-gamma).
    Gamma,
}

pub struct FitResult {
    pub scale: f32,
    pub transfer: Transfer,
    pub residual_rms: f32,
}

fn weighted_rms(points: &[TonePoint], scale: f32, tr: &Transfer) -> f32 {
    let mut sw = 0.0f32;
    let mut swe2 = 0.0f32;
    for p in points {
        let dl = output_lstar(p.scan, p.base, scale, tr) - p.target_l;
        sw += p.weight;
        swe2 += p.weight * dl * dl;
    }
    (swe2 / sw.max(1e-6)).sqrt()
}

/// Greedy coordinate descent over the active parameters for the mode.
/// Parameter vector: [scale, a, b, c] where (a,b,c) = (k,pivot,white_t) for Filmic
/// or (gamma, _, _) for Gamma. Inactive params stay at their seed.
pub fn fit_tone(points: &[TonePoint], mode: FitMode) -> FitResult {
    // Seed + which params are active + how to build a Transfer from the vector.
    let (mut p, active): ([f32; 4], [bool; 4]) = match mode {
        FitMode::ScaleOnly => ([1.0 / 1.5, 5.0, 0.44, 1.05], [true, false, false, false]),
        FitMode::ScaleCurve => ([1.0 / 1.5, 5.0, 0.44, 1.05], [true, true, true, true]),
        FitMode::Gamma => ([1.0 / 1.5, 2.2, 0.0, 0.0], [true, true, false, false]),
    };
    let build = |p: &[f32; 4]| -> Transfer {
        match mode {
            FitMode::Gamma => Transfer::Gamma { gamma: p[1].max(0.2) },
            _ => Transfer::Filmic { k: p[1].max(0.5), pivot: p[2], white_t: p[3].max(0.2) },
        }
    };
    let cost = |p: &[f32; 4]| weighted_rms(points, p[0].max(1e-3), &build(p));

    let mut steps = [0.20f32, 0.6, 0.04, 0.06]; // per-param initial step
    let mut best = cost(&p);
    for _ in 0..2000 {
        let mut improved = false;
        for j in 0..4 {
            if !active[j] {
                continue;
            }
            for dir in [steps[j], -steps[j]] {
                let mut cand = p;
                cand[j] += dir;
                let c = cost(&cand);
                if c < best {
                    best = c;
                    p = cand;
                    improved = true;
                }
            }
        }
        if !improved {
            for s in steps.iter_mut() {
                *s *= 0.5;
            }
            if steps[0] < 1e-4 {
                break;
            }
        }
    }
    FitResult { scale: p[0].max(1e-3), transfer: build(&p), residual_rms: best }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filmic_matches_engine_anchors() {
        let f = Transfer::default_filmic();
        // filmic_s(0) == 0 and filmic_s(WHITE_T=1.05) == 1 by construction.
        assert!(apply_transfer(0.0, &f).abs() < 1e-6, "t=0 -> 0");
        assert!((apply_transfer(1.05, &f) - 1.0).abs() < 1e-6, "t=WHITE_T -> 1");
        // Monotonic increasing across the range.
        let mut prev = -1.0;
        for i in 0..=20 {
            let v = apply_transfer(i as f32 / 20.0 * 1.05, &f);
            assert!(v >= prev - 1e-6, "monotonic at {i}: {v} < {prev}");
            prev = v;
        }
    }

    #[test]
    fn gamma_transfer_basic() {
        let g = Transfer::Gamma { gamma: 1.8 };
        assert!(apply_transfer(0.0, &g).abs() < 1e-6);
        assert!((apply_transfer(1.0, &g) - 1.0).abs() < 1e-6);
        // gamma>1 lifts midtones: 0.5^(1/1.8) > 0.5
        assert!(apply_transfer(0.5, &g) > 0.5);
    }

    #[test]
    fn output_lstar_brighter_scene_higher_l() {
        // base orange-ish; a denser negative (smaller scan) = brighter scene = higher L*.
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::default_filmic();
        let dense = output_lstar([0.05, 0.06, 0.03], base, 1.0 / 1.5, &tr); // bright scene
        let thin = output_lstar([0.40, 0.52, 0.24], base, 1.0 / 1.5, &tr);  // dark scene
        assert!(dense > thin, "dense neg should render brighter: {dense} vs {thin}");
        assert!((0.0..=100.0).contains(&dense) && (0.0..=100.0).contains(&thin));
    }

    #[test]
    fn ev_weight_downweights_deep_shadows() {
        assert!((ev_weight(0.0) - 1.0).abs() < 1e-6, "bright = full weight");
        assert!((ev_weight(-4.0) - 1.0).abs() < 1e-6, "above onset = full weight");
        assert!(ev_weight(-9.0) < 0.1, "deep shadow = low weight");
        assert!(ev_weight(-7.0) < ev_weight(-5.0), "monotone down into shadows");
    }

    #[test]
    fn metrics_zero_error_when_target_equals_output() {
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::default_filmic();
        let scale = 1.0 / 1.2;
        // Build points whose target_l IS our output at this scale → zero deviation.
        let scans = [[0.06, 0.07, 0.035], [0.15, 0.18, 0.09], [0.35, 0.45, 0.22]];
        let pts: Vec<TonePoint> = scans
            .iter()
            .enumerate()
            .map(|(i, &scan)| TonePoint {
                scan,
                base,
                target_l: output_lstar(scan, base, scale, &tr),
                weight: 1.0,
                abs_ev: -(i as f32),
            })
            .collect();
        let m = transfer_metrics(&pts, scale, &tr);
        assert!(m.rms_dl < 1e-4, "rms should be ~0, got {}", m.rms_dl);
        assert!(m.max_dl < 1e-4);
        assert!((m.frac_within5 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn fit_recovers_known_scale() {
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::default_filmic();
        let true_scale = 1.0 / 0.9; // the scale we'll hide in the targets
        // Spread of negative patches across the range.
        let scans = [
            [0.05, 0.06, 0.03], [0.10, 0.12, 0.06], [0.18, 0.22, 0.11],
            [0.26, 0.33, 0.16], [0.34, 0.44, 0.21], [0.40, 0.52, 0.25],
        ];
        let pts: Vec<TonePoint> = scans
            .iter()
            .enumerate()
            .map(|(i, &scan)| TonePoint {
                scan,
                base,
                target_l: output_lstar(scan, base, true_scale, &tr),
                weight: 1.0,
                abs_ev: -(i as f32),
            })
            .collect();
        let fit = fit_tone(&pts, FitMode::ScaleOnly);
        assert!(fit.residual_rms < 0.2, "should fit near-exactly: {}", fit.residual_rms);
        assert!((fit.scale - true_scale).abs() < 0.05, "recover scale: {} vs {true_scale}", fit.scale);
    }
}
