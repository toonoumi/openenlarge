//! Decode scan files into a linear-RGB Image.
//!
//! `decode_tiff` handles plain 8/16-bit RGB TIFF and scanner *linear* DNGs that
//! the `tiff` crate can read directly. `decode_raw` (a later task) handles Bayer
//! RAF/DNG via rawler.

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
    let mut ir: Option<Vec<f32>> = if channels == 4 { Some(Vec::with_capacity(n)) } else { None };
    for i in 0..n {
        let base = i * channels;
        pixels.push([floats[base], floats[base + 1], floats[base + 2]]);
        if let Some(ir) = ir.as_mut() {
            ir.push(floats[base + 3]);
        }
    }
    Ok(Image { width: w as usize, height: h as usize, pixels, ir })
}
