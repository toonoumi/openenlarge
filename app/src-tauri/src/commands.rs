//! Tauri commands orchestrating film-core for the OpenEnlarge UI.

use crate::convert::{crop, orient, orient_dims, proxy, resize_to, rotate};
use crate::encode::{to_jpeg_b64, to_png_b64, write_jpeg, write_png, write_tiff8};
use crate::gpu_upload::{
    bake_geometry, bake_working, capped_dims, image_from_rgba8, image_from_rgba_f32, pack_rgba16f,
    resolve_to_uniforms, BakeSpec, ResolvedInversion, MAX_GPU_EDGE,
};
use crate::metadata::extract;
use crate::session::{
    CachedImage, Developed, ImageEntry, InvertParams, PreparedExport, Quality, Session,
};
use film_core::calibrate::auto_wb_gains;
use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::dust::{self, Stamp};
use film_core::engine::{invert_image, InversionParams, Mode};
use film_core::finish::{finish_image, tone_luts, ColorGrade, ColorMix, FinishParams, PcSample};
use film_core::wb::{gains_to_cct, wb_from_kelvin};
use serde::Deserialize;
use std::path::Path;
use tauri::State;

fn default_bits() -> u8 {
    16
}
fn default_quality() -> u8 {
    85
}

/// Output format chosen in the Export modal. Mirrors the JS `ExportFormat` object.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormat {
    pub kind: String, // "jpeg" | "tiff" | "png"
    #[serde(default = "default_bits")]
    pub bit_depth: u8, // 8 | 16 (tiff/png)
    #[serde(default = "default_quality")]
    pub quality: u8, // jpeg, 1–100
    #[serde(default)]
    pub max_bytes: Option<u64>, // jpeg
}

/// User-edited metadata overrides sent from the panel. Each field, when present
/// and non-blank, replaces the source EXIF value on export. Mirrors the JS
/// `MetaOverride`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MetaOverride {
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub shutter: Option<String>,
    pub aperture: Option<String>,
    pub date: Option<String>,
    pub note: Option<String>,
}

/// Overlay the override onto the source metadata: a non-blank override field wins,
/// otherwise the original is kept. (Note has no source value; it comes only from
/// the override.)
fn effective_metadata(
    orig: &crate::metadata::Metadata,
    ov: Option<&MetaOverride>,
) -> crate::metadata::Metadata {
    let mut m = orig.clone();
    let Some(o) = ov else { return m };
    let pick = |cur: &Option<String>, new: &Option<String>| -> Option<String> {
        new.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| cur.clone())
    };
    m.camera = pick(&m.camera, &o.camera);
    m.lens = pick(&m.lens, &o.lens);
    m.iso = pick(&m.iso, &o.iso);
    m.shutter = pick(&m.shutter, &o.shutter);
    m.aperture = pick(&m.aperture, &o.aperture);
    m.date = pick(&m.date, &o.date);
    m.note = pick(&m.note, &o.note);
    m
}

const THUMB_EDGE: u32 = 320;
const AUTOWB_EDGE: u32 = 256;
const PREVIEW_JPEG_QUALITY: u8 = 88;
const CACHE_WORKING_CAP: u32 = 4096;

/// True when a resident working buffer is large enough for `cap`. The buffer is
/// adequate once its long edge reaches `min(native_edge, cap)` — Performance
/// (cap 4096) is satisfied by any cached buffer; Quality (cap u32::MAX) needs the
/// full-res decode unless the source is already smaller than the cache cap.
fn working_satisfies(working_edge: u32, native_edge: u32, cap: u32) -> bool {
    working_edge >= native_edge.min(cap)
}

pub(crate) fn default_invert_params() -> InvertParams {
    InvertParams {
        mode: "d".into(),
        stock: "none".into(),
        base_override: None,
        d_max_override: None,
        exposure: 0.0,
        black: 0.0,
        gamma: 0.4545,
        auto_wb: true,
        temp: 5500.0,
        tint: 0.0,
        wb_manual: false,
        hdr: false,
        positive: false,
        contrast: 0.0,
        highlights: 0.0,
        shadows: 0.0,
        whites: 0.0,
        blacks: 0.0,
        texture: 0.0,
        vibrance: 0.0,
        saturation: 0.0,
        tc_highlights: 0.0,
        tc_lights: 0.0,
        tc_darks: 0.0,
        tc_shadows: 0.0,
        tc_curve: crate::session::identity_curve(),
        tc_red: crate::session::identity_curve(),
        tc_green: crate::session::identity_curve(),
        tc_blue: crate::session::identity_curve(),
        cg_sh_hue: 0.0,
        cg_sh_sat: 0.0,
        cg_sh_lum: 0.0,
        cg_mid_hue: 0.0,
        cg_mid_sat: 0.0,
        cg_mid_lum: 0.0,
        cg_hi_hue: 0.0,
        cg_hi_sat: 0.0,
        cg_hi_lum: 0.0,
        cg_glob_hue: 0.0,
        cg_glob_sat: 0.0,
        cg_glob_lum: 0.0,
        cg_blending: 50.0,
        cg_balance: 0.0,
        cm_red_hue: 0.0,
        cm_red_sat: 0.0,
        cm_red_lum: 0.0,
        cm_orange_hue: 0.0,
        cm_orange_sat: 0.0,
        cm_orange_lum: 0.0,
        cm_yellow_hue: 0.0,
        cm_yellow_sat: 0.0,
        cm_yellow_lum: 0.0,
        cm_green_hue: 0.0,
        cm_green_sat: 0.0,
        cm_green_lum: 0.0,
        cm_aqua_hue: 0.0,
        cm_aqua_sat: 0.0,
        cm_aqua_lum: 0.0,
        cm_blue_hue: 0.0,
        cm_blue_sat: 0.0,
        cm_blue_lum: 0.0,
        cm_purple_hue: 0.0,
        cm_purple_sat: 0.0,
        cm_purple_lum: 0.0,
        cm_magenta_hue: 0.0,
        cm_magenta_sat: 0.0,
        cm_magenta_lum: 0.0,
        pc_samples: Vec::new(),
    }
}

fn metadata_to_json(m: &crate::metadata::Metadata) -> Result<String, String> {
    serde_json::to_string(m).map_err(|e| e.to_string())
}

fn decode_any(path: &Path) -> Result<film_core::Image, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path).map_err(|e| format!("{e}")),
        "jpg" | "jpeg" | "png" => decode_ldr(path).map_err(|e| format!("{e}")),
        _ => decode_raw(path).map_err(|e| format!("{e}")),
    }
}

pub(crate) fn mode_from(_s: &str) -> Mode {
    // One engine. The `mode` wire field is vestigial; always Cineon.
    Mode::D
}

pub(crate) fn build_params(p: &InvertParams, base: [f32; 3]) -> InversionParams {
    // One engine: Kodak Cineon (negadoctor). The exposure slider drives print
    // exposure; d_max/paper_* come from InversionParams::Default; WB is set by the
    // caller (resolve_params / resolve_to_uniforms). `stock`/`mode`/`black`/`gamma`
    // are vestigial — kept in the wire contract for back-compat, no longer read.
    InversionParams {
        base,
        print_exposure: 2f32.powf(p.exposure), // EV stops → linear print exposure
        d_max: p.d_max_override.unwrap_or(1.5),
        positive: p.positive,
        ..Default::default()
    }
}

/// The base to invert with: the per-image override if set, else the develop-time
/// auto base sampled at `develop_image` time.
pub(crate) fn effective_base(p: &InvertParams, dev_base: [f32; 3]) -> [f32; 3] {
    p.base_override.unwrap_or(dev_base)
}

/// Effective Cineon D_max for an inversion: the per-image override if set, else the
/// develop-time auto value stored on `Developed`.
pub(crate) fn effective_dmax(p: &InvertParams, dev_dmax: f32) -> f32 {
    p.d_max_override.unwrap_or(dev_dmax)
}

/// Pick the film base for a freshly-developed working image. Returns (base, confidence).
///
/// 1. Confident edge-detected rebate → use it.
/// 2. Otherwise the brightest-cluster fallback — UNLESS that fallback is non-orange
///    (B ≥ R) while the edge detector did find an orange candidate. A C-41 mask is
///    always orange, so a blue fallback means a bright blue scene outscored a dim
///    rebate (the mixed-roll "Phoenix" bug); prefer the orange edge even at low
///    confidence (the UI flags it for an optional repoint).
/// 3. Else the brightest-cluster fallback (already orange-ish).
pub(crate) fn auto_base(working: &film_core::Image) -> ([f32; 3], f32) {
    use film_core::calibrate::{
        detect_rebate_base, sample_base_coherent, BASE_BAND_AUTO, REBATE_CONFIDENCE,
    };
    let det = detect_rebate_base(working);
    if det.confidence >= REBATE_CONFIDENCE {
        return (det.base, det.confidence);
    }
    let (lo, hi) = BASE_BAND_AUTO;
    let fb = sample_base_coherent(working, None, lo, hi);
    // Anti-blue: orange edge beats a non-orange (blue) fallback — but only if the
    // edge has real brightness. A near-black noise patch can satisfy R>B ordering
    // yet make a useless dmin; the luma floor rejects it (a dim real rebate is
    // ~0.12–0.24 luma, well above 0.06), leaving the fallback for true rebate-less frames.
    let det_luma = (det.base[0] + det.base[1] + det.base[2]) / 3.0;
    if fb[2] >= fb[0] && det.base[0] > det.base[2] && det_luma > 0.06 {
        return (det.base, det.confidence);
    }
    (fb, det.confidence)
}

pub(crate) fn wb_from_params(temp: f32, tint: f32) -> [f32; 3] {
    wb_from_kelvin(temp, tint / 150.0)
}

pub(crate) fn resolve_params(
    p: &InvertParams,
    _autowb_src: &film_core::Image,
    base: [f32; 3],
) -> InversionParams {
    let mut ip = build_params(p, base);
    ip.wb = wb_from_params(p.temp, p.tint);
    ip
}

fn finish_default() -> bool {
    true
}

/// Map a normalized crop rect [x,y,w,h] (0..1) to integer pixels on a w×h image,
/// clamped to bounds with a 1px minimum.
pub(crate) fn crop_px(norm: [f64; 4], w: usize, h: usize) -> (usize, usize, usize, usize) {
    let x = (norm[0] * w as f64).round().clamp(0.0, (w - 1) as f64) as usize;
    let y = (norm[1] * h as f64).round().clamp(0.0, (h - 1) as f64) as usize;
    let cw = (norm[2] * w as f64).round().clamp(1.0, (w - x) as f64) as usize;
    let ch = (norm[3] * h as f64).round().clamp(1.0, (h - y) as f64) as usize;
    (x, y, cw, ch)
}

