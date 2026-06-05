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

#[cfg(test)]
mod tests {
    use super::*;
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
}
