//! Decode scan files into a linear-RGB Image.
//!
//! `decode_tiff` handles plain 8/16-bit RGB TIFF and scanner *linear* DNGs that
//! the `tiff` crate can read directly. `decode_raw` handles Bayer RAF/DNG via
//! rawler (demosaiced, linear light, no white-balance, no gamma).

use crate::Image;
use std::path::Path;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::ColorType;

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("tiff error: {0}")]
    Tiff(#[from] tiff::TiffError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported color type: {0:?}")]
    UnsupportedColor(ColorType),
    #[error("raw decode error: {0}")]
    Raw(String),
    #[error("image decode error: {0}")]
    Image(#[from] ::image::ImageError),
}

/// sRGB electro-optical transfer function: gamma-encoded sRGB → linear light.
/// Input and output are normalized to [0, 1].
#[inline]
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Decode an 8- or 16-bit RGB(A) TIFF / linear DNG into a normalized f32 Image.
/// A 4th (alpha/IR) channel, if present, is captured into `ir`.
pub fn decode_tiff(path: &Path) -> Result<Image, DecodeError> {
    let file = std::fs::File::open(path)?;
    let mut dec = Decoder::new(file)?;
    let (w, h) = dec.dimensions()?;
    let color = dec.colortype()?;
    let (channels, max) = match color {
        ColorType::RGB(8) => (3usize, 255.0f32),
        ColorType::RGB(16) => (3, 65535.0),
        ColorType::RGBA(8) => (4, 255.0),
        ColorType::RGBA(16) => (4, 65535.0),
        other => return Err(DecodeError::UnsupportedColor(other)),
    };
    let result = dec.read_image()?;
    let floats: Vec<f32> = match result {
        DecodingResult::U8(v) => v.into_iter().map(|x| x as f32 / max).collect(),
        DecodingResult::U16(v) => v.into_iter().map(|x| x as f32 / max).collect(),
        _ => return Err(DecodeError::UnsupportedColor(color)),
    };
    let n = (w as usize) * (h as usize);
    let mut pixels = Vec::with_capacity(n);
    let mut ir: Option<Vec<f32>> = if channels == 4 {
        Some(Vec::with_capacity(n))
    } else {
        None
    };
    for i in 0..n {
        let base = i * channels;
        pixels.push([floats[base], floats[base + 1], floats[base + 2]]);
        if let Some(ir) = ir.as_mut() {
            ir.push(floats[base + 3]);
        }
    }
    Ok(Image {
        width: w as usize,
        height: h as usize,
        pixels,
        ir,
    })
}

/// Rewrite TIFF `IFD` (type 13) entries to `LONG` (type 4) in an in-memory
/// TIFF/DNG buffer so rawler can follow the file's SubIFD pointers.
///
/// # Why this exists
/// Some DNG writers — notably **Capture One on Windows** — encode the `SubIFDs`
/// pointer (tag 330) using TIFF data type **13 (IFD)** rather than the far more
/// common type **4 (LONG)**. The two are byte-for-byte identical on the wire:
/// both are 32-bit unsigned offsets. But rawler 0.7's IFD parser only follows a
/// SubIFD pointer whose entry decodes to `Long`/`Unknown`/`Undefined`; a type-13
/// entry falls through to a 1-byte `Unknown`, so the 32-bit offset is truncated
/// to its low byte, the real (full-resolution, uncompressed) raw IFD is never
/// parsed, and decoding fails with the misleading `Unsupported DNG compression`
/// (the only IFD rawler then sees is the reduced-resolution preview).
///
/// Rewriting the 2-byte type field of every type-13 entry to type 4 fixes this
/// losslessly. It is a no-op for files that don't use type 13, and the leading
/// `II`/`MM` + magic-42 guard makes it a safe no-op for non-TIFF containers
/// (e.g. Fujifilm `.raf`, which is not a bare TIFF at offset 0).
fn normalize_ifd_pointer_types(buf: &mut [u8]) {
    #[inline]
    fn rd_u16(b: &[u8], o: usize, le: bool) -> u16 {
        let v = [b[o], b[o + 1]];
        if le {
            u16::from_le_bytes(v)
        } else {
            u16::from_be_bytes(v)
        }
    }
    #[inline]
    fn rd_u32(b: &[u8], o: usize, le: bool) -> u32 {
        let v = [b[o], b[o + 1], b[o + 2], b[o + 3]];
        if le {
            u32::from_le_bytes(v)
        } else {
            u32::from_be_bytes(v)
        }
    }

    if buf.len() < 8 {
        return;
    }
    let le = match &buf[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return, // not a classic TIFF container
    };
    if rd_u16(buf, 2, le) != 42 {
        return; // BigTIFF (43) or non-TIFF: different layout, leave untouched
    }

    // SubIFDs (330) and ExifIFD (34665) are the pointer tags rawler itself
    // recurses into; following them is enough to reach every raw IFD.
    const SUB_IFDS: u16 = 330;
    const EXIF_IFD: u16 = 34665;

    let mut stack: Vec<usize> = vec![rd_u32(buf, 4, le) as usize];
    let mut visited = std::collections::HashSet::new();
    let mut budget = 512usize; // bound work on malformed/looping files

    while let Some(mut off) = stack.pop() {
        // Walk this IFD and any chained IFDs (the trailing next-IFD pointer).
        while off != 0 {
            if budget == 0 || !visited.insert(off) || off + 2 > buf.len() {
                break;
            }
            budget -= 1;
            let n = rd_u16(buf, off, le) as usize;
            let end = off + 2 + n * 12; // entries, followed by next-IFD u32
            if end + 4 > buf.len() {
                break;
            }
            for i in 0..n {
                let e = off + 2 + i * 12;
                let tag = rd_u16(buf, e, le);
                if rd_u16(buf, e + 2, le) == 13 {
                    // IFD (13) -> LONG (4); identical 4-byte unsigned offset.
                    let four = if le { 4u16.to_le_bytes() } else { 4u16.to_be_bytes() };
                    buf[e + 2] = four[0];
                    buf[e + 3] = four[1];
                }
                if tag == SUB_IFDS || tag == EXIF_IFD {
                    let count = rd_u32(buf, e + 4, le) as usize;
                    if count <= 1 {
                        let v = rd_u32(buf, e + 8, le) as usize;
                        if v != 0 {
                            stack.push(v);
                        }
                    } else {
                        // >1 offsets are stored out-of-line at the value offset.
                        let vo = rd_u32(buf, e + 8, le) as usize;
                        for k in 0..count {
                            if vo + k * 4 + 4 <= buf.len() {
                                let v = rd_u32(buf, vo + k * 4, le) as usize;
                                if v != 0 {
                                    stack.push(v);
                                }
                            }
                        }
                    }
                }
            }
            off = rd_u32(buf, end, le) as usize;
        }
    }
}

/// Decode a camera RAW file (Fujifilm `.raf`, `.dng`, or any rawler-supported
/// format) into a demosaiced, linear-light RGB `Image`.
///
/// # Processing pipeline
/// We run rawler's `RawDevelop` with only the steps needed for a clean linear
/// decode:
///   - `Rescale` — applies black/white level correction, scaling raw u16 data
///     to f32 in [0, 1] before demosaic.
///   - `Demosaic` — PPG demosaic for standard RGB Bayer; bilinear for 4-channel
///     CFAs. Output remains in [0, 1] linear camera-native light.
///   - `CropActiveArea` — crops the optical black borders used during demosaic.
///   - `CropDefault` — applies the camera's default image crop.
///
/// Deliberately excluded:
///   - `WhiteBalance` — the inversion engine does its own channel balancing.
///   - `Calibrate` — skips the XYZ→camera color matrix; we want raw camera-
///     native values, not a rendering colorspace transform.
///   - `SRgb` — no gamma/tone curve; output stays linear.
///
/// # Normalization
/// `rawler`'s `Rescale` step subtracts per-channel black levels and divides by
/// (white_level − black_level), producing f32 values nominally in [0, 1].
/// After demosaic the values remain in that range (bilinear/PPG only
/// interpolate; they don't amplify). We clamp to [0, 1] as a safety net in
/// case of hot pixels or sensor artefacts slightly above white level.
pub fn decode_raw(path: &Path) -> Result<Image, DecodeError> {
    use rawler::imgop::develop::Intermediate;
    use rawler::imgop::develop::{ProcessingStep, RawDevelop};
    use std::sync::Arc;

    // Step 1: decode the raw file into a mosaic RawImage (integer u16 data,
    // not yet demosaiced).
    //
    // We read the bytes ourselves and run `normalize_ifd_pointer_types` before
    // handing them to rawler (see that function for why). This is the same data
    // `rawler::decode_file` would mmap; routing through an in-memory buffer lets
    // us patch a TIFF-encoding quirk that otherwise makes some DNGs undecodable.
    let mut bytes = std::fs::read(path)?;
    normalize_ifd_pointer_types(&mut bytes);
    let source = rawler::rawsource::RawSource::new_from_shared_vec(Arc::new(bytes)).with_path(path);
    let raw = rawler::decode(&source, &rawler::decoders::RawDecodeParams::default())
        .map_err(|e| DecodeError::Raw(e.to_string()))?;

    // Step 2: develop with only linear steps (no WB, no colour matrix, no gamma).
    let develop = RawDevelop {
        steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
            ProcessingStep::CropDefault,
        ],
    };
    let intermediate = develop
        .develop_intermediate(&raw)
        .map_err(|e| DecodeError::Raw(e.to_string()))?;

    // Step 3: extract the three-channel f32 pixel data.
    // After Rescale the data is in [0,1]; after Demosaic it stays in [0,1].
    // Clamp to guard against hot pixels that exceed white level.
    let (width, height, pixels) = match intermediate {
        Intermediate::ThreeColor(color2d) => {
            let w = color2d.width;
            let h = color2d.height;
            // color2d.data is Vec<[f32;3]> — exactly our Image::pixels type.
            let clamped: Vec<[f32; 3]> = color2d
                .data
                .into_iter()
                .map(|[r, g, b]| [r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)])
                .collect();
            (w, h, clamped)
        }
        Intermediate::FourColor(color2d) => {
            // Some exotic CFAs produce a 4-channel intermediate; collapse to RGB
            // by dropping the 4th channel (which is typically a second green or
            // near-IR channel — not meaningful for film inversion).
            let w = color2d.width;
            let h = color2d.height;
            let clamped: Vec<[f32; 3]> = color2d
                .data
                .into_iter()
                .map(|[r, g, b, _]| [r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)])
                .collect();
            (w, h, clamped)
        }
        Intermediate::Monochrome(pix) => {
            // Monochrome sensor: replicate the single channel into R=G=B.
            let w = pix.width;
            let h = pix.height;
            let clamped: Vec<[f32; 3]> = pix
                .data
                .into_iter()
                .map(|v| {
                    let c = v.clamp(0.0, 1.0);
                    [c, c, c]
                })
                .collect();
            (w, h, clamped)
        }
    };

    Ok(Image {
        width,
        height,
        pixels,
        ir: None,
    })
}

