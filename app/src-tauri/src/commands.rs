//! Tauri commands orchestrating film-core for the RedRoom UI.

use crate::convert::proxy;
use crate::encode::to_png_b64;
use crate::metadata::extract;
use crate::session::{CachedImage, ImageEntry, InvertParams, Session};
use film_core::calibrate::{auto_wb_gains, sample_base, Rect};
use film_core::decode::{decode_raw, decode_tiff};
use film_core::engine::{invert_image, params_for_stock, InversionParams, Mode};
use film_core::spectral::Stock;
use std::path::Path;
use tauri::State;

const PROXY_EDGE: u32 = 2048;
const THUMB_EDGE: u32 = 256;

fn decode_any(path: &Path) -> Result<film_core::Image, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path).map_err(|e| format!("{e}")),
        _ => decode_raw(path).map_err(|e| format!("{e}")),
    }
}

fn stock_from(s: &str) -> Option<Stock> {
    match s {
        "portra400" => Some(Stock::Portra400),
        "fujic200" => Some(Stock::FujiC200),
        _ => None,
    }
}

fn mode_from(s: &str) -> Mode {
    match s { "c" => Mode::C, _ => Mode::B }
}

fn build_params(p: &InvertParams, base: [f32; 3]) -> InversionParams {
    match stock_from(&p.stock) {
        Some(s) if p.mode == "b" => params_for_stock(s, base, p.exposure, p.black, p.gamma),
        _ => InversionParams { base, exposure: p.exposure, black: p.black, gamma: p.gamma, ..Default::default() },
    }
}

/// Manual white-balance gains from Temp/Tint controls (each ~[-1,1]).
/// temp>0 warms (more R, less B); tint>0 pushes magenta (less G).
fn wb_from_temp_tint(temp: f32, tint: f32) -> [f32; 3] {
    let r = (1.0 + 0.4 * temp + 0.2 * tint).max(0.1);
    let g = (1.0 - 0.4 * tint).max(0.1);
    let b = (1.0 - 0.4 * temp + 0.2 * tint).max(0.1);
    [r, g, b]
}

/// Build the final inversion params: matrices/exposure from `build_params`, plus
/// manual Temp/Tint WB and (if `auto_wb`) gray-world gains from a first pass over
/// the proxy. Auto gains are always computed on the proxy (fast) for consistency
/// between preview and export.
fn resolve_params(p: &InvertParams, proxy_img: &film_core::Image, base: [f32; 3]) -> InversionParams {
    let manual = wb_from_temp_tint(p.temp, p.tint);
    let mut ip = build_params(p, base);
    ip.wb = manual;
    if p.auto_wb {
        let first = invert_image(proxy_img, &ip, mode_from(&p.mode));
        let auto = auto_wb_gains(&first);
        ip.wb = [manual[0] * auto[0], manual[1] * auto[1], manual[2] * auto[2]];
    }
    ip
}

#[tauri::command]
pub fn import_image(path: String, session: State<Session>) -> Result<ImageEntry, String> {
    let p = Path::new(&path);
    let full = decode_any(p)?;
    let proxy_img = proxy(&full, PROXY_EDGE);
    let thumb_img = proxy(&full, THUMB_EDGE);
    let thumbnail = to_png_b64(&thumb_img, true)?;
    let metadata = extract(p, full.width as u32, full.height as u32);
    let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let cached = CachedImage { full_res: full, proxy: proxy_img, file_name, metadata, thumbnail };
    Ok(session.insert(cached))
}

#[tauri::command]
pub fn raw_preview(id: String, session: State<Session>) -> Result<String, String> {
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    to_png_b64(&img.proxy, true)
}

#[tauri::command]
pub fn inverted_preview(id: String, params: InvertParams, session: State<Session>) -> Result<String, String> {
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let rect = params.base_rect.map(|r| Rect { x: r[0], y: r[1], w: r[2], h: r[3] });
    let base = sample_base(&img.proxy, rect);
    let ip = resolve_params(&params, &img.proxy, base);
    let inv = invert_image(&img.proxy, &ip, mode_from(&params.mode));
    to_png_b64(&inv, false)
}

#[tauri::command]
pub fn export_image(id: String, params: InvertParams, out_path: String, session: State<Session>) -> Result<(), String> {
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let rect = params.base_rect.map(|r| Rect { x: r[0], y: r[1], w: r[2], h: r[3] });
    let base = sample_base(&img.proxy, rect);
    let ip = resolve_params(&params, &img.proxy, base);
    let inv = invert_image(&img.full_res, &ip, mode_from(&params.mode));
    film_core::export::write_tiff16(&inv, Path::new(&out_path)).map_err(|e| format!("{e}"))
}
