//! Pack a linear-RGB working image into half-float RGBA bytes for a one-shot
//! WebGL2 `RGBA16F` texture upload, and resolve inversion params into a flat,
//! serialisable uniform set the GPU shader consumes.

use crate::convert::proxy;
use film_core::Image;
use half::f16;

/// Max GPU texture long-edge we will upload. WebGL2 guarantees at least 2048,
/// real GPUs >= 16384; 8192 is a safe, ample bound for the live proxy.
pub const MAX_GPU_EDGE: u32 = 8192;

/// Downscale (if needed) so the long edge <= `cap`, then pack the linear-RGB
/// pixels as little-endian half-float RGBA (alpha = 1.0). Returns the (possibly
/// reduced) dimensions and the byte buffer ready for `texImage2D(RGBA16F)`.
pub fn pack_rgba16f(img: &Image, cap: u32) -> (u32, u32, Vec<u8>) {
    let capped = proxy(img, cap); // no-op if already within cap
    let one = f16::from_f32(1.0).to_le_bytes();
    let mut bytes = Vec::with_capacity(capped.pixels.len() * 8);
    for px in &capped.pixels {
        bytes.extend_from_slice(&f16::from_f32(px[0]).to_le_bytes());
        bytes.extend_from_slice(&f16::from_f32(px[1]).to_le_bytes());
        bytes.extend_from_slice(&f16::from_f32(px[2]).to_le_bytes());
        bytes.extend_from_slice(&one);
    }
    (capped.width as u32, capped.height as u32, bytes)
}

use crate::commands::{build_params, mode_from, wb_from_params};
use crate::session::InvertParams;
use film_core::engine::Mode;
use serde::Serialize;

/// Flat, JS-friendly inversion uniforms. Matrices are column-major 9-vecs to
/// match GLSL `mat3` constructor/`uniformMatrix3fv` layout.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedInversion {
    pub base: [f32; 3],
    pub wb: [f32; 3],
    pub m_pre: [f32; 9],
    pub m_post: [f32; 9],
    pub exposure: f32,
    pub black: f32,
    pub gamma: f32,
    /// 0 = Mode B (density matrix), 1 = Mode C (per-channel), 2 = Naive.
    pub mode: u8,
}

/// Copy a nalgebra Matrix3 into a column-major `[f32; 9]`. nalgebra stores
/// column-major, so `as_slice()` is already in the layout `uniformMatrix3fv`
/// (transpose=false) expects.
fn mat3_col_major(s: &[f32]) -> [f32; 9] {
    [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]]
}

/// Resolve the UI params (+ sampled film base) into GPU uniforms, reusing the
/// exact same param construction the CPU path uses (build_params + wb).
pub fn resolve_to_uniforms(p: &InvertParams, base: [f32; 3]) -> ResolvedInversion {
    let mut ip = build_params(p, base);
    ip.wb = wb_from_params(p.temp, p.tint);
    let mode = match mode_from(&p.mode) {
        Mode::B => 0u8,
        Mode::C => 1,
        Mode::Naive => 2,
    };
    ResolvedInversion {
        base: ip.base,
        wb: ip.wb,
        m_pre: mat3_col_major(ip.m_pre.as_slice()),
        m_post: mat3_col_major(ip.m_post.as_slice()),
        exposure: ip.exposure,
        black: ip.black,
        gamma: ip.gamma,
        mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands_test_support::sample_invert_params;
    use film_core::Image;
    use half::f16;

    #[test]
    fn pack_rgba16f_one_pixel_round_trips_with_alpha_one() {
        let img = Image { width: 1, height: 1, pixels: vec![[0.25, 0.5, 0.75]], ir: None };
        let (w, h, bytes) = pack_rgba16f(&img, 8192);
        assert_eq!((w, h), (1, 1));
        assert_eq!(bytes.len(), 1 * 1 * 4 * 2, "RGBA, 2 bytes per channel");
        // Decode the 4 channels back from little-endian u16 half-floats.
        let chan = |i: usize| f16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]).to_f32();
        assert!((chan(0) - 0.25).abs() < 1e-3, "r");
        assert!((chan(1) - 0.50).abs() < 1e-3, "g");
        assert!((chan(2) - 0.75).abs() < 1e-3, "b");
        assert!((chan(3) - 1.0).abs() < 1e-3, "a defaults to 1.0");
    }

    #[test]
    fn pack_rgba16f_caps_long_edge() {
        // 10x4 image, cap 5 → downscaled so long edge <= 5, bytes match the capped dims.
        let img = Image { width: 10, height: 4, pixels: vec![[0.1, 0.2, 0.3]; 40], ir: None };
        let (w, h, bytes) = pack_rgba16f(&img, 5);
        assert!(w <= 5 && h <= 5, "long edge capped: {w}x{h}");
        assert_eq!(bytes.len(), (w * h * 4 * 2) as usize);
    }

    #[test]
    fn uniforms_none_stock_mode_c_is_identity_matrices_mode_1() {
        let mut p = sample_invert_params();
        p.stock = "none".into();
        p.mode = "c".into();
        p.exposure = 1.0; // 1 EV → 2.0x
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.mode, 1, "c → 1");
        assert_eq!(u.base, [0.8, 0.6, 0.4]);
        // identity m_pre/m_post (column-major 9-vec)
        assert_eq!(u.m_pre, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(u.m_post, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert!((u.exposure - 2.0).abs() < 1e-5, "2^1");
    }

    #[test]
    fn uniforms_portra_mode_b_fits_nonidentity_mpost_mode_0() {
        let mut p = sample_invert_params();
        p.stock = "portra400".into();
        p.mode = "b".into();
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.mode, 0, "b → 0");
        // m_post from fit_m_post is NOT identity for a real stock
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert_ne!(u.m_post, identity, "stock fit produces a real matrix");
    }
}