/// Extract a camera RAW file's EMBEDDED preview as a linear-light RGB `Image`,
/// downscaled so its long edge is ≤ `max_edge`, without a full decode/demosaic.
///
/// # Why
/// The LIGHT import path needs a cheap thumbnail so a freshly-imported, not-yet-
/// developed RAW shows a real picture in the Library grid instead of a black
/// placeholder. Most camera/scanner RAWs embed a JPEG preview; we ask rawler for
/// it via `full_image` (the most widely-implemented across formats), then
/// `thumbnail_image`. This is best-effort: some decoders (notably Olympus `.orf`)
/// expose no embedded preview at all, in which case the caller falls back to
/// `decode_tiff` or a full `decode_raw`.
///
/// # Color
/// Only 8-bit previews are accepted — those are reliably sRGB-encoded JPEGs, so —
/// exactly like [`decode_ldr`] — we apply the sRGB EOTF to land in the pipeline's
/// linear-light domain. (A rare 16-bit / float preview SubIFD has an ambiguous
/// transfer function `srgb_to_linear` would misread, so we reject it and let the
/// caller fall back.) The caller re-applies display gamma when encoding the
/// thumbnail (`to_png_b64(.., true)`); the encoder's 1/2.2 curve is a close — not
/// exact — inverse of the sRGB EOTF, the same near-neutral round-trip
/// [`decode_ldr`] uses for JPEG/PNG thumbnails.
///
/// # Robustness
/// We read + `normalize_ifd_pointer_types` the bytes ourselves (same as
/// [`decode_raw`]) so Capture One DNGs — whose preview lives behind a type-13
/// SubIFD pointer — still resolve. rawler can *panic* on malformed input (the
/// app's release profile deliberately avoids `panic = "abort"` for this), so the
/// decode runs inside `catch_unwind`. Returns `Err` when there is no usable
/// embedded preview.
///
/// EXIF orientation is not applied (consistent with [`decode_raw`]), so a portrait
/// frame's preview may appear rotated until it is developed.
pub fn decode_raw_preview(path: &Path, max_edge: u32) -> Result<Image, DecodeError> {
    use rawler::decoders::RawDecodeParams;
    use rawler::rawsource::RawSource;
    use std::sync::Arc;

    let mut bytes = std::fs::read(path)?;
    normalize_ifd_pointer_types(&mut bytes);
    let pb = path.to_path_buf();

    // rawler decoders can panic on malformed files — contain it so a single bad
    // file can't crash import. Constructing the source/decoder inside the closure
    // keeps the `UnwindSafe` bound on captures (owned `bytes` + `pb`) only.
    let dynimg = std::panic::catch_unwind(move || -> Option<::image::DynamicImage> {
        let source = RawSource::new_from_shared_vec(Arc::new(bytes)).with_path(&pb);
        let decoder = rawler::get_decoder(&source).ok()?;
        let params = RawDecodeParams::default();
        decoder
            .full_image(&source, &params)
            .ok()
            .flatten()
            // `preview_image` has no concrete override in rawler 0.7.2 (only the
            // default `Ok(None)` impl), so this branch is a no-op today — kept for
            // forward-compat if a future version implements it per-decoder.
            .or_else(|| decoder.preview_image(&source, &params).ok().flatten())
            .or_else(|| decoder.thumbnail_image(&source, &params).ok().flatten())
    })
    .map_err(|_| DecodeError::Raw("decoder panicked extracting preview".into()))?
    .ok_or_else(|| DecodeError::Raw("no embedded preview".into()))?;

    // Accept only 8-bit previews (reliably sRGB JPEGs). 16-bit / float preview
    // SubIFDs have an ambiguous transfer function; defer them to the caller.
    match &dynimg {
        ::image::DynamicImage::ImageRgb8(_)
        | ::image::DynamicImage::ImageRgba8(_)
        | ::image::DynamicImage::ImageLuma8(_)
        | ::image::DynamicImage::ImageLumaA8(_) => {}
        _ => return Err(DecodeError::Raw("non-8-bit embedded preview".into())),
    }

    // Downscale BEFORE linearizing so the per-pixel sRGB EOTF (a `powf`) runs over
    // the small thumbnail, not the full-res (multi-megapixel) embedded JPEG.
    let small = dynimg.thumbnail(max_edge, max_edge);
    let rgb = small.to_rgb32f(); // normalized [0,1] f32, alpha dropped
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let pixels: Vec<[f32; 3]> = rgb
        .pixels()
        .map(|p| {
            [
                srgb_to_linear(p[0]),
                srgb_to_linear(p[1]),
                srgb_to_linear(p[2]),
            ]
        })
        .collect();
    Ok(Image {
        width: w,
        height: h,
        pixels,
        ir: None,
    })
}