/// Map normalized strokes → `Stamp`s in OUTPUT pixel space.
/// `base_w/base_h` are the WORKING image dims BEFORE the view crop is applied
/// (oriented + straightened + persistent image_crop, but NOT the per-render view
/// crop) — this is the image the UI normalizes stroke coords against. `(cx,cy,cw,ch)`
/// is the view-crop window within that base; `out_w/out_h` is the rendered output size.
#[allow(clippy::too_many_arguments)]
fn view_stamps(
    dust: &[DustStroke],
    base_w: usize,
    base_h: usize,
    cx: usize,
    cy: usize,
    cw: usize,
    ch: usize,
    out_w: u32,
    out_h: u32,
) -> Vec<Stamp> {
    if cw == 0 || ch == 0 {
        return Vec::new();
    }
    let sx = out_w as f64 / cw as f64;
    let sy = out_h as f64 / ch as f64;
    let mut out = Vec::new();
    for stroke in dust {
        // r is normalized to base WIDTH (matching the UI brush); scale by the x-axis factor.
        let r = (stroke.r * base_w as f64 * sx).max(0.5);
        for pt in &stroke.points {
            let bx = pt[0] * base_w as f64;
            let by = pt[1] * base_h as f64;
            out.push(Stamp {
                cx: ((bx - cx as f64) * sx) as f32,
                cy: ((by - cy as f64) * sy) as f32,
                r: r as f32,
            });
        }
    }
    out
}

/// Map normalized strokes → `Stamp`s on a full-res `w`×`h` image (no view crop).
/// Mirrors `view_stamps` but for export: points normalize to image dims, radius to width.
pub(crate) fn export_stamps(dust: &[DustStroke], w: usize, h: usize) -> Vec<Stamp> {
    let mut out = Vec::new();
    for stroke in dust {
        let r = (stroke.r * w as f64).max(0.5) as f32;
        for pt in &stroke.points {
            out.push(Stamp {
                cx: (pt[0] * w as f64) as f32,
                cy: (pt[1] * h as f64) as f32,
                r,
            });
        }
    }
    out
}

fn color_mix_from(p: &crate::session::InvertParams) -> ColorMix {
    let cm_hue = [
        p.cm_red_hue,
        p.cm_orange_hue,
        p.cm_yellow_hue,
        p.cm_green_hue,
        p.cm_aqua_hue,
        p.cm_blue_hue,
        p.cm_purple_hue,
        p.cm_magenta_hue,
    ];
    let cm_sat = [
        p.cm_red_sat,
        p.cm_orange_sat,
        p.cm_yellow_sat,
        p.cm_green_sat,
        p.cm_aqua_sat,
        p.cm_blue_sat,
        p.cm_purple_sat,
        p.cm_magenta_sat,
    ];
    let cm_lum = [
        p.cm_red_lum,
        p.cm_orange_lum,
        p.cm_yellow_lum,
        p.cm_green_lum,
        p.cm_aqua_lum,
        p.cm_blue_lum,
        p.cm_purple_lum,
        p.cm_magenta_lum,
    ];
    let samples = p
        .pc_samples
        .iter()
        .map(|s| PcSample {
            hue: s.hue,
            sat: s.sat,
            lum: s.lum,
            hue_shift: s.hue_shift / 100.0,
            sat_shift: s.sat_shift / 100.0,
            lum_shift: s.lum_shift / 100.0,
            variance: s.variance,
            range: s.range,
        })
        .collect();
    ColorMix {
        cm_hue: cm_hue.map(|v| v / 100.0),
        cm_sat: cm_sat.map(|v| v / 100.0),
        cm_lum: cm_lum.map(|v| v / 100.0),
        samples,
    }
}

pub(crate) fn finish_from(p: &InvertParams) -> FinishParams {
    // Region sliders ordered [shadows, darks, lights, highlights] to match the engine.
    let regions = [
        p.tc_shadows / 100.0,
        p.tc_darks / 100.0,
        p.tc_lights / 100.0,
        p.tc_highlights / 100.0,
    ];
    let (lut_r, lut_g, lut_b) = tone_luts(regions, &p.tc_curve, &p.tc_red, &p.tc_green, &p.tc_blue);
    let cg = ColorGrade::new(
        ([p.cg_sh_hue, p.cg_sh_sat / 100.0], p.cg_sh_lum / 100.0),
        ([p.cg_mid_hue, p.cg_mid_sat / 100.0], p.cg_mid_lum / 100.0),
        ([p.cg_hi_hue, p.cg_hi_sat / 100.0], p.cg_hi_lum / 100.0),
        (
            [p.cg_glob_hue, p.cg_glob_sat / 100.0],
            p.cg_glob_lum / 100.0,
        ),
        p.cg_blending / 100.0,
        p.cg_balance / 100.0,
    );
    FinishParams {
        contrast: p.contrast / 100.0,
        highlights: p.highlights / 100.0,
        shadows: p.shadows / 100.0,
        whites: p.whites / 100.0,
        blacks: p.blacks / 100.0,
        texture: p.texture / 100.0,
        vibrance: p.vibrance / 100.0,
        saturation: p.saturation / 100.0,
        lut_r,
        lut_g,
        lut_b,
        cg,
        cm: color_mix_from(p),
    }
}

/// LIGHT import: thumbnail (embedded preview if available) + metadata + stored
/// path. No full decode — the heavy work happens in `develop_image`.
#[tauri::command]
pub fn import_image(
    path: String,
    session: State<Session>,
    catalog: State<crate::catalog::Catalog>,
) -> Result<ImageEntry, String> {
    let p = Path::new(&path);
    // Light thumbnail: TIFF and JPEG/PNG decode cheaply (no demosaic), so render a
    // real preview. RAW files fall back to the 1x1 placeholder until develop.
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let preview = match ext.as_str() {
        "jpg" | "jpeg" | "png" => decode_ldr(p).map_err(|e| format!("{e}")),
        _ => decode_tiff(p).map_err(|e| format!("{e}")),
    };
    let thumbnail = match preview {
        Ok(prev) => to_png_b64(&proxy(&prev, THUMB_EDGE), true)?,
        Err(_) => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string(),
    };
    let metadata = extract(p, 0, 0);
    let file_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("image")
        .to_string();
    let metadata_json = metadata_to_json(&metadata)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let id = catalog
        .upsert_image(&path, &file_name, &metadata_json, &thumbnail, now)
        .map_err(|e| e.to_string())?;
    let cached = CachedImage {
        path,
        file_name,
        metadata,
        thumbnail,
        developed: None,
    };
    Ok(session.insert_with_id(id, cached))
}

/// HEAVY step: decode the file, build the working image at the quality cap, a
/// small auto-WB thumb, and sample the base. Drops full_res. Returns the updated
/// entry (real dimensions + developed=true).
#[tauri::command]
pub fn develop_image(
    id: String,
    session: State<Session>,
    catalog: State<crate::catalog::Catalog>,
) -> Result<ImageEntry, String> {
    develop_heavy(id, &session, &catalog)
}

/// Decode the RAW, build the quality-capped working image + auto-WB thumb, sample
/// the base, refresh the thumbnail/catalog, and write the cache sidecar. This is
/// the expensive path shared by `develop_image` and `ensure_developed`.
fn develop_heavy(
    id: String,
    session: &Session,
    catalog: &crate::catalog::Catalog,
) -> Result<ImageEntry, String> {
    let cap = session.quality.lock().unwrap().cap();
    let path = {
        let images = session.images.lock().unwrap();
        images.get(&id).ok_or("unknown image id")?.path.clone()
    };
    let full = decode_any(Path::new(&path))?;
    let working = proxy(&full, cap);
    let has_ir = working.ir.is_some();
    let thumb = proxy(&full, AUTOWB_EDGE);
    let (base, base_confidence) = auto_base(&working);
    let (positive, positive_confidence) = film_core::classify::classify_positive(&working);
    let d_max = film_core::calibrate::sample_dmax(&working, base, None);
    let (w, h) = (full.width as u32, full.height as u32);
    drop(full);

    let small = proxy(&working, THUMB_EDGE);
    // Honor the detected verdict so a positive's develop-time grid thumbnail isn't
    // shown inverted before the image is opened (the per-image seed carries it after).
    let defaults = InvertParams { positive, ..default_invert_params() };
    let mut ip = resolve_params(&defaults, &thumb, base);
    ip.d_max = d_max;
    let inv_thumb = invert_image(&small, &ip, Mode::D);
    let inv_thumb = finish_image(&inv_thumb, &finish_from(&defaults));
    let thumbnail = to_jpeg_b64(&inv_thumb, false, 82)?;

    // Build a cache-bounded copy of working (≤CACHE_WORKING_CAP long edge) for the sidecar.
    // Clone thumb too before the move into Developed.
    let cache_working = if working.width.max(working.height) > CACHE_WORKING_CAP as usize {
        crate::convert::proxy(&working, CACHE_WORKING_CAP)
    } else {
        working.clone()
    };
    let cache_thumb = thumb.clone();

    // Mutate session state and build the entry inside the lock, then release
    // the guard before the expensive cache write (tens of MB, zstd + file IO).
    let (entry, metadata_json) = {
        let mut images = session.images.lock().unwrap();
        let img = images.get_mut(&id).ok_or("unknown image id")?;
        img.metadata.width = w;
        img.metadata.height = h;
        img.thumbnail = thumbnail.clone();
        img.developed = Some(Developed {
            working,
            thumb,
            base,
            base_confidence,
            d_max,
            positive,
            positive_confidence,
        });
        let metadata_json = metadata_to_json(&img.metadata)?;
        let entry = ImageEntry {
            id: id.clone(),
            path: img.path.clone(),
            file_name: img.file_name.clone(),
            thumbnail,
            metadata: img.metadata.clone(),
            developed: true,
            has_ir,
            offline: false,
            positive,
        };
        (entry, metadata_json)
    }; // lock released here

    if let Err(e) = catalog.update_image_render(&id, &entry.thumbnail, &metadata_json) {
        eprintln!("[catalog] update_image_render failed for {id}: {e}");
    }

    // Write cache sidecar (best-effort; never fails the develop command).
    if let Err(e) =
        crate::cache::write(&session.cache_path(&id), base, &cache_working, &cache_thumb)
    {
        eprintln!("[cache] write failed for {id}: {e}");
    }

    Ok(entry)
}

#[tauri::command]
pub fn set_quality(quality: Quality, session: State<Session>) -> Result<(), String> {
    *session.quality.lock().unwrap() = quality;
    Ok(())
}

