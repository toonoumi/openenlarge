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
}