/// Decode a gamma-encoded LDR image (JPEG / PNG) into a linear-light RGB `Image`.
///
/// Unlike camera RAW and scanner TIFFs — which the pipeline treats as already
/// linear — JPEG/PNG are almost always **sRGB gamma-encoded**. We apply the sRGB
/// EOTF (`srgb_to_linear`) so the decoded values land in the same linear-light
/// domain the inversion engine expects. Any alpha channel is dropped; 16-bit PNGs
/// are supported (decoded at full precision before normalizing).
///
/// Note: 8-bit JPEG is lossy and low-bit-depth, so density-domain inversion has
/// less headroom than with a 16-bit RAW/TIFF scan — quality will be lower.
pub fn decode_ldr(path: &Path) -> Result<Image, DecodeError> {
    let img = ::image::open(path)?;
    let rgb = img.to_rgb32f(); // normalized [0,1] f32, alpha dropped
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let pixels: Vec<[f32; 3]> = rgb
        .pixels()
        .map(|p| {
            [
                srgb_to_linear(p[0]),
                srgb_to_linear(p[1]),
                srgb_to_linear(p[2]),
            ]
        })
        .collect();
    Ok(Image {
        width: w,
        height: h,
        pixels,
        ir: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_to_linear_endpoints_and_midtone() {
        assert!((srgb_to_linear(0.0) - 0.0).abs() < 1e-6);
        assert!((srgb_to_linear(1.0) - 1.0).abs() < 1e-6);
        // 128/255 sRGB ≈ 0.50196 encodes to ≈ 0.2159 linear.
        let mid = srgb_to_linear(128.0 / 255.0);
        assert!((mid - 0.2159).abs() < 1e-3, "got {mid}");
    }

    #[test]
    fn normalize_rewrites_type13_subifds_to_long() {
        // Minimal little-endian TIFF: header + one IFD with a single SubIFDs
        // entry (tag 330) encoded as TIFF type 13 (IFD) — the Capture One quirk.
        let mut buf = Vec::new();
        buf.extend_from_slice(b"II"); // little-endian
        buf.extend_from_slice(&42u16.to_le_bytes()); // magic
        buf.extend_from_slice(&8u32.to_le_bytes()); // first IFD at offset 8
        // IFD @ 8: 1 entry
        buf.extend_from_slice(&1u16.to_le_bytes()); // entry count
        buf.extend_from_slice(&330u16.to_le_bytes()); // tag = SubIFDs
        buf.extend_from_slice(&13u16.to_le_bytes()); // type = 13 (IFD)
        buf.extend_from_slice(&1u32.to_le_bytes()); // count = 1
        buf.extend_from_slice(&0u32.to_le_bytes()); // value/offset (0 = no recurse)
        buf.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0

        let type_field = 8 + 2 + 2; // header(8) + count(2) + tag(2)
        assert_eq!(u16::from_le_bytes([buf[type_field], buf[type_field + 1]]), 13);
        normalize_ifd_pointer_types(&mut buf);
        assert_eq!(
            u16::from_le_bytes([buf[type_field], buf[type_field + 1]]),
            4,
            "type-13 SubIFDs entry should be rewritten to type-4 LONG"
        );
    }

    #[test]
    fn normalize_is_noop_on_non_tiff() {
        // A non-TIFF magic (e.g. Fujifilm RAF) must be left untouched.
        let mut buf = b"FUJIFILMCCD-RAW \x00\x01\x02\x03".to_vec();
        let before = buf.clone();
        normalize_ifd_pointer_types(&mut buf);
        assert_eq!(buf, before);
    }

    #[test]
    fn decode_ldr_png_linearizes() {
        // 2x1 PNG: black, white. Decoded linear values must be 0.0 and 1.0.
        let mut buf: ::image::RgbImage = ::image::ImageBuffer::new(2, 1);
        buf.put_pixel(0, 0, ::image::Rgb([0, 0, 0]));
        buf.put_pixel(1, 0, ::image::Rgb([255, 255, 255]));
        let dir = std::env::temp_dir();
        let path = dir.join("filmrev_decode_ldr_test.png");
        buf.save(&path).unwrap();

        let img = decode_ldr(&path).unwrap();
        assert_eq!((img.width, img.height), (2, 1));
        assert!(img.ir.is_none());
        assert!((img.pixels[0][0] - 0.0).abs() < 1e-6);
        assert!((img.pixels[1][0] - 1.0).abs() < 1e-6);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn decode_raw_preview_errs_gracefully_on_non_raw() {
        // A plain PNG is not a camera RAW with an embedded preview. The extractor
        // must return Err (so import falls back to decode_tiff / placeholder) and
        // never panic out of `catch_unwind`.
        let mut buf: ::image::RgbImage = ::image::ImageBuffer::new(2, 2);
        buf.put_pixel(0, 0, ::image::Rgb([10, 20, 30]));
        let dir = std::env::temp_dir();
        let path = dir.join("filmrev_decode_raw_preview_test.png");
        buf.save(&path).unwrap();

        assert!(decode_raw_preview(&path, 320).is_err());

        let _ = std::fs::remove_file(&path);
    }
}
