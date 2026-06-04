//! Density-domain negative inversion.
//!
//! Mode B (density matrix):  Ĉ = M_post · log10(M_pre · (base / I))  then tone.
//! Mode C (naive per-chan):  per-channel log-density, no matrices.
//! Mode "naive flip":        1 - normalized, the strawman baseline.

use nalgebra::{Matrix3, Vector3};

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
        }
    }
}

const EPS: f32 = 1e-5;

/// Naive baseline: normalize against base, then invert by `1 - x`. No log, no
/// matrices. This is the strawman the density engine must beat.
pub fn invert_naive(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let norm = (rgb[c] / p.base[c].max(EPS)).clamp(0.0, 1.0);
        out[c] = 1.0 - norm;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_inverts_white_base_to_black() {
        let p = InversionParams { base: [0.8, 0.6, 0.4], ..Default::default() };
        let out = invert_naive([0.8, 0.6, 0.4], &p);
        for c in 0..3 {
            assert!(out[c].abs() < 1e-4, "channel {c} = {}", out[c]);
        }
    }

    #[test]
    fn naive_inverts_dark_pixel_to_bright() {
        let p = InversionParams { base: [0.8, 0.8, 0.8], ..Default::default() };
        let out = invert_naive([0.0, 0.0, 0.0], &p);
        for c in 0..3 {
            assert!((out[c] - 1.0).abs() < 1e-4, "channel {c} = {}", out[c]);
        }
    }
}
