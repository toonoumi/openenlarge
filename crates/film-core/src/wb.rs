//! Correlated-colour-temperature ↔ per-channel white-balance gains.
//!
//! `wb_from_kelvin` uses the Tanner-Helland blackbody approximation to get an
//! RGB white point, then returns gains that neutralise it — normalised so the
//! reference (NEUTRAL_K, tint 0) yields ≈ [1,1,1]. `tint` shifts green↔magenta.

/// White point that maps to neutral [1,1,1] gains.
pub const NEUTRAL_K: f32 = 5500.0;

/// Tanner-Helland blackbody RGB (each channel 0..1) for a temperature in Kelvin.
#[allow(clippy::excessive_precision)]
fn blackbody_rgb(temp_k: f32) -> [f32; 3] {
    let t = (temp_k / 100.0).clamp(10.0, 400.0);
    let r = if t <= 66.0 {
        1.0
    } else {
        (329.698727446 * (t - 60.0).powf(-0.1332047592) / 255.0).clamp(0.0, 1.0)
    };
    let g = if t <= 66.0 {
        ((99.4708025861 * t.ln() - 161.1195681661) / 255.0).clamp(0.0, 1.0)
    } else {
        (288.1221695283 * (t - 60.0).powf(-0.0755148492) / 255.0).clamp(0.0, 1.0)
    };
    let b = if t >= 66.0 {
        1.0
    } else if t <= 19.0 {
        0.0
    } else {
        ((138.5177312231 * (t - 10.0).ln() - 305.0447927307) / 255.0).clamp(0.0, 1.0)
    };
    [r.max(1e-4), g.max(1e-4), b.max(1e-4)]
}

/// Per-channel gains for a target white balance. Lower K → warmer scene → boost
/// blue/cut red on output (gains neutralise the warm cast), normalised to neutral
/// at NEUTRAL_K. `tint` (−1..1-ish, UI −150..150 / 150) shifts green vs magenta.
pub fn wb_from_kelvin(temp_k: f32, tint: f32) -> [f32; 3] {
    let cur = blackbody_rgb(temp_k);
    let neu = blackbody_rgb(NEUTRAL_K);
    // Gain neutralises the current white point relative to neutral.
    let mut g = [neu[0] / cur[0], neu[1] / cur[1], neu[2] / cur[2]];
    // Tint: + → magenta (cut green), − → green (boost green). 0.5 caps full-range tint at ±50% green shift.
    g[1] *= 1.0 - 0.5 * tint;
    // Normalise so green gain stays 1 (keeps overall exposure stable).
    let gn = g[1].max(1e-4);
    [g[0] / gn, 1.0, g[2] / gn]
}

/// Lower/upper bound of the CCT search — covers all realistic film-scan
/// illuminants. Manual gains outside this range saturate at the bound.
const CCT_LO: f32 = 2000.0;
const CCT_HI: f32 = 15000.0;

