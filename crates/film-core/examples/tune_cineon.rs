//! Tuning harness: for each scan, sample the coherent base + auto D_max (the
//! real Plan-2 pipeline), then invert with a GRID of Cineon paper-curve params
//! (neutral WB) and tile the variants into one contact-sheet PNG per image.
//! Usage: cargo run -p film-core --example tune_cineon -- <scan...>
//! Grid rows = paper_grade, cols = print_exposure (see legend printed to stderr).

use film_core::calibrate::{sample_base_coherent, sample_dmax, BASE_BAND_AUTO};
use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::engine::{invert_image, InversionParams, Mode};
use film_core::Image;
use std::path::Path;

// --- the grid we sweep (edit between rounds) ---
const GRADES: [f32; 4] = [0.7, 0.85, 1.0, 1.15]; // rows (paper_grade)
const EXPOSURES: [f32; 2] = [0.9, 1.0]; // cols (print_exposure)
const PAPER_BLACK: f32 = 0.0;
const CELL_LONG: usize = 360; // px long-edge per cell
const GAP: usize = 6;

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

/// Cheap nearest-neighbour downscale so the grid renders fast.
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

fn save(canvas: &[[f32; 3]], w: usize, h: usize, path: &str) {
    let mut buf = vec![0u8; w * h * 3];
    for (i, px) in canvas.iter().enumerate() {
        for c in 0..3 {
            buf[i * 3 + c] = (px[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    image::save_buffer(path, &buf, w as u32, h as u32, image::ColorType::Rgb8).expect("write png");
    eprintln!("wrote {path}");
}

fn main() {
    eprintln!(
        "grid: rows(top→bottom) paper_grade={GRADES:?}  cols(left→right) print_exposure={EXPOSURES:?}  paper_black={PAPER_BLACK}"
    );
    for path in std::env::args().skip(1) {
        let full = decode_any(Path::new(&path));
        let cell = downscale(&full, CELL_LONG);
        let (blo, bhi) = BASE_BAND_AUTO;
        let base = sample_base_coherent(&cell, None, blo, bhi);
        let d_max = sample_dmax(&cell, base, None);
        let stem = Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("scan");
        eprintln!("{stem}: base={base:?} d_max={d_max:.3}");

        let (cw, ch) = (cell.width, cell.height);
        let cols = EXPOSURES.len();
        let rows = GRADES.len();
        let cw_total = cols * cw + (cols + 1) * GAP;
        let ch_total = rows * ch + (rows + 1) * GAP;
        let mut canvas = vec![[0.10f32; 3]; cw_total * ch_total]; // dark grey backdrop

        for (r, &grade) in GRADES.iter().enumerate() {
            for (c, &pexp) in EXPOSURES.iter().enumerate() {
                let p = InversionParams {
                    base,
                    d_max,
                    print_exposure: pexp,
                    paper_black: PAPER_BLACK,
                    paper_grade: grade,
                    wb: [1.0, 1.0, 1.0],
                    ..Default::default()
                };
                let inv = invert_image(&cell, &p, Mode::D);
                let ox = GAP + c * (cw + GAP);
                let oy = GAP + r * (ch + GAP);
                for y in 0..ch {
                    for x in 0..cw {
                        canvas[(oy + y) * cw_total + (ox + x)] = inv.pixels[y * cw + x];
                    }
                }
            }
        }
        save(
            &canvas,
            cw_total,
            ch_total,
            &format!("/tmp/tune/{stem}_grid.png"),
        );
    }
}
