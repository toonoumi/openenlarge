//! HDR gain-map JPEG encoding.
//!
//! Wraps Google's libultrahdr (via the `ultrahdr` crate) to bake an SDR base
//! image plus an HDR rendition into a single ISO 21496-1 / Apple gain-map JPEG.
//! The rest of the HDR export feature depends only on [`encode_gain_map_jpeg`].

use half::f16;
use ultrahdr::{
    ColorGamut, ColorRange, ColorTransfer, Encoder, ImgFormat, ImgLabel, OwnedPackedImage,
};

/// Encode an HDR gain-map JPEG from an SDR base + an HDR rendition (same dims).
/// `sdr`/`hdr` are linear-RGB Images (f32; sdr ~0..1, hdr 0..~headroom).
/// Returns JPEG bytes containing an ISO 21496-1 / Apple gain map.
pub fn encode_gain_map_jpeg(
    sdr: &film_core::Image,
    hdr: &film_core::Image,
    quality: u8,
) -> Result<Vec<u8>, String> {
    if sdr.width == 0 || sdr.height == 0 {
        return Err("sdr image has zero dimension".into());
    }
    if sdr.width != hdr.width || sdr.height != hdr.height {
        return Err(format!(
            "sdr/hdr dimension mismatch: {}x{} vs {}x{}",
            sdr.width, sdr.height, hdr.width, hdr.height
        ));
    }
    let expected = sdr.width * sdr.height;
    if sdr.pixels.len() < expected || hdr.pixels.len() < expected {
        return Err("pixel buffer shorter than width*height".into());
    }

    let w = sdr.width as u32;
    let h = sdr.height as u32;

    // SDR base: 8-bit sRGB-encoded RGBA, full-range, BT.709 (sRGB) primaries.
    let mut sdr_img = OwnedPackedImage::new(
        ImgFormat::UHDR_IMG_FMT_32bppRGBA8888,
        w,
        h,
        ColorGamut::UHDR_CG_BT_709,
        ColorTransfer::UHDR_CT_SRGB,
        ColorRange::UHDR_CR_FULL_RANGE,
    )
    .map_err(|e| format!("alloc sdr image: {e:?}"))?;
    {
        let buf = sdr_img.buffer();
        for (i, px) in sdr.pixels.iter().take(expected).enumerate() {
            let o = i * 4;
            buf[o] = linear_to_srgb_u8(px[0]);
            buf[o + 1] = linear_to_srgb_u8(px[1]);
            buf[o + 2] = linear_to_srgb_u8(px[2]);
            buf[o + 3] = 255;
        }
    }

    // HDR rendition: 64bpp half-float linear RGBA, full-range, BT.709 primaries.
    let mut hdr_img = OwnedPackedImage::new(
        ImgFormat::UHDR_IMG_FMT_64bppRGBAHalfFloat,
        w,
        h,
        ColorGamut::UHDR_CG_BT_709,
        ColorTransfer::UHDR_CT_LINEAR,
        ColorRange::UHDR_CR_FULL_RANGE,
    )
    .map_err(|e| format!("alloc hdr image: {e:?}"))?;
    {
        let buf = hdr_img.buffer();
        for (i, px) in hdr.pixels.iter().take(expected).enumerate() {
            let o = i * 8; // 4 channels * 2 bytes
            write_f16(&mut buf[o..o + 2], px[0]);
            write_f16(&mut buf[o + 2..o + 4], px[1]);
            write_f16(&mut buf[o + 4..o + 6], px[2]);
            write_f16(&mut buf[o + 6..o + 8], 1.0);
        }
    }

    let mut enc = Encoder::new().map_err(|e| format!("create encoder: {e:?}"))?;
    let q = quality.min(100) as i32;
    enc.set_raw_owned_image(&mut sdr_img, ImgLabel::UHDR_SDR_IMG)
        .map_err(|e| format!("set sdr image: {e:?}"))?;
    enc.set_raw_owned_image(&mut hdr_img, ImgLabel::UHDR_HDR_IMG)
        .map_err(|e| format!("set hdr image: {e:?}"))?;
    enc.set_quality(q, ImgLabel::UHDR_BASE_IMG)
        .map_err(|e| format!("set base quality: {e:?}"))?;
    enc.encode().map_err(|e| format!("encode: {e:?}"))?;

    let stream = enc
        .encoded_stream()
        .ok_or_else(|| "encoder produced no stream".to_string())?;
    let bytes = stream.bytes().map_err(|e| format!("read stream: {e:?}"))?;
    Ok(bytes.to_vec())
}

/// Encode a linear [0,1] component to an 8-bit sRGB value.
fn linear_to_srgb_u8(linear: f32) -> u8 {
    let c = linear.clamp(0.0, 1.0);
    let s = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

/// Write a single f32 as little-endian IEEE half-float into a 2-byte slice.
fn write_f16(dst: &mut [u8], v: f32) {
    let bits = f16::from_f32(v.max(0.0)).to_bits().to_le_bytes();
    dst[0] = bits[0];
    dst[1] = bits[1];
}

#[cfg(test)]
mod tests {
    use super::*;
    use film_core::Image;
    fn solid(w: usize, h: usize, c: [f32; 3]) -> Image {
        Image { width: w, height: h, pixels: vec![c; w * h], ir: None }
    }
    #[test]
    fn encode_gain_map_jpeg_emits_a_gain_map() {
        let sdr = solid(64, 64, [0.9, 0.9, 0.9]);
        let hdr = solid(64, 64, [1.8, 1.8, 1.8]);
        let bytes = encode_gain_map_jpeg(&sdr, &hdr, 90).expect("encode");
        assert!(bytes.len() > 1000, "got {} bytes", bytes.len());
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "not a JPEG (SOI)");
        let iso = b"urn:iso";
        let apple = b"hdrgainmap";
        let has = bytes.windows(iso.len()).any(|w| w == iso)
            || bytes.windows(apple.len()).any(|w| w == apple);
        assert!(has, "no gain-map metadata in output");
    }
}