/// Idempotent, cache-aware develop. Loads the cached buffer if not resident, and
/// re-decodes the RAW only when that buffer is too small for the current quality
/// (Quality mode on a source larger than the cache cap). Performance switches and
/// already-full-res buffers return without any decode.
#[tauri::command]
pub fn ensure_developed(
    id: String,
    session: State<Session>,
    catalog: State<crate::catalog::Catalog>,
) -> Result<ImageEntry, String> {
    let cap = session.quality.lock().unwrap().cap();
    // Best-effort cache rehydration; ignore "not developed" — we full-develop below.
    let _ = ensure_resident(&session, &id);

    let adequate_entry = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        match img.developed.as_ref() {
            Some(dev) => {
                let working_edge = dev.working.width.max(dev.working.height) as u32;
                let native_edge = img.metadata.width.max(img.metadata.height);
                if working_satisfies(working_edge, native_edge, cap) {
                    Some(ImageEntry {
                        id: id.clone(),
                        path: img.path.clone(),
                        file_name: img.file_name.clone(),
                        thumbnail: img.thumbnail.clone(),
                        metadata: img.metadata.clone(),
                        developed: true,
                        has_ir: dev.working.ir.is_some(),
                        offline: false,
                        positive: dev.positive,
                    })
                } else {
                    None
                }
            }
            None => None,
        }
    };

    if let Some(entry) = adequate_entry {
        return Ok(entry);
    }
    develop_heavy(id, &session, &catalog)
}

/// Drop an image from the session. With `delete_file`, also move the original
/// file to the OS trash (recoverable). Removing from the session always happens
/// first so the app forgets the image even if the trash step fails.
#[tauri::command]
pub fn delete_image(
    id: String,
    delete_file: bool,
    session: State<Session>,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    let removed = session.images.lock().unwrap().remove(&id);
    if let Err(e) = catalog.delete_image(&id) {
        eprintln!("[catalog] delete_image failed for {id}: {e}");
    }
    let _ = std::fs::remove_file(session.cache_path(&id));
    if delete_file {
        let img = removed.ok_or_else(|| "unknown image".to_string())?;
        trash::delete(&img.path).map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

/// A brush stroke from the UI: a polyline of points normalized to the DISPLAYED
/// image ([0,1] each), with radius `r` normalized to the displayed image WIDTH.
#[derive(Debug, Clone, Deserialize)]
pub struct DustStroke {
    pub points: Vec<[f64; 2]>,
    pub r: f64,
}

/// IR-driven auto dust removal settings from the UI.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct IrRemoval {
    pub enabled: bool,
    pub sensitivity: f32,
}

/// AI (learned-model) auto dust/hair removal settings from the UI. When
/// `enabled`, the bake path inverts the working buffer, runs the cached detector,
/// thresholds at `sensitivity`, and MI-GAN-heals the defect mask (unioned with
/// brush strokes) — see `working_baked_pixels` / `bake_for_view_from_baked`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AutoDust {
    pub enabled: bool,
    pub sensitivity: f32,
}

/// The visible region to render, in FULL-RES pixel coordinates, plus the output
/// (≈ viewport) pixel size. `raw` selects the un-inverted scan.
#[derive(Debug, Clone, Deserialize)]
pub struct ViewSpec {
    pub crop: [f64; 4],
    pub out_w: u32,
    pub out_h: u32,
    pub raw: bool,
    /// When false, return the inverted+graded preview BEFORE the finishing layer
    /// (the GPU applies finishing live). Defaults true for the legacy path/export.
    #[serde(default = "finish_default")]
    pub finish: bool,
    /// Normalized [x,y,w,h] persistent crop on the original image; applied before
    /// the zoom/view crop. None = whole image.
    #[serde(default)]
    pub image_crop: Option<[f64; 4]>,
    #[serde(default)]
    pub rot90: u8,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default)]
    pub angle: f32,
    #[serde(default)]
    pub dust: Vec<DustStroke>,
    #[serde(default)]
    pub ir_removal: IrRemoval,
    #[serde(default)]
    pub auto_dust: AutoDust,
}

/// Ensure the image's decoded `Developed` is resident in the Session: if absent
/// but a cache file exists, load it. Drops the lock during file IO.
fn ensure_resident(session: &Session, id: &str) -> Result<(), String> {
    {
        let images = session.images.lock().unwrap();
        match images.get(id) {
            Some(c) if c.developed.is_some() => return Ok(()),
            Some(_) => {}
            None => return Err("unknown image id".into()),
        }
    }
    let path = session.cache_path(id);
    if !path.exists() {
        return Err("not developed".into());
    }
    let (base, working, thumb) =
        crate::cache::read(&path).map_err(|e| format!("cache read: {e}"))?;
    let base_confidence = film_core::calibrate::detect_rebate_base(&working).confidence;
    let (positive, positive_confidence) = film_core::classify::classify_positive(&working);
    let d_max = film_core::calibrate::sample_dmax(&working, base, None);
    let mut images = session.images.lock().unwrap();
    if let Some(c) = images.get_mut(id) {
        if c.developed.is_none() {
            c.developed = Some(Developed {
                working,
                thumb,
                base,
                base_confidence,
                d_max,
                positive,
                positive_confidence,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn render_view(
    id: String,
    params: InvertParams,
    view: ViewSpec,
    session: State<Session>,
) -> Result<String, String> {
    let _t_resident = std::time::Instant::now(); // [TIMEDBG]
    ensure_resident(&session, &id)?;
    eprintln!("[TIMEDBG] render_view ensure_resident {:?}", _t_resident.elapsed()); // [TIMEDBG]
    let _t = std::time::Instant::now(); // [TIMEDBG]
    let images = session.images.lock().unwrap();
    eprintln!("[TIMEDBG] render_view lock {:?}", _t.elapsed()); // [TIMEDBG]
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    eprintln!(
        "[TIMEDBG] render_view working={}x{} raw={} out={}x{}",
        dev.working.width, dev.working.height, view.raw, view.out_w, view.out_h
    ); // [TIMEDBG]
    let _t_geom = std::time::Instant::now(); // [TIMEDBG]

    // Geometry: orient (lossless) → straighten → persistent crop, then the view crop.
    // Each stage borrows the previous buffer when it would be a no-op, so an
    // identity/full-frame view (e.g. the film-base picker: no rot/flip/straighten/crop)
    // skips cloning the whole working image — the dominant cost on large/Quality buffers.
    let oriented_owned;
    let oriented: &film_core::Image = if view.rot90 == 0 && !view.flip_h && !view.flip_v {
        &dev.working
    } else {
        oriented_owned = orient(&dev.working, view.rot90, view.flip_h, view.flip_v);
        &oriented_owned
    };
    let straightened_owned;
    let straightened: &film_core::Image = if view.angle.abs() < 1e-4 {
        oriented
    } else {
        straightened_owned = rotate(oriented, view.angle);
        &straightened_owned
    };
    let base_img_owned;
    let base_img: &film_core::Image = match view.image_crop {
        Some(nc) => {
            let (ix, iy, iw, ih) = crop_px(nc, straightened.width, straightened.height);
            base_img_owned = crop(straightened, ix, iy, iw, ih);
            &base_img_owned
        }
        None => straightened,
    };
    // The view crop is in oriented full-res coords → map to working px via the
    // oriented metadata width (orientation is lossless, so the ratio is preserved).
    let (ometa_w, _) = orient_dims(
        img.metadata.width as usize,
        img.metadata.height as usize,
        view.rot90,
    );
    let s_scale = oriented.width as f64 / ometa_w.max(1) as f64;
    let cx = (view.crop[0] * s_scale).max(0.0).round() as usize;
    let cy = (view.crop[1] * s_scale).max(0.0).round() as usize;
    let cw = (view.crop[2] * s_scale).round().max(1.0) as usize;
    let ch = (view.crop[3] * s_scale).round().max(1.0) as usize;
    // Whole-frame view crop (the common case — zoom/pan and pickers pass [0,0,w,h])
    // borrows base_img instead of copying it.
    let cropped_owned;
    let cropped: &film_core::Image =
        if cx == 0 && cy == 0 && cw >= base_img.width && ch >= base_img.height {
            base_img
        } else {
            cropped_owned = crop(base_img, cx, cy, cw, ch);
            &cropped_owned
        };
    if cropped.pixels.is_empty() {
        return Err("empty crop".into());
    }
    let (cw_px, ch_px) = (cropped.width, cropped.height);
    let scaled = resize_to(cropped, view.out_w.max(1), view.out_h.max(1));
    eprintln!("[TIMEDBG] render_view geom+resize {:?}", _t_geom.elapsed()); // [TIMEDBG]

    if view.raw {
        let _t_jpeg = std::time::Instant::now(); // [TIMEDBG]
        let r = to_jpeg_b64(&scaled, true, PREVIEW_JPEG_QUALITY);
        eprintln!("[TIMEDBG] render_view raw jpeg {:?}", _t_jpeg.elapsed()); // [TIMEDBG]
        return r;
    }
    let mut ip = resolve_params(&params, &dev.thumb, effective_base(&params, dev.base));
    ip.d_max = effective_dmax(&params, dev.d_max);
    let mut inv = invert_image(&scaled, &ip, mode_from(&params.mode));
    let stamps = view_stamps(
        &view.dust,
        base_img.width,
        base_img.height,
        cx,
        cy,
        cw_px,
        ch_px,
        view.out_w.max(1),
        view.out_h.max(1),
    );
    dust::apply(&mut inv, &stamps);
    if view.ir_removal.enabled {
        if let Some(ir) = scaled.ir.as_ref() {
            dust::apply_ir(&mut inv, ir, view.ir_removal.sensitivity);
        }
    }
    let out = if view.finish {
        finish_image(&inv, &finish_from(&params))
    } else {
        inv
    };
    to_jpeg_b64(&out, false, PREVIEW_JPEG_QUALITY)
}

/// Dual-render one prepared image (invert → dust → IR → finish) as SDR and HDR,
/// then mux into a gain-map JPEG. Shared by the HDR preview command and HDR export.
/// `src` carries the optional IR plane used when `ir_removal.enabled`.
fn render_and_encode_hdr(
    src: &film_core::Image,
    ip: &InversionParams,
    mode: Mode,
    finish: &FinishParams,
    stamps: &[Stamp],
    ir_removal: &IrRemoval,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let render = |ip: &InversionParams| -> film_core::Image {
        let mut inv = invert_image(src, ip, mode);
        dust::apply(&mut inv, stamps);
        if ir_removal.enabled {
            if let Some(ir) = src.ir.as_ref() {
                dust::apply_ir(&mut inv, ir, ir_removal.sensitivity);
            }
        }
        finish_image(&inv, finish)
    };
    let sdr = render(ip);
    let mut ip_hdr = ip.clone();
    ip_hdr.hdr = true;
    let hdr = render(&ip_hdr);
    crate::hdr::encode_gain_map_jpeg(&sdr, &hdr, quality)
}

/// Render the developed image (geometry + crop + develop params) as an SDR base
/// AND an HDR rendition, encode a gain-map JPEG, and return it as a data URL for
/// an `<img src>`. The SDR rendition matches `render_view`'s finished output
/// exactly (same geometry, params, dust/IR retouch, and finish); the HDR
/// rendition re-runs the same pipeline with `hdr` highlight expansion enabled.
#[tauri::command]
pub fn encode_hdr(
    id: String,
    params: InvertParams,
    view: ViewSpec,
    session: State<Session>,
) -> Result<String, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;

    // Geometry: orient (lossless) → straighten → persistent crop, then the view
    // crop — identical to `render_view`.
    let oriented = orient(&dev.working, view.rot90, view.flip_h, view.flip_v);
    let straightened = rotate(&oriented, view.angle);
    let base_img = match view.image_crop {
        Some(nc) => {
            let (ix, iy, iw, ih) = crop_px(nc, straightened.width, straightened.height);
            crop(&straightened, ix, iy, iw, ih)
        }
        None => straightened,
    };
    let (ometa_w, _) = orient_dims(
        img.metadata.width as usize,
        img.metadata.height as usize,
        view.rot90,
    );
    let s_scale = oriented.width as f64 / ometa_w.max(1) as f64;
    let cx = (view.crop[0] * s_scale).max(0.0).round() as usize;
    let cy = (view.crop[1] * s_scale).max(0.0).round() as usize;
    let cw = (view.crop[2] * s_scale).round().max(1.0) as usize;
    let ch = (view.crop[3] * s_scale).round().max(1.0) as usize;
    let cropped = crop(&base_img, cx, cy, cw, ch);
    if cropped.pixels.is_empty() {
        return Err("empty crop".into());
    }
    let (cw_px, ch_px) = (cropped.width, cropped.height);
    let scaled = resize_to(&cropped, view.out_w.max(1), view.out_h.max(1));

    // Develop params identical to `render_view`'s construction.
    let mut ip = resolve_params(&params, &dev.thumb, effective_base(&params, dev.base));
    ip.d_max = effective_dmax(&params, dev.d_max);
    let mode = mode_from(&params.mode);
    let finish = finish_from(&params);
    let stamps = view_stamps(
        &view.dust,
        base_img.width,
        base_img.height,
        cx,
        cy,
        cw_px,
        ch_px,
        view.out_w.max(1),
        view.out_h.max(1),
    );

    let jpeg = render_and_encode_hdr(&scaled, &ip, mode, &finish, &stamps, &view.ir_removal, PREVIEW_JPEG_QUALITY)?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

/// The persistent per-image edits that shape a thumbnail's geometry and retouching.
/// Mirrors the relevant `ViewSpec` fields but without the zoom/view crop — a
/// thumbnail always shows the whole (cropped) frame. All fields default so the
/// grid can request a plain develop-only thumbnail with `{}`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ThumbView {
    #[serde(default)]
    pub image_crop: Option<[f64; 4]>,
    #[serde(default)]
    pub rot90: u8,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default)]
    pub angle: f32,
    #[serde(default)]
    pub dust: Vec<DustStroke>,
    #[serde(default)]
    pub ir_removal: IrRemoval,
}

/// Render a small (~320px) inverted JPEG of the developed image at the given
/// params and persistent edits — used to live-refresh the Library grid cell and
/// filmstrip while editing. Applies orientation/straighten/crop, develop params,
/// dust strokes, and IR removal so the thumbnail matches the viewport.
#[tauri::command]
pub fn thumbnail(
    id: String,
    params: InvertParams,
    view: ThumbView,
    session: State<Session>,
) -> Result<String, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;

    // Geometry: orient (lossless) → straighten → persistent crop. No view crop —
    // the whole frame is shown, scaled to fit THUMB_EDGE.
    let oriented = orient(&dev.working, view.rot90, view.flip_h, view.flip_v);
    let straightened = rotate(&oriented, view.angle);
    let base_img = match view.image_crop {
        Some(nc) => {
            let (ix, iy, iw, ih) = crop_px(nc, straightened.width, straightened.height);
            crop(&straightened, ix, iy, iw, ih)
        }
        None => straightened,
    };
    let small = proxy(&base_img, THUMB_EDGE);
    let (ow, oh) = (small.width as u32, small.height as u32);
    let mut ip = resolve_params(&params, &dev.thumb, effective_base(&params, dev.base));
    ip.d_max = effective_dmax(&params, dev.d_max);
    let mut inv = invert_image(&small, &ip, mode_from(&params.mode));
    let stamps = view_stamps(
        &view.dust,
        base_img.width,
        base_img.height,
        0,
        0,
        base_img.width,
        base_img.height,
        ow,
        oh,
    );
    dust::apply(&mut inv, &stamps);
    if view.ir_removal.enabled {
        if let Some(ir) = small.ir.as_ref() {
            dust::apply_ir(&mut inv, ir, view.ir_removal.sensitivity);
        }
    }
    let fin = finish_image(&inv, &finish_from(&params));
    to_jpeg_b64(&fin, false, 82)
}

/// Decode the full-res file, apply geometry + inversion + dust/IR + finishing, and
/// return the finished image and its source metadata. Shared by `export_image` and
/// the upscaler so both produce identical pixels.
#[allow(clippy::too_many_arguments)]
pub(crate) fn finish_full_res(
    id: &str,
    params: &InvertParams,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    dust: &[DustStroke],
    ir_removal: &IrRemoval,
    session: &Session,
) -> Result<(film_core::Image, crate::metadata::Metadata), String> {
    ensure_resident(session, id)?;
    let (path, base, thumb, metadata, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (
            img.path.clone(),
            dev.base,
            dev.thumb.clone(),
            img.metadata.clone(),
            dev.d_max,
        )
    };
    let full = decode_any(Path::new(&path))?;
    let full = orient(&full, rot90, flip_h, flip_v);
    let full = rotate(&full, angle);
    let full = match image_crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, full.width, full.height);
            crop(&full, x, y, w, h)
        }
        None => full,
    };
    let mut ip = resolve_params(params, &thumb, effective_base(params, base));
    ip.d_max = effective_dmax(params, dev_dmax);
    let mut inv = invert_image(&full, &ip, mode_from(&params.mode));
    let stamps = export_stamps(dust, inv.width, inv.height);
    dust::apply(&mut inv, &stamps);
    if ir_removal.enabled {
        if let Some(ir) = full.ir.as_ref() {
            dust::apply_ir(&mut inv, ir, ir_removal.sensitivity);
        }
    }
    let fin = finish_image(&inv, &finish_from(params));
    Ok((fin, metadata))
}