/// Estimate (temp_k, tint) from a set of WB gains (inverse of wb_from_kelvin).
///
/// The red/blue gain ratio of `wb_from_kelvin(k, 0)` is **strictly increasing**
/// in `k` across `[CCT_LO, CCT_HI]`, so we recover `k` by bisecting that ratio
/// rather than scanning a coarse grid. Bisection is continuous and monotone: a
/// tiny change in the input gains moves the estimate by a tiny, proportional
/// amount instead of snapping it to the nearest 50 K bin — which is what made
/// auto-WB flip between neighbouring temperatures on shallow minima (B4). It is
/// also fully deterministic (no randomness, fixed iteration count), so re-running
/// on the same image always returns the same temperature.
///
/// Tint comes from the residual green deviation. Intended for auto-WB seeding;
/// gains beyond the bounds clamp to `CCT_LO`/`CCT_HI`.
pub fn gains_to_cct(gains: [f32; 3]) -> (f32, f32) {
    let target = (gains[0] / gains[2].max(1e-4)).max(1e-4).ln();
    let rb_ln = |k: f32| {
        let g = wb_from_kelvin(k, 0.0);
        (g[0] / g[2].max(1e-4)).max(1e-4).ln()
    };
    // Clamp targets outside the monotone bracket to the corresponding bound.
    let best_k = if target <= rb_ln(CCT_LO) {
        CCT_LO
    } else if target >= rb_ln(CCT_HI) {
        CCT_HI
    } else {
        let (mut lo, mut hi) = (CCT_LO, CCT_HI);
        // ~40 halvings of a 13000 K bracket → sub-Kelvin precision.
        for _ in 0..40 {
            let mid = 0.5 * (lo + hi);
            if rb_ln(mid) < target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        0.5 * (lo + hi)
    };
    // Residual green vs the neutral-tint model at best_k → tint.
    let model = wb_from_kelvin(best_k, 0.0);
    let resid = gains[1] / model[1].max(1e-4); // >1 means more green applied → green tint (−)
    let tint = ((1.0 - resid) / 0.5).clamp(-1.0, 1.0);
    (best_k, tint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_is_unity() {
        let g = wb_from_kelvin(NEUTRAL_K, 0.0);
        for (c, &gc) in g.iter().enumerate() {
            assert!((gc - 1.0).abs() < 0.05, "c{c}={gc}");
        }
    }

    #[test]
    fn warm_scene_cuts_red_boosts_blue() {
        let g = wb_from_kelvin(3000.0, 0.0);
        assert!(g[0] < 1.0, "r {}", g[0]);
        assert!(g[2] > 1.0, "b {}", g[2]);
    }

    #[test]
    fn cool_scene_boosts_red_cuts_blue() {
        let g = wb_from_kelvin(9000.0, 0.0);
        assert!(g[0] > 1.0, "r {}", g[0]);
        assert!(g[2] < 1.0, "b {}", g[2]);
    }

    #[test]
    fn cct_roundtrips() {
        for k in [3200.0_f32, 4500.0, 5500.0, 6500.0, 8000.0] {
            let g = wb_from_kelvin(k, 0.0);
            let (est, tint) = gains_to_cct(g);
            assert!((est - k).abs() < 400.0, "k={k} est={est}");
            assert!(tint.abs() < 0.1, "k={k} tint={tint}");
        }
    }

    #[test]
    fn cct_is_continuous_not_quantized() {
        // A true temperature falling between the old 50 K grid points must be
        // recovered precisely, not snapped to the nearest bin. A coarse grid can
        // only land within ±25 K; a continuous solve lands within a few K.
        for k in [5523.0_f32, 6137.0, 7841.0, 4310.0] {
            let g = wb_from_kelvin(k, 0.0);
            let (est, _) = gains_to_cct(g);
            assert!((est - k).abs() < 5.0, "k={k} est={est}");
        }
    }

    #[test]
    fn cct_small_input_change_small_output_change() {
        // Sweeping the true temperature in 20 K steps must move the estimate in
        // similarly small, monotone steps — no staircase jumps that would flip a
        // re-run between neighbouring temperatures on a tiny content change. The
        // old 50 K grid staircased (≥50 K steps); the continuous solve tracks the
        // 20 K input step. The Tanner-Helland model has one irreducible ~91 K
        // dead-zone near 6600 K (red channel clamps to 1.0, so r/b is constant
        // there and K is genuinely unrecoverable from it) — skipped here.
        let mut prev = gains_to_cct(wb_from_kelvin(3000.0, 0.0)).0;
        let mut k = 3020.0_f32;
        while k <= 12000.0 {
            let est = gains_to_cct(wb_from_kelvin(k, 0.0)).0;
            if !(6500.0..=6750.0).contains(&k) {
                let step = est - prev;
                assert!(step >= -0.5, "non-monotone at {k}: {prev}->{est}");
                assert!(step < 40.0, "jump at {k}: {prev}->{est} (step {step})");
            }
            prev = est;
            k += 20.0;
        }
    }

    #[test]
    fn cct_small_gain_perturbation_small_temp_change() {
        // A crop/content nudge perturbs the estimated gains by a hair. The
        // recovered temperature must move proportionally and continuously, not
        // snap to a distant bin. We bound the shift in mireds (1e6/K), the
        // perceptually-uniform scale — a fixed r/b ratio change is a roughly
        // constant mired shift regardless of temperature (it only looks large in
        // Kelvin at high T). A 1% ratio nudge must stay well under 5 mired.
        let mired = |k: f32| 1.0e6 / k;
        for k in [3500.0_f32, 5000.0, 8000.0, 11000.0] {
            let g = wb_from_kelvin(k, 0.0);
            let base = gains_to_cct(g).0;
            for delta in [-0.01_f32, 0.01] {
                let perturbed = [g[0] * (1.0 + delta), g[1], g[2]];
                let est = gains_to_cct(perturbed).0;
                assert!(
                    (mired(est) - mired(base)).abs() < 5.0,
                    "1% gain nudge at {k}K swung temp {base}->{est} ({} mired)",
                    (mired(est) - mired(base)).abs()
                );
            }
        }
    }

    #[test]
    fn cct_deterministic_on_repeat() {
        // Same gains in → bit-identical estimate out, every time. This is the
        // floor for "same image → same temperature on repeated auto-WB".
        let g = wb_from_kelvin(6234.0, 0.04);
        assert_eq!(gains_to_cct(g), gains_to_cct(g));
    }
}
