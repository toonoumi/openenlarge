//! Time the per-image analysis ops at working resolutions, to locate the
//! develop / image-switch slowdown. Usage: cargo run --release -p film-core --example perf_probe -- <scan>

use film_core::calibrate::{
    detect_rebate_base, sample_base, sample_base_coherent, sample_dmax, BASE_BAND_AUTO,
};
use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::Image;
use std::path::Path;
use std::time::Instant;

fn decode_any(path: &Path) -> Image {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path),
        "jpg" | "jpeg" | "png" => decode_ldr(path),
        _ => decode_raw(path),
    }
    .unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
}

fn downscale(img: &Image, target_long: usize) -> Image {
    let long = img.width.max(img.height);
    if long <= target_long {
        return img.clone();
    }
    let s = target_long as f32 / long as f32;
    let w = ((img.width as f32 * s) as usize).max(1);
    let h = ((img.height as f32 * s) as usize).max(1);
    let mut pixels = vec![[0.0f32; 3]; w * h];
    for y in 0..h {
        let sy = ((y as f32 / s) as usize).min(img.height - 1);
        for x in 0..w {
            let sx = ((x as f32 / s) as usize).min(img.width - 1);
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

fn ms(label: &str, mut f: impl FnMut()) {
    let t = Instant::now();
    f();
    eprintln!(
        "  {label:32} {:>8.1} ms",
        t.elapsed().as_secs_f64() * 1000.0
    );
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: perf_probe <scan>");
    let t = Instant::now();
    let full = decode_any(Path::new(&path));
    eprintln!(
        "decoded {}x{} ({:.1} MP) in {:.0} ms",
        full.width,
        full.height,
        (full.width * full.height) as f64 / 1e6,
        t.elapsed().as_secs_f64() * 1000.0
    );

    for cap in [4096usize, usize::MAX] {
        let working = downscale(&full, cap);
        let (blo, bhi) = BASE_BAND_AUTO;
        let base = detect_rebate_base(&working).base;
        eprintln!(
            "\n== working {}x{} ({:.1} MP){} ==",
            working.width,
            working.height,
            (working.width * working.height) as f64 / 1e6,
            if cap == 4096 {
                " [Performance]"
            } else {
                " [Quality/full]"
            }
        );
        ms("detect_rebate_base (NEW)", || {
            let _ = detect_rebate_base(&working);
        });
        ms("sample_dmax whole (NEW, per-switch)", || {
            let _ = sample_dmax(&working, base, None);
        });
        ms("sample_base_coherent whole (NEW)", || {
            let _ = sample_base_coherent(&working, None, blo, bhi);
        });
        ms("sample_base whole (OLD baseline)", || {
            let _ = sample_base(&working, None);
        });
        if cap == usize::MAX && full.width.max(full.height) <= 4096 {
            eprintln!("  (source <= 4096, Quality == Performance here)");
            break;
        }
    }
}