/// Re-decode the file at full resolution and export it in the chosen format.
#[allow(clippy::too_many_arguments)] // Tauri command: flat args mirror the JS invoke contract
#[tauri::command]
pub async fn export_image(
    id: String,
    params: InvertParams,
    out_path: String,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    dust: Vec<DustStroke>,
    ir_removal: IrRemoval,
    format: ExportFormat,
    meta_override: Option<MetaOverride>,
    session: State<'_, Session>,
) -> Result<(), String> {
    let (fin, metadata) = finish_full_res(
        &id, &params, image_crop, rot90, flip_h, flip_v, angle, &dust, &ir_removal, &session,
    )?;
    let out = Path::new(&out_path);
    match format.kind.as_str() {
        "tiff" => {
            if format.bit_depth == 16 {
                film_core::export::write_tiff16(&fin, out).map_err(|e| format!("{e}"))
            } else {
                write_tiff8(&fin, out)
            }
        }
        "png" => write_png(&fin, out, format.bit_depth),
        "jpeg" => write_jpeg(&fin, out, format.quality, format.max_bytes),
        other => Err(format!("unknown export format: {other}")),
    }?;

    // Best-effort EXIF embed. The pixel file is already written and valid; a
    // metadata failure is logged but never fails the export.
    let eff = effective_metadata(&metadata, meta_override.as_ref());
    if let Err(e) = crate::exif_write::write_exif(out, &eff) {
        eprintln!("[exif] embed failed for {out_path}: {e}");
    }
    Ok(())
}

/// Export a single developed image as a gain-map HDR JPEG. Mirrors `export_image`
/// (decode full-res → orient/rotate/crop → invert+dust+IR+finish) but renders the
/// SDR base and the HDR rendition and muxes them. JPEG-only by construction; the
/// frontend only calls this when the chosen format is JPEG and the image's HDR
/// toggle is on. `format.quality` drives JPEG quality; `format.max_bytes` is not
/// applied (the gain-map encoder has no size target).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_image_hdr(
    id: String,
    params: InvertParams,
    out_path: String,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    dust: Vec<DustStroke>,
    ir_removal: IrRemoval,
    format: ExportFormat,
    meta_override: Option<MetaOverride>,
    session: State<'_, Session>,
) -> Result<(), String> {
    ensure_resident(&session, &id)?;
    let (path, base, thumb, metadata, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (
            img.path.clone(),
            dev.base,
            dev.thumb.clone(),
            img.metadata.clone(),
            dev.d_max,
        )
    };
    let full = decode_any(Path::new(&path))?;
    let full = orient(&full, rot90, flip_h, flip_v);
    let full = rotate(&full, angle);
    let full = match image_crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, full.width, full.height);
            crop(&full, x, y, w, h)
        }
        None => full,
    };

    let mut ip = resolve_params(&params, &thumb, effective_base(&params, base));
    ip.d_max = effective_dmax(&params, dev_dmax);
    let stamps = export_stamps(&dust, full.width, full.height);
    let finish = finish_from(&params);

    let bytes = render_and_encode_hdr(
        &full,
        &ip,
        mode_from(&params.mode),
        &finish,
        &stamps,
        &ir_removal,
        format.quality,
    )?;

    std::fs::write(&out_path, &bytes).map_err(|e| format!("write {out_path}: {e}"))?;

    // Best-effort EXIF embed, identical policy to export_image (never fails export).
    let eff = effective_metadata(&metadata, meta_override.as_ref());
    if let Err(e) = crate::exif_write::write_exif(Path::new(&out_path), &eff) {
        eprintln!("[exif] embed failed for {out_path}: {e}");
    }
    Ok(())
}

/// Dims + resolved inversion uniforms handed back to the frontend so it can
/// upload the baked source and render invert+finish offscreen.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportPrep {
    pub w: u32,
    pub h: u32,
    pub uniforms: ResolvedInversion,
}

