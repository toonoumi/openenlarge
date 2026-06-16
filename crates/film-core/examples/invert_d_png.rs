//! Validation harness: decode a scan, run the Cineon inverter, write a PNG.
//! Usage: cargo run -p film-core --example invert_d_png -- <scan...>
//! Look at the PNGs across SEVERAL rolls; do not trust region stats.

use film_core::calibrate::sample_base;
use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::engine::{invert_image, InversionParams, Mode};
use std::path::Path;

/// Mirror commands.rs::decode_any's extension dispatch (which is private there).
fn decode_any(path: &Path) -> film_core::Image {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let r = match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path),
        "jpg" | "jpeg" | "png" => decode_ldr(path),
        _ => decode_raw(path),
    };
    r.unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
}

fn encode(img: &film_core::Image, path: &str) {
    let mut buf = vec![0u8; img.width * img.height * 3];
    for (i, px) in img.pixels.iter().enumerate() {
        for c in 0..3 {
            buf[i * 3 + c] = (px[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    image::save_buffer(
        path,
        &buf,
        img.width as u32,
        img.height as u32,
        image::ColorType::Rgb8,
    )
    .expect("write png");
    eprintln!("wrote {path}");
}

fn main() {
    for path in std::env::args().skip(1) {
        let full = decode_any(Path::new(&path));
        let base = sample_base(&full, None);
        eprintln!("{path}: base = {base:?}");
        let stem = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("scan");

        let pd = InversionParams { base, ..Default::default() };
        encode(&invert_image(&full, &pd, Mode::D), &format!("/tmp/{stem}_D.png"));
    }
}
