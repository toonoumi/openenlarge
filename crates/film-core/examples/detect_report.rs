//! Report rebate detection vs the brightest-cluster fallback for each scan.
//! Usage: cargo run -p film-core --example detect_report -- <scan...>

use film_core::calibrate::{detect_rebate_base, sample_base_coherent, BASE_BAND_AUTO, REBATE_CONFIDENCE};
use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::Image;
use std::path::Path;

fn decode_any(path: &Path) -> Image {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let r = match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path),
        "jpg" | "jpeg" | "png" => decode_ldr(path),
        _ => decode_raw(path),
    };
    r.unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
}

fn main() {
    eprintln!("REBATE_CONFIDENCE threshold = {REBATE_CONFIDENCE}");
    for path in std::env::args().skip(1) {
        let img = decode_any(Path::new(&path));
        let det = detect_rebate_base(&img);
        let (lo, hi) = BASE_BAND_AUTO;
        let fb = sample_base_coherent(&img, None, lo, hi);
        let stem = Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or("scan");
        // Mirror commands::auto_base: confident → det; anti-blue → det; else fb.
        let (used, base) = if det.confidence >= REBATE_CONFIDENCE {
            ("DETECTED", det.base)
        } else if fb[2] >= fb[0] && det.base[0] > det.base[2] {
            ("ANTI-BLUE", det.base)
        } else {
            ("FALLBACK", fb)
        };
        eprintln!(
            "{stem:18} -> base=[{:.3},{:.3},{:.3}] ({used}, conf={:.3}) | det=[{:.3},{:.3},{:.3}] fb=[{:.3},{:.3},{:.3}]",
            base[0], base[1], base[2], det.confidence,
            det.base[0], det.base[1], det.base[2], fb[0], fb[1], fb[2]
        );
    }
}