/// Decode full-res, bake geometry + pre-invert heal, stash the half-float bytes,
/// and return the dims + resolved inversion uniforms. The frontend then renders
/// the GPU invert+finish offscreen and calls export_finish with the readback.
#[tauri::command]
pub fn export_begin(
    id: String,
    params: InvertParams,
    spec: BakeSpec,
    session: State<Session>,
) -> Result<ExportPrep, String> {
    ensure_resident(&session, &id)?;
    let (path, base, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (img.path.clone(), dev.base, dev.d_max)
    };
    let full = decode_any(Path::new(&path))?;
    let baked = bake_working(&full, &spec); // geometry + pre-invert heal, full-res
    let (w, h, bytes) = pack_rgba16f(&baked, u32::MAX); // no cap for export
    let mut uniforms = resolve_to_uniforms(&params, effective_base(&params, base));
    uniforms.d_max = effective_dmax(&params, dev_dmax);
    *session.pending_export.lock().unwrap() = Some(PreparedExport { w, h, bytes });
    Ok(ExportPrep { w, h, uniforms })
}

/// Return the stashed half-float bytes for upload (consumes nothing; kept until export_finish).
#[tauri::command]
pub fn export_pixels(session: State<Session>) -> Result<tauri::ipc::Response, String> {
    let guard = session.pending_export.lock().unwrap();
    let prep = guard.as_ref().ok_or("no prepared export")?;
    Ok(tauri::ipc::Response::new(prep.bytes.clone()))
}

/// `bit16 = true` → `data` is f32 RGBA (4 floats/px); else RGBA8 (4 bytes/px).
#[derive(Debug, Clone, Deserialize)]
pub struct ExportReadback {
    pub w: u32,
    pub h: u32,
    pub bit16: bool,
}

/// Build an Image from the GPU readback and encode it with the chosen format.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn export_finish(
    id: String,
    out_path: String,
    readback: ExportReadback,
    data: Vec<u8>,
    format: ExportFormat,
    meta_override: Option<MetaOverride>,
    session: State<Session>,
) -> Result<(), String> {
    let img = if readback.bit16 {
        // data is little-endian f32 RGBA
        let floats: Vec<f32> = data
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        image_from_rgba_f32(readback.w, readback.h, &floats)
    } else {
        image_from_rgba8(readback.w, readback.h, &data)
    };
    let out = Path::new(&out_path);
    match format.kind.as_str() {
        "tiff" => {
            if format.bit_depth == 16 {
                film_core::export::write_tiff16(&img, out).map_err(|e| format!("{e}"))
            } else {
                write_tiff8(&img, out)
            }
        }
        "png" => write_png(&img, out, format.bit_depth),
        "jpeg" => write_jpeg(&img, out, format.quality, format.max_bytes),
        other => Err(format!("unknown export format: {other}")),
    }?;

    // Best-effort EXIF embed, mirroring export_image. The pixel file is already
    // written and valid; a metadata failure is logged but never fails the export.
    let metadata = {
        let images = session.images.lock().unwrap();
        images.get(&id).map(|i| i.metadata.clone())
    };
    if let Some(md) = metadata {
        let eff = effective_metadata(&md, meta_override.as_ref());
        if let Err(e) = crate::exif_write::write_exif(out, &eff) {
            eprintln!("[exif] embed failed for {out_path}: {e}");
        }
    }
    *session.pending_export.lock().unwrap() = None; // release the buffer
    Ok(())
}

/// Estimated as-shot white point for the developed image, as (Kelvin, tint).
/// The UI seeds the Temp/Tint sliders with this when an image becomes active.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AsShotWb {
    pub temp: f32,
    pub tint: f32,
}

#[tauri::command]
pub fn as_shot_wb(
    id: String,
    params: InvertParams,
    crop: Option<[f64; 4]>,
    session: State<Session>,
) -> Result<AsShotWb, String> {
    ensure_resident(&session, &id)?;
    let (base, thumb, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (dev.base, dev.thumb.clone(), dev.d_max)
    };
    // Restrict the estimate to the image area so borders/rebate don't bias WB.
    let thumb = match crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, thumb.width, thumb.height);
            crate::convert::crop(&thumb, x, y, w, h)
        }
        None => thumb,
    };
    // Estimate WB against the user's ACTUAL stock/mode so the gains neutralise the
    // colour space the image is actually rendered in. `build_params` leaves `wb` at
    // [1,1,1], so the estimate is independent of any temp/tint already on the sliders.
    let mut ip = build_params(&params, effective_base(&params, base));
    ip.d_max = effective_dmax(&params, dev_dmax);
    let first = invert_image(&thumb, &ip, mode_from(&params.mode));
    let gains = auto_wb_gains(&first);
    let (temp, tint) = gains_to_cct(gains);
    Ok(AsShotWb {
        temp,
        tint: tint * 150.0,
    }) // back to UI −150..150
}

/// (Kelvin, gains_to_cct tint) that makes a sampled display pixel `rgb` render neutral.
/// `rgb` is the displayed positive at the clicked point, encoded by the active mode's
/// output power. We undo that encode and divide out the current WB to recover the
/// WB-neutral linear inverted value `P` at the point, then take gray-world gains of `P`
/// — the same convention as `as_shot_wb`, so a gray-point pick is consistent with Auto.
/// Unlike Auto it is UNDAMPED: a deliberate gray click should land the point exactly
/// neutral. The result is absolute — the current Temp/Tint cancels (it is baked into the
/// sampled pixel and divided back out), so clicking always means "make this point gray".
fn gray_point_temp_tint(params: &InvertParams, rgb: [f32; 3]) -> (f32, f32) {
    let ip = build_params(params, [1.0, 1.0, 1.0]);
    // The power applied last to the positive: paper_grade for Cineon (Mode D), else gamma.
    let e = (if params.mode == "d" { ip.paper_grade } else { ip.gamma }).max(1e-3);
    let wb_old = wb_from_params(params.temp, params.tint);
    // displayed d_c = (P_c · wb_old_c)^e  ⇒  P_c = d_c^(1/e) / wb_old_c
    let p: [f32; 3] = std::array::from_fn(|c| rgb[c].max(1e-5).powf(1.0 / e) / wb_old[c].max(1e-5));
    let gray = (p[0] + p[1] + p[2]) / 3.0;
    let gains = [
        gray / p[0].max(1e-5),
        gray / p[1].max(1e-5),
        gray / p[2].max(1e-5),
    ];
    gains_to_cct(gains)
}

/// Temp/Tint that neutralises a clicked gray point. `rgb` is the displayed positive
/// sampled at the click. See [`gray_point_temp_tint`].
#[tauri::command]
pub fn gray_point_wb(params: InvertParams, rgb: [f32; 3]) -> AsShotWb {
    let (temp, tint) = gray_point_temp_tint(&params, rgb);
    AsShotWb {
        temp,
        tint: tint * 150.0,
    } // back to UI −150..150
}

/// Load the whole catalog at launch: return the snapshot to the frontend AND
/// repopulate the in-memory Session with lightweight (undeveloped) records so
/// `develop_image`/`render_view` can find each image by id.
#[tauri::command]
pub fn load_catalog(
    session: State<Session>,
    catalog: State<crate::catalog::Catalog>,
) -> Result<crate::catalog::CatalogSnapshot, String> {
    let mut snap = catalog
        .snapshot(&|p| Path::new(p).exists())
        .map_err(|e| e.to_string())?;

    // Annotate each image with cache presence (cheap stat) before sending to frontend.
    for ci in &mut snap.images {
        let cache_path = session.cache_path(&ci.id);
        ci.developed = cache_path.exists();
        ci.has_ir = if ci.developed {
            crate::cache::read_has_ir(&cache_path).unwrap_or(false)
        } else {
            false
        };
    }

    let mut imgs = session.images.lock().unwrap();
    imgs.clear();
    for ci in &snap.images {
        let metadata = serde_json::from_value(ci.metadata.clone()).unwrap_or_default();
        imgs.insert(
            ci.id.clone(),
            CachedImage {
                path: ci.path.clone(),
                file_name: ci.file_name.clone(),
                metadata,
                thumbnail: ci.thumbnail.clone(),
                developed: None, // lazy: ensure_resident loads on first view
            },
        );
    }
    Ok(snap)
}

