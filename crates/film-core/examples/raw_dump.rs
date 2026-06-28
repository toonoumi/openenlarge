//! Context harness: decode a scan and write the RAW negative (no inversion),
//! display-gamma encoded, downscaled — so we can SEE the film rebate/border.
//! Usage: cargo run -p film-core --example raw_dump -- <scan...>

use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::Image;
use std::path::Path;

fn decode_any(path: &Path) -> Image {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let r = match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path),
        "jpg" | "jpeg" | "png" => decode_ldr(path),
        _ => decode_raw(path, false),
    };
    r.unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
}

fn downscale(img: &Image, target_long: usize) -> Image {
    let long = img.width.max(img.height);
    if long <= target_long {
        return img.clone();
    }
    let scale = target_long as f32 / long as f32;
    let w = ((img.width as f32 * scale) as usize).max(1);
    let h = ((img.height as f32 * scale) as usize).max(1);
    let mut pixels = vec![[0.0f32; 3]; w * h];
    for y in 0..h {
        let sy = ((y as f32 / scale) as usize).min(img.height - 1);
        for x in 0..w {
            let sx = ((x as f32 / scale) as usize).min(img.width - 1);
            pixels[y * w + x] = img.pixels[sy * img.width + sx];
        }
    }
    Image {
        width: w,
        height: h,
        pixels,
        ir: None,
    }
}

fn main() {
    for path in std::env::args().skip(1) {
        let small = downscale(&decode_any(Path::new(&path)), 700);
        let stem = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("scan");
        let mut buf = vec![0u8; small.width * small.height * 3];
        for (i, px) in small.pixels.iter().enumerate() {
            for c in 0..3 {
                // display-gamma so the linear scan is viewable
                buf[i * 3 + c] = (px[c].clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0 + 0.5) as u8;
            }
        }
        let out = format!("/tmp/tune/{stem}_raw.png");
        image::save_buffer(
            &out,
            &buf,
            small.width as u32,
            small.height as u32,
            image::ColorType::Rgb8,
        )
        .expect("write png");
        eprintln!("wrote {out}  ({}x{})", small.width, small.height);
    }
}