#[tauri::command]
pub fn save_edits(
    id: String,
    params_json: String,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog
        .save_params(&id, &params_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_crop(
    id: String,
    crop_json: String,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog
        .save_crop(&id, &crop_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_dust(
    id: String,
    dust_json: String,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog
        .save_dust(&id, &dust_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_meta(
    id: String,
    meta_json: String,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog
        .save_meta(&id, &meta_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_pref(
    key: String,
    value: String,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog.save_pref(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_app_state(
    key: String,
    value: String,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog
        .save_app_state(&key, &value)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkingInfo {
    /// Capped dimensions of the float texture working_pixels will return.
    pub w: u32,
    pub h: u32,
}

/// Dimensions of the GPU float texture for this image (after the MAX_GPU_EDGE cap).
#[tauri::command]
pub fn working_info(id: String, session: State<Session>) -> Result<WorkingInfo, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let (w, h) = capped_dims(&dev.working, MAX_GPU_EDGE);
    Ok(WorkingInfo { w, h })
}

/// Raw half-float RGBA bytes of the linear working image (pre-inversion), for a
/// one-shot WebGL2 RGBA16F upload. Returned as raw IPC bytes (no base64/JPEG).
#[tauri::command]
pub fn working_pixels(id: String, session: State<Session>) -> Result<tauri::ipc::Response, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let (_, _, bytes) = pack_rgba16f(&dev.working, MAX_GPU_EDGE);
    Ok(tauri::ipc::Response::new(bytes))
}

/// Capped dims of the BAKED (geometry + heal) working texture.
#[tauri::command]
pub fn working_baked_info(
    id: String,
    spec: BakeSpec,
    session: State<Session>,
) -> Result<WorkingInfo, String> {
    ensure_resident(&session, &id)?;
    let working = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        img.developed
            .as_ref()
            .ok_or("not developed")?
            .working
            .clone()
    };
    let geom = bake_geometry(&working, &spec); // geometry only — exact dims, no Telea heal
    let (w, h) = capped_dims(&geom, MAX_GPU_EDGE);
    Ok(WorkingInfo { w, h })
}

/// Full-frame defect `Mask` (x0=y0=0) covering the brush `stamps` — used to feed
/// the MI-GAN inpainter, which expects a whole-frame mask.
fn full_mask_from_stamps(w: usize, h: usize, stamps: &[Stamp]) -> film_core::dust::Mask {
    let m = film_core::dust::rasterize(w, h, stamps, film_core::dust::GROW, 0);
    if m.w == 0 || m.h == 0 {
        return film_core::dust::Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
    }
    let mut bits = vec![false; w * h];
    for yy in 0..m.h {
        for xx in 0..m.w {
            if m.bits[yy * m.w + xx] {
                bits[(m.y0 + yy) * w + (m.x0 + xx)] = true;
            }
        }
    }
    film_core::dust::Mask { x0: 0, y0: 0, w, h, bits }
}

/// Build the auto-dust defect mask for a baked NEGATIVE working image: invert to
/// a positive, run the detector (reusing `cached` prob if its dims match, else
/// run once), and threshold at `sensitivity`. Returns the whole-frame mask plus
/// the prob map to cache when freshly computed. Detector failure → empty mask.
fn auto_dust_mask(
    app_data: &Path,
    baked: &film_core::Image,
    ip: &InversionParams,
    mode: Mode,
    sensitivity: f32,
    cached: Option<(usize, usize, Vec<f32>)>,
) -> (film_core::dust::Mask, Option<(usize, usize, Vec<f32>)>) {
    let (w, h) = (baked.width, baked.height);
    let empty = film_core::dust::Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
    // Positive image the detector expects (no finishing layer needed).
    let positive = invert_image(baked, ip, mode);
    let (prob, fresh) = match cached {
        Some((cw, ch, p)) if (cw, ch) == (w, h) && p.len() == w * h => (p, None),
        _ => match crate::autodust::engine::detect(app_data, &positive) {
            Ok(p) => (p.clone(), Some((w, h, p))),
            Err(_) => return (empty, None),
        },
    };
    let max_blob = (crate::autodust::MAX_BLOB * w.max(h) / 2000).max(1);
    let mask = film_core::dust::prob_defect_mask(w, h, &prob, sensitivity, max_blob);
    (mask, fresh)
}

/// OR two whole-frame masks (`x0=y0=0`, same `w,h`). An empty side (`w==0`)
/// yields the other; used to merge the auto-dust defect mask with brush strokes.
fn union_mask(mut a: film_core::dust::Mask, b: &film_core::dust::Mask) -> film_core::dust::Mask {
    if a.w == 0 || a.h == 0 {
        return b.clone();
    }
    if b.w == 0 || b.h == 0 || a.bits.len() != b.bits.len() {
        return a;
    }
    for (av, bv) in a.bits.iter_mut().zip(b.bits.iter()) {
        *av = *av || *bv;
    }
    a
}

/// Count connected components (4-neighbour) of set pixels in a whole-frame mask —
/// i.e. the number of distinct dust/defect spots, for the "N dust spots removed"
/// toast. Empty mask → 0.
fn count_blobs(mask: &film_core::dust::Mask) -> u32 {
    let (w, h) = (mask.w, mask.h);
    if w == 0 || h == 0 {
        return 0;
    }
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut blobs = 0u32;
    for start in 0..w * h {
        if !mask.bits[start] || seen[start] {
            continue;
        }
        blobs += 1;
        seen[start] = true;
        stack.push(start);
        while let Some(p) = stack.pop() {
            let (x, y) = (p % w, p / w);
            let mut push = |q: usize, seen: &mut Vec<bool>, stack: &mut Vec<usize>| {
                if mask.bits[q] && !seen[q] {
                    seen[q] = true;
                    stack.push(q);
                }
            };
            if x > 0 { push(p - 1, &mut seen, &mut stack); }
            if x + 1 < w { push(p + 1, &mut seen, &mut stack); }
            if y > 0 { push(p - w, &mut seen, &mut stack); }
            if y + 1 < h { push(p + w, &mut seen, &mut stack); }
        }
    }
    blobs
}

/// Heal an already-geometry-baked working buffer: dust strokes per the spec's
/// mode (classic Telea, MI-GAN, or skipped for the AI-mask overlay), unioned with
/// the optional auto-dust defect `auto_mask`, then IR. When `auto_mask` is present
/// (or `spec.migan`) and the model is installed, the combined mask is MI-GAN
/// healed; otherwise strokes fall back to the classic Telea fill.
fn bake_for_view_from_baked(
    app_data: &Path,
    mut img: film_core::Image,
    spec: &BakeSpec,
    auto_mask: Option<&film_core::dust::Mask>,
) -> film_core::Image {
    let stamps = export_stamps(&spec.dust, img.width, img.height);
    let want_migan =
        (spec.migan || auto_mask.is_some()) && crate::autodust::assets::installed(app_data);
    if want_migan {
        // Brush strokes (unless in mask-overlay mode) ∪ the auto-dust defect mask.
        let stroke_mask = if spec.skip_dust_heal {
            film_core::dust::Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() }
        } else {
            full_mask_from_stamps(img.width, img.height, &stamps)
        };
        let mut mask = stroke_mask;
        if let Some(am) = auto_mask {
            mask = union_mask(mask, am);
        }
        if mask.bits.iter().any(|&b| b) {
            let _ = crate::autodust::engine::inpaint(app_data, &mut img, &mask);
        }
    } else if !spec.skip_dust_heal {
        film_core::dust::apply(&mut img, &stamps);
    }
    if spec.ir_removal.enabled {
        if let Some(ir) = img.ir.clone() {
            film_core::dust::apply_ir(&mut img, &ir, spec.ir_removal.sensitivity);
        }
    }
    img
}

/// Half-float RGBA bytes of the BAKED working buffer (geometry applied, dust/IR
/// healed pre-invert), for a one-shot RGBA16F upload. GPU then inverts with
/// IDENTITY geometry.
#[tauri::command]
pub async fn working_baked_pixels(
    app: tauri::AppHandle,
    id: String,
    params: InvertParams,
    spec: BakeSpec,
    session: State<'_, Session>,
) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    ensure_resident(&session, &id)?;
    let (working, ip, mode) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        let mut ip = resolve_params(&params, &dev.thumb, effective_base(&params, dev.base));
        ip.d_max = effective_dmax(&params, dev.d_max);
        (dev.working.clone(), ip, mode_from(&params.mode))
    };
    let cached = if spec.auto_dust.enabled {
        session.autodust_prob.lock().unwrap().get(&id).cloned()
    } else {
        None
    };
    let do_auto = spec.auto_dust.enabled;
    let sens = spec.auto_dust.sensitivity;
    // The heal can run the detector + MI-GAN (seconds) — keep it off the main
    // thread so the UI (and the WKWebView, which shares the main thread on macOS)
    // stays responsive. Returns any freshly computed prob map to cache.
    let (bytes, fresh, blobs) = tauri::async_runtime::spawn_blocking(move || {
        let baked = bake_geometry(&working, &spec);
        let (auto_mask, fresh) = if do_auto && crate::autodust::assets::installed(&app_data) {
            let (m, fr) = auto_dust_mask(&app_data, &baked, &ip, mode, sens, cached);
            (Some(m), fr)
        } else {
            (None, None)
        };
        // Distinct dust spots removed (for the completion toast) — only when auto-dust ran.
        let blobs = auto_mask.as_ref().map(count_blobs);
        let healed = bake_for_view_from_baked(&app_data, baked, &spec, auto_mask.as_ref());
        let (_, _, bytes) = pack_rgba16f(&healed, MAX_GPU_EDGE);
        (bytes, fresh, blobs)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(p) = fresh {
        session.autodust_prob.lock().unwrap().insert(id, p);
    }
    if let Some(n) = blobs {
        use tauri::Emitter;
        let _ = app.emit("autodust://result", serde_json::json!({ "count": n }));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Resolve inversion params (+ this image's sampled base) into GPU uniforms.
#[tauri::command]
pub fn resolved_inversion(
    id: String,
    params: InvertParams,
    session: State<Session>,
) -> Result<ResolvedInversion, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let mut u = resolve_to_uniforms(&params, effective_base(&params, dev.base));
    u.d_max = effective_dmax(&params, dev.d_max);
    Ok(u)
}

/// Sample the orange-mask base from a normalized rect [x,y,w,h] (0..1) over the
/// resident working image. Used by the base-picker tool; cheap, no re-decode.
#[tauri::command]
pub fn sample_base_at(
    id: String,
    rect: [f64; 4],
    session: State<Session>,
) -> Result<[f32; 3], String> {
    use film_core::calibrate::Rect;
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let (x, y, w, h) = crop_px(rect, dev.working.width, dev.working.height);
    use film_core::calibrate::{sample_base_coherent, BASE_BAND_REBATE};
    let (lo, hi) = BASE_BAND_REBATE;
    Ok(sample_base_coherent(
        &dev.working,
        Some(Rect { x, y, w, h }),
        lo,
        hi,
    ))
}

/// The active per-image AUTO base (the develop-time detected/fallback film base) and
/// its detector confidence — so the UI can show what's in use and flag low confidence.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AutoBaseInfo {
    pub base: [f32; 3],
    pub confidence: f32,
}

#[tauri::command]
pub fn auto_base_info(id: String, session: State<Session>) -> Result<AutoBaseInfo, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    Ok(AutoBaseInfo { base: dev.base, confidence: dev.base_confidence })
}

/// Result of `analyze`: the auto-derived Cineon black point for the image area.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Analysis {
    pub d_max: f32,
}

/// Auto-derive `D_max` from the IMAGE AREA (the persistent crop, normalized
/// [x,y,w,h] 0..1 in working space). Excluding the borders is the whole point —
/// black surround / rebate would otherwise inflate the density range and wash the
/// image out (GitHub issue #1). `crop = None` analyzes the whole frame.
#[tauri::command]
pub fn analyze(
    id: String,
    params: InvertParams,
    crop: Option<[f64; 4]>,
    session: State<Session>,
) -> Result<Analysis, String> {
    use film_core::calibrate::{sample_dmax, Rect};
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let base = effective_base(&params, dev.base);
    let rect = crop.map(|nc| {
        let (x, y, w, h) = crop_px(nc, dev.working.width, dev.working.height);
        Rect { x, y, w, h }
    });
    Ok(Analysis {
        d_max: sample_dmax(&dev.working, base, rect),
    })
}

/// Anchor D_max to a measured white-point: sample the exposed leader from a
/// normalized rect [x,y,w,h] (0..1) over the resident working image and return the
/// scalar D_max. The frontend stores this in `d_max_override` (same as `analyze`),
/// so it overrides the per-frame scene estimate for this image.
#[tauri::command]
pub fn analyze_white_point(
    id: String,
    params: InvertParams,
    rect: [f64; 4],
    session: State<Session>,
) -> Result<Analysis, String> {
    use film_core::calibrate::{dmax_from_white_point, Rect};
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let base = effective_base(&params, dev.base);
    let (x, y, w, h) = crop_px(rect, dev.working.width, dev.working.height);
    Ok(Analysis {
        d_max: dmax_from_white_point(&dev.working, base, Some(Rect { x, y, w, h })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_mask_ors_full_frame_bits() {
        use film_core::dust::Mask;
        let a = Mask { x0: 0, y0: 0, w: 2, h: 1, bits: vec![true, false] };
        let b = Mask { x0: 0, y0: 0, w: 2, h: 1, bits: vec![false, true] };
        let u = super::union_mask(a, &b);
        assert_eq!(u.bits, vec![true, true]);
    }

    #[test]
    fn union_mask_with_empty_returns_other() {
        use film_core::dust::Mask;
        let a = Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
        let b = Mask { x0: 0, y0: 0, w: 2, h: 1, bits: vec![true, false] };
        assert_eq!(super::union_mask(a, &b).bits, vec![true, false]);
    }

    #[test]
    fn white_point_dmax_matches_engine() {
        use film_core::calibrate::dmax_from_white_point;
        let white = [0.08f32, 0.008, 0.08];
        let img = film_core::Image { width: 4, height: 4, pixels: vec![white; 16], ir: None };
        let d = dmax_from_white_point(&img, [0.8, 0.8, 0.8], None);
        assert!((d - 2.0).abs() < 1e-3);
    }

    #[test]
    fn default_params_use_cineon_mode() {
        assert_eq!(default_invert_params().mode, "d");
    }

    #[test]
    fn mode_from_is_always_cineon() {
        use film_core::engine::Mode;
        for s in ["b", "c", "d", "naive", "anything"] {
            assert_eq!(mode_from(s), Mode::D, "mode {s} must resolve to Cineon");
        }
    }

    #[test]
    fn gray_point_wb_neutral_sample_is_neutral() {
        // A neutral display pixel with neutral current WB → ~neutral white point.
        let mut p = crate::commands_test_support::sample_invert_params();
        p.mode = "d".into();
        p.temp = 5500.0;
        p.tint = 0.0;
        let (temp, tint) = gray_point_temp_tint(&p, [0.5, 0.5, 0.5]);
        assert!((temp - 5500.0).abs() < 200.0, "neutral temp, got {temp}");
        assert!(tint.abs() < 0.05, "neutral tint, got {tint}");
    }

    #[test]
    fn gray_point_wb_warm_sample_cools_temp() {
        // A warm (red-heavy, blue-low) display pixel must drive Temp BELOW neutral so
        // the applied gains cool the point toward gray. Absolute: independent of where
        // Temp currently sits (start it warm and confirm the pick still cools).
        let mut p = crate::commands_test_support::sample_invert_params();
        p.mode = "d".into();
        p.temp = 7000.0;
        p.tint = 0.0;
        let (temp, _tint) = gray_point_temp_tint(&p, [0.6, 0.5, 0.4]);
        assert!(temp < 5500.0, "warm point should cool temp below neutral, got {temp}");
    }

    #[test]
    fn effective_base_prefers_override_then_dev_base() {
        let mut p = crate::commands_test_support::sample_invert_params();
        p.base_override = None;
        assert_eq!(
            effective_base(&p, [0.8, 0.6, 0.4]),
            [0.8, 0.6, 0.4],
            "None -> dev base"
        );
        p.base_override = Some([0.1, 0.2, 0.3]);
        assert_eq!(
            effective_base(&p, [0.8, 0.6, 0.4]),
            [0.1, 0.2, 0.3],
            "Some -> override"
        );
    }

    #[test]
    fn auto_base_prefers_detected_rebate_else_fallback() {
        use film_core::Image;
        let mut img = Image::new(200, 150);
        let (bw, bh) = (20usize, 15usize);
        for y in 0..150 {
            for x in 0..200 {
                let edge = x < bw || x >= 200 - bw || y < bh || y >= 150 - bh;
                img.pixels[y * 200 + x] = if edge { [0.42, 0.19, 0.10] } else { [0.5, 0.5, 0.5] };
            }
        }
        let (base, conf) = auto_base(&img);
        assert!(conf >= film_core::calibrate::REBATE_CONFIDENCE, "should be confident: {conf}");
        assert!((base[0] - 0.42).abs() < 0.04 && base[0] > base[2], "detected orange: {base:?}");

        let grey = Image { width: 64, height: 64, pixels: vec![[0.5, 0.5, 0.5]; 64 * 64], ir: None };
        let (fb, fconf) = auto_base(&grey);
        assert!(fconf < film_core::calibrate::REBATE_CONFIDENCE, "fallback path: {fconf}");
        let (lo, hi) = film_core::calibrate::BASE_BAND_AUTO;
        let want = film_core::calibrate::sample_base_coherent(&grey, None, lo, hi);
        for c in 0..3 {
            assert!((fb[c] - want[c]).abs() < 1e-4, "ch {c}: {} vs {}", fb[c], want[c]);
        }
    }

    #[test]
    fn auto_base_anti_blue_prefers_dim_orange_edge_over_blue_fallback() {
        use film_core::Image;
        // The mixed-roll "Phoenix" case: a bright blue scene (the brightest-cluster
        // fallback would pick it, B>R) with only a DIM orange rebate at the edges
        // (low detector confidence). auto_base must still return an orange base.
        let (w, h) = (200usize, 150usize);
        let mut img = Image::new(w, h);
        let (bw, bh) = (20usize, 15usize);
        for y in 0..h {
            for x in 0..w {
                let edge = x < bw || x >= w - bw || y < bh || y >= h - bh;
                img.pixels[y * w + x] = if edge { [0.16, 0.11, 0.06] } else { [0.30, 0.22, 0.62] };
            }
        }
        // Precondition: the brightest-cluster fallback alone is blue (B>R).
        let (lo, hi) = film_core::calibrate::BASE_BAND_AUTO;
        let fb = film_core::calibrate::sample_base_coherent(&img, None, lo, hi);
        assert!(fb[2] > fb[0], "precondition: fallback is blue {fb:?}");
        // And the dim rebate is below the confident threshold (exercises anti-blue).
        let (base, conf) = auto_base(&img);
        assert!(conf < film_core::calibrate::REBATE_CONFIDENCE, "should be low-confidence: {conf}");
        assert!(base[0] > base[2], "anti-blue: must pick the orange edge, got {base:?}");
    }

    #[test]
    fn auto_base_anti_blue_ignores_near_black_orange_edge() {
        use film_core::Image;
        // No real rebate: a near-black (noise-level) orange-ordered edge over a bright
        // blue scene. The brightness floor must reject the near-black patch so we fall
        // back rather than invert against a garbage ~0.02 dmin.
        let (w, h) = (200usize, 150usize);
        let mut img = Image::new(w, h);
        let (bw, bh) = (20usize, 15usize);
        for y in 0..h {
            for x in 0..w {
                let edge = x < bw || x >= w - bw || y < bh || y >= h - bh;
                img.pixels[y * w + x] = if edge { [0.03, 0.02, 0.015] } else { [0.30, 0.22, 0.62] };
            }
        }
        let (base, _conf) = auto_base(&img);
        assert!(base[2] > base[0], "near-black edge must not be used as base: {base:?}");
    }

    #[test]
    fn build_params_is_always_cineon_regardless_of_mode_or_stock() {
        use crate::commands_test_support::sample_invert_params;
        // Even with the legacy Mode-B + Portra selection, we now build Cineon params:
        // identity matrices, d_max at the default, exposure → print_exposure (2^ev).
        let mut p = sample_invert_params();
        p.mode = "b".into();
        p.stock = "portra400".into();
        p.exposure = 1.0; // 1 EV → 2.0x print exposure
        let ip = build_params(&p, [0.8, 0.6, 0.4]);
        assert_eq!(ip.base, [0.8, 0.6, 0.4]);
        assert!((ip.print_exposure - 2.0).abs() < 1e-5, "exposure → print_exposure");
        assert!((ip.d_max - 1.5).abs() < 1e-6, "d_max default");
        assert!((ip.paper_grade - 0.95).abs() < 1e-6, "paper_grade default");
        // Identity m_post == no per-stock cross-channel matrix (nalgebra isn't a
        // direct dep of this crate, so compare against the engine default's identity).
        assert_eq!(ip.m_post, InversionParams::default().m_post, "no stock matrix");
    }

    #[test]
    fn build_params_honors_d_max_override() {
        use crate::commands_test_support::sample_invert_params;
        let mut p = sample_invert_params();
        p.d_max_override = None;
        assert!((build_params(&p, [0.8, 0.6, 0.4]).d_max - 1.5).abs() < 1e-6, "default 1.5");
        p.d_max_override = Some(2.7);
        assert!((build_params(&p, [0.8, 0.6, 0.4]).d_max - 2.7).abs() < 1e-6, "override used");
    }

    #[test]
    fn viewspec_finish_defaults_true_and_parses_false() {
        let d: ViewSpec =
            serde_json::from_str(r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false}"#)
                .unwrap();
        assert!(d.finish, "finish should default to true when omitted");
        let f: ViewSpec = serde_json::from_str(
            r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false,"finish":false}"#,
        )
        .unwrap();
        assert!(!f.finish);
    }

    #[test]
    fn crop_px_maps_and_clamps_normalized_rect() {
        assert_eq!(crop_px([0.0, 0.0, 1.0, 1.0], 100, 80), (0, 0, 100, 80));
        assert_eq!(crop_px([0.25, 0.25, 0.5, 0.5], 100, 80), (25, 20, 50, 40));
        let (x, y, w, h) = crop_px([0.9, 0.9, 0.5, 0.5], 100, 80);
        assert!(x < 100 && y < 80 && w >= 1 && h >= 1 && x + w <= 100 && y + h <= 80);
    }

    #[test]
    fn wb_from_params_directions() {
        let warm = wb_from_params(3000.0, 0.0);
        let cool = wb_from_params(9000.0, 0.0);
        assert!(warm[0] < cool[0], "warm should cut red vs cool");
        // wb_from_kelvin normalises green to 1.0; negative tint (green cast)
        // suppresses R and B relative to G, i.e. R < 1 at neutral temp.
        let green = wb_from_params(5500.0, -150.0);
        assert!(
            green[0] < 1.0,
            "negative tint suppresses red relative to green"
        );
        assert!(
            green[2] < 1.0,
            "negative tint suppresses blue relative to green"
        );
    }

    #[test]
    fn viewspec_dust_defaults_empty_and_parses_points() {
        let d: ViewSpec =
            serde_json::from_str(r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false}"#)
                .unwrap();
        assert!(d.dust.is_empty(), "dust defaults to empty when omitted");
        let p: ViewSpec = serde_json::from_str(
            r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false,
                "dust":[{"points":[[0.5,0.5],[0.6,0.5]],"r":0.02}]}"#,
        )
        .unwrap();
        assert_eq!(p.dust.len(), 1);
        assert_eq!(p.dust[0].points.len(), 2);
    }

    #[test]
    fn view_stamps_maps_normalized_points_to_output_pixels() {
        // base image 200x100; view crop = whole base; output 400x200 (2x).
        let dust = vec![DustStroke {
            points: vec![[0.5, 0.5]],
            r: 0.01,
        }];
        let s = view_stamps(&dust, 200, 100, 0, 0, 200, 100, 400, 200);
        assert_eq!(s.len(), 1);
        assert!((s[0].cx - 200.0).abs() < 0.5, "x: 0.5*200*2 = 200");
        assert!((s[0].cy - 100.0).abs() < 0.5, "y: 0.5*100*2 = 100");
        // r normalized to base width: 0.01*200 = 2 base px → *2 scale = 4 out px.
        assert!(
            (s[0].r - 4.0).abs() < 0.5,
            "r mapped to output px, got {}",
            s[0].r
        );
    }

    #[test]
    fn export_stamps_maps_normalized_points_to_full_res_pixels() {
        let dust = vec![DustStroke {
            points: vec![[0.25, 0.5]],
            r: 0.01,
        }];
        let s = export_stamps(&dust, 400, 200);
        assert_eq!(s.len(), 1);
        assert!((s[0].cx - 100.0).abs() < 0.5, "0.25*400");
        assert!((s[0].cy - 100.0).abs() < 0.5, "0.5*200");
        assert!((s[0].r - 4.0).abs() < 0.5, "0.01*400");
    }

    #[test]
    fn sample_base_at_maps_normalized_rect_to_region() {
        use film_core::calibrate::{sample_base, Rect};
        // 4x4 image: left half bright [0.9,...], right half dark [0.1,...].
        let mut pixels = vec![[0.1f32; 3]; 16];
        for y in 0..4 {
            for x in 0..2 {
                pixels[y * 4 + x] = [0.9, 0.9, 0.9];
            }
        }
        let img = film_core::Image {
            width: 4,
            height: 4,
            pixels,
            ir: None,
        };
        // Normalized rect over the left half -> bright base.
        let (x, y, w, h) = crop_px([0.0, 0.0, 0.5, 1.0], img.width, img.height);
        let base = sample_base(&img, Some(Rect { x, y, w, h }));
        assert!(
            base[0] >= 0.85,
            "left-half base should be bright, got {base:?}"
        );
    }

    #[test]
    fn viewspec_ir_removal_defaults_off_and_parses() {
        let d: ViewSpec =
            serde_json::from_str(r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false}"#)
                .unwrap();
        assert!(!d.ir_removal.enabled, "ir_removal defaults disabled");
        let p: ViewSpec = serde_json::from_str(
            r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false,
                "ir_removal":{"enabled":true,"sensitivity":60}}"#,
        )
        .unwrap();
        assert!(p.ir_removal.enabled);
        assert!((p.ir_removal.sensitivity - 60.0).abs() < 1e-6);
    }

    #[test]
    fn render_and_encode_hdr_emits_gain_map() {
        use crate::commands_test_support::sample_invert_params;
        let src = film_core::Image {
            width: 8,
            height: 8,
            pixels: vec![[0.6, 0.4, 0.25]; 64],
            ir: None,
        };
        let params = sample_invert_params();
        let ip = resolve_params(&params, &src, effective_base(&params, [0.6, 0.4, 0.25]));
        let finish = finish_from(&params);
        let bytes = render_and_encode_hdr(
            &src,
            &ip,
            mode_from(&params.mode),
            &finish,
            &[],
            &IrRemoval { enabled: false, sensitivity: 50.0 },
            90,
        )
        .expect("encode");
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "not a JPEG");
        let iso = b"urn:iso";
        let apple = b"hdrgainmap";
        assert!(
            bytes.windows(iso.len()).any(|w| w == iso)
                || bytes.windows(apple.len()).any(|w| w == apple),
            "no gain map"
        );
    }
}

#[cfg(test)]
mod adequacy_tests {
    use super::working_satisfies;

    #[test]
    fn performance_cache_buffer_is_always_adequate() {
        // native 6000px, buffer capped at 4096 (cache tier), Performance cap 4096
        assert!(working_satisfies(4096, 6000, 4096));
    }

    #[test]
    fn quality_needs_full_res_when_native_exceeds_cache() {
        // native 6000px, only 4096 resident, Quality cap = u32::MAX → inadequate
        assert!(!working_satisfies(4096, 6000, u32::MAX));
    }

    #[test]
    fn quality_satisfied_when_native_small() {
        // native 3000px (< cache cap), buffer 3000, Quality cap = u32::MAX → adequate
        assert!(working_satisfies(3000, 3000, u32::MAX));
    }

    #[test]
    fn quality_satisfied_when_full_res_resident() {
        // native 6000px, full-res 6000 resident, Quality → adequate
        assert!(working_satisfies(6000, 6000, u32::MAX));
    }
}

/// Enhance the current developed preview via the configured AI provider.
/// `image_base64` is the preview JPEG payload WITHOUT the `data:` URL prefix.
/// Returns a PNG data URL on success, or a readable error string.
#[tauri::command]
pub async fn ai_enhance_image(image_base64: String, api_key: String) -> Result<String, String> {
    crate::ai_enhance::enhance(&image_base64, &api_key).await
}

/// Match the current image's color toning to a reference image (fully local).
/// Returns the scoped develop params, blended by `strength` (0..100) from the
/// current params toward the optimized match. The frontend spreads these onto
/// the params store as a single undoable change.
#[tauri::command]
pub fn color_match_params(
    id: String,
    params: InvertParams,
    ref_path: String,
    strength: u8,
    session: State<Session>,
) -> Result<crate::color_match::MatchedParams, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    crate::color_match::match_to_reference(
        &params, &dev.thumb, dev.base, dev.d_max, &ref_path, strength,
    )
}

/// Decode a user-picked reference image and return a small base64 JPEG data URL
/// for the panel thumbnail (the app doesn't enable the `asset://` protocol).
#[tauri::command]
pub fn reference_thumb(path: String) -> Result<String, String> {
    crate::color_match::reference_thumb_data_url(&path)
}

/// Whether the AI-dust models (+ shared runtime) are installed, and download size.
#[tauri::command]
pub fn autodust_status(app: tauri::AppHandle) -> Result<crate::autodust::assets::Status, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::autodust::assets::status(&app_data))
}

/// Download + verify the AI-dust assets, emitting `autodust://download-progress`.
#[tauri::command]
pub async fn download_autodust(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::autodust::assets::download(&app, &app_data).await
}

/// Whether the upscaler runtime+model are installed, and the download size.
#[tauri::command]
pub fn upscaler_status(app: tauri::AppHandle) -> Result<crate::upscale::assets::Status, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::upscale::assets::status(&app_data))
}

/// Download + verify the upscaler assets, emitting `upscale://download-progress`.
#[tauri::command]
pub async fn download_upscaler(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::upscale::assets::download(&app, &app_data).await
}

/// Decode encoded image bytes (PNG/JPEG/etc.) into a film_core::Image with RGB
/// values in [0,1]. Used to upscale an externally-produced image (e.g. the
/// AI-enhanced PNG) that isn't one of our developed source files.
fn image_from_encoded(bytes: &[u8]) -> Result<film_core::Image, String> {
    let dynimg = image::load_from_memory(bytes).map_err(|e| format!("decode image: {e}"))?;
    let rgb = dynimg.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let pixels = rgb
        .pixels()
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    Ok(film_core::Image { width: w, height: h, pixels, ir: None })
}

/// Upscale the current developed image; stash full-res, return a preview.
/// Emits `upscale://progress` ({ done, total }) per tile.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn upscale_image(
    app: tauri::AppHandle,
    id: String,
    params: InvertParams,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    target_long: u32,
    dust: Vec<DustStroke>,
    ir_removal: IrRemoval,
    session: State<'_, Session>,
) -> Result<crate::upscale::UpscaleResult, String> {
    use tauri::{Emitter, Manager};
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (fin, metadata) = finish_full_res(
        &id, &params, image_crop, rot90, flip_h, flip_v, angle, &dust, &ir_removal, &session,
    )?;
    let up = crate::upscale::run(&app_data, &fin, target_long, |done, total| {
        let _ = app.emit("upscale://progress", serde_json::json!({ "done": done, "total": total }));
    })?;
    let (out_w, out_h) = (up.width as u32, up.height as u32);
    let preview = crate::convert::proxy(&up, 1600);
    let jpeg = crate::encode::encode_jpeg_bytes(&preview, 85)?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    let preview_data_url = format!("data:image/jpeg;base64,{b64}");
    *session.pending_upscale.lock().unwrap() =
        Some(crate::session::PendingUpscale { image: up, metadata });
    Ok(crate::upscale::UpscaleResult { preview_data_url, out_w, out_h })
}

/// Upscale an externally-produced image (base64-encoded PNG/JPEG, e.g. the AI
/// Enhance result) to `target_long` on the longest side. Stashes the full-res
/// result for `save_upscaled`; returns a preview. Emits `upscale://progress`.
#[tauri::command]
pub async fn upscale_enhanced(
    app: tauri::AppHandle,
    image_base64: String,
    target_long: u32,
    session: State<'_, Session>,
) -> Result<crate::upscale::UpscaleResult, String> {
    use base64::Engine;
    use tauri::{Emitter, Manager};
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.trim())
        .map_err(|e| format!("decode base64: {e}"))?;
    let img = image_from_encoded(&bytes)?;
    let up = crate::upscale::run(&app_data, &img, target_long, |done, total| {
        let _ = app.emit("upscale://progress", serde_json::json!({ "done": done, "total": total }));
    })?;
    let (out_w, out_h) = (up.width as u32, up.height as u32);
    let preview = crate::convert::proxy(&up, 1600);
    let jpeg = crate::encode::encode_jpeg_bytes(&preview, 85)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    let preview_data_url = format!("data:image/jpeg;base64,{b64}");
    *session.pending_upscale.lock().unwrap() = Some(crate::session::PendingUpscale {
        image: up,
        metadata: crate::metadata::Metadata::default(),
    });
    Ok(crate::upscale::UpscaleResult { preview_data_url, out_w, out_h })
}

/// Save the stashed upscaled image to `out_path` in the chosen format, with EXIF.
#[tauri::command]
pub async fn save_upscaled(
    out_path: String,
    format: ExportFormat,
    meta_override: Option<MetaOverride>,
    session: State<'_, Session>,
) -> Result<(), String> {
    let guard = session.pending_upscale.lock().unwrap();
    let pending = guard.as_ref().ok_or("no upscaled image to save")?;
    let out = Path::new(&out_path);
    match format.kind.as_str() {
        "tiff" => {
            if format.bit_depth == 16 {
                film_core::export::write_tiff16(&pending.image, out).map_err(|e| format!("{e}"))
            } else {
                write_tiff8(&pending.image, out)
            }
        }
        "png" => write_png(&pending.image, out, format.bit_depth),
        "jpeg" => write_jpeg(&pending.image, out, format.quality, format.max_bytes),
        other => Err(format!("unknown export format: {other}")),
    }?;
    let eff = effective_metadata(&pending.metadata, meta_override.as_ref());
    if let Err(e) = crate::exif_write::write_exif(out, &eff) {
        eprintln!("[exif] embed failed for {out_path}: {e}");
    }
    Ok(())
}
