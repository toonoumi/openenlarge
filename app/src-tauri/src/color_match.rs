//! Local color-toning match: derive develop params that make the current image's
//! CIELAB region statistics approach those of an imported reference image. Fully
//! local — no network, no LLM. See docs/superpowers/specs/2026-06-16-color-match-reference-design.md.

use film_core::Image;

/// Mean CIELAB of one tonal region.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RegionStats {
    pub l: f32,
    pub a: f32,
    pub b: f32,
}

/// Toning fingerprint of an image: per-region mean Lab, global L spread
/// (contrast proxy) and mean chroma (saturation proxy).
#[derive(Clone, Copy, Debug, Default)]
pub struct ImageStats {
    pub sh: RegionStats,
    pub mid: RegionStats,
    pub hi: RegionStats,
    pub l_std: f32,
    pub chroma: f32,
}

/// sRGB-encoded channel (0..1) → linear.
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// sRGB pixel (0..1 each) → CIELAB (D65). L in 0..100, a/b roughly -128..127.
fn srgb_to_lab(px: [f32; 3]) -> [f32; 3] {
    let r = srgb_to_linear(px[0].clamp(0.0, 1.0));
    let g = srgb_to_linear(px[1].clamp(0.0, 1.0));
    let b = srgb_to_linear(px[2].clamp(0.0, 1.0));
    // linear sRGB → XYZ (D65)
    let x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    // normalize by D65 white
    let (xn, yn, zn) = (0.95047, 1.0, 1.08883);
    let f = |t: f32| -> f32 {
        if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 }
    };
    let (fx, fy, fz) = (f(x / xn), f(y / yn), f(z / zn));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Compute the toning fingerprint of an image. Pixels are treated as sRGB 0..1
/// (engine/finish output and decoded reference are both display-encoded).
/// Tonal split by L*: shadows L<33, mid 33..=66, hi >66. Empty regions fall back
/// to the global mean so the optimizer always has a target.
pub fn compute_stats(img: &Image) -> ImageStats {
    let n = img.pixels.len().max(1) as f32;
    let mut g = RegionStats::default();
    let mut sums = [(RegionStats::default(), 0f32); 3]; // (accum, count) for sh/mid/hi
    let mut l_vals: Vec<f32> = Vec::with_capacity(img.pixels.len());
    let mut chroma_sum = 0f32;

    for &px in &img.pixels {
        let lab = srgb_to_lab(px);
        g.l += lab[0]; g.a += lab[1]; g.b += lab[2];
        l_vals.push(lab[0]);
        chroma_sum += (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        let idx = if lab[0] < 33.0 { 0 } else if lab[0] <= 66.0 { 1 } else { 2 };
        sums[idx].0.l += lab[0]; sums[idx].0.a += lab[1]; sums[idx].0.b += lab[2];
        sums[idx].1 += 1.0;
    }
    let global = RegionStats { l: g.l / n, a: g.a / n, b: g.b / n };
    let region = |i: usize| -> RegionStats {
        let (s, c) = sums[i];
        if c < 1.0 { global } else { RegionStats { l: s.l / c, a: s.a / c, b: s.b / c } }
    };
    let mean_l = global.l;
    let var = l_vals.iter().map(|&l| (l - mean_l) * (l - mean_l)).sum::<f32>() / n;
    ImageStats {
        sh: region(0), mid: region(1), hi: region(2),
        l_std: var.sqrt(),
        chroma: chroma_sum / n,
    }
}

/// Decode a reference image file, downscale to a small working size, and compute
/// its toning fingerprint. Returns Err with a readable message on decode failure.
pub fn reference_stats(path: &str) -> Result<ImageStats, String> {
    let dyn_img = image::open(path).map_err(|e| format!("reference decode: {e}"))?;
    let small = dyn_img.thumbnail(256, 256).to_rgb8(); // long edge ≤256, keeps aspect
    let pixels: Vec<[f32; 3]> = small
        .pixels()
        .map(|p| [p.0[0] as f32 / 255.0, p.0[1] as f32 / 255.0, p.0[2] as f32 / 255.0])
        .collect();
    let img = Image { width: small.width() as usize, height: small.height() as usize, pixels, ir: None };
    Ok(compute_stats(&img))
}

/// Decode a reference image and return a small base64 JPEG data URL for UI
/// preview. The app shows all images as data URLs (the `asset://` protocol is not
/// enabled), so the frontend can't load an arbitrary picked file directly.
pub fn reference_thumb_data_url(path: &str) -> Result<String, String> {
    use base64::Engine;
    let dyn_img = image::open(path).map_err(|e| format!("reference decode: {e}"))?;
    let small = dyn_img.thumbnail(160, 160).to_rgb8();
    let mut bytes: Vec<u8> = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80)
        .encode(small.as_raw(), small.width(), small.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// Weighted squared distance between two fingerprints. Region a*/b* (color cast)
/// dominate; L and global contrast/chroma are weighted lower so exposure/contrast
/// don't fight the cast match.
pub fn loss(cur: &ImageStats, target: &ImageStats) -> f32 {
    // L* (absolute lightness) is weighted low: we transfer the reference's colour
    // cast, contrast and saturation, NOT its scene brightness — forcing absolute
    // lightness/hue onto a different scene produces a muddy "everything-brown" wash.
    let region = |c: &RegionStats, t: &RegionStats| -> f32 {
        0.2 * (c.l - t.l).powi(2) + (c.a - t.a).powi(2) + (c.b - t.b).powi(2)
    };
    region(&cur.sh, &target.sh)
        + region(&cur.mid, &target.mid)
        + region(&cur.hi, &target.hi)
        + 0.25 * (cur.l_std - target.l_std).powi(2)
        + 0.25 * (cur.chroma - target.chroma).powi(2)
}

use crate::commands::{finish_from, mode_from, resolve_params, effective_base, effective_dmax};
use crate::session::InvertParams;
use film_core::finish::finish_image; // film-core does NOT re-export these at crate root
use film_core::engine::invert_image; // (lib.rs only re-exports `Image`)

/// Render `src` (a raw-negative thumbnail) to its developed positive under `p`,
/// reusing the exact live-preview pipeline, and return its toning fingerprint.
/// `dev_base`/`dev_d_max` are the develop-time auto values from `Developed`.
pub fn render_stats(p: &InvertParams, src: &Image, dev_base: [f32; 3], dev_d_max: f32) -> ImageStats {
    let mut ip = resolve_params(p, src, effective_base(p, dev_base));
    ip.d_max = effective_dmax(p, dev_d_max);
    let inv = invert_image(src, &ip, mode_from(&p.mode));
    let out = finish_image(&inv, &finish_from(p));
    compute_stats(&out)
}

use serde::Serialize;

/// The scoped params the match may change. Field names match `InvertParams` /
/// the TS interface exactly so the frontend can spread this object onto params.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MatchedParams {
    pub temp: f32,
    pub tint: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub cg_sh_hue: f32,
    pub cg_sh_sat: f32,
    pub cg_sh_lum: f32,
    pub cg_hi_hue: f32,
    pub cg_hi_sat: f32,
    pub cg_hi_lum: f32,
}

impl MatchedParams {
    fn from_params(p: &InvertParams) -> Self {
        MatchedParams {
            temp: p.temp, tint: p.tint, exposure: p.exposure,
            contrast: p.contrast, saturation: p.saturation,
            cg_sh_hue: p.cg_sh_hue, cg_sh_sat: p.cg_sh_sat, cg_sh_lum: p.cg_sh_lum,
            cg_hi_hue: p.cg_hi_hue, cg_hi_sat: p.cg_hi_sat, cg_hi_lum: p.cg_hi_lum,
        }
    }
    fn write_into(&self, p: &mut InvertParams) {
        p.temp = self.temp; p.tint = self.tint; p.exposure = self.exposure;
        p.contrast = self.contrast; p.saturation = self.saturation;
        p.cg_sh_hue = self.cg_sh_hue; p.cg_sh_sat = self.cg_sh_sat; p.cg_sh_lum = self.cg_sh_lum;
        p.cg_hi_hue = self.cg_hi_hue; p.cg_hi_sat = self.cg_hi_sat; p.cg_hi_lum = self.cg_hi_lum;
    }
    /// Linear blend from `orig` (s=0) to `self` (s=1).
    fn blend(&self, orig: &MatchedParams, s: f32) -> MatchedParams {
        let m = |a: f32, b: f32| a + (b - a) * s;
        MatchedParams {
            temp: m(orig.temp, self.temp), tint: m(orig.tint, self.tint),
            exposure: m(orig.exposure, self.exposure), contrast: m(orig.contrast, self.contrast),
            saturation: m(orig.saturation, self.saturation),
            cg_sh_hue: m(orig.cg_sh_hue, self.cg_sh_hue), cg_sh_sat: m(orig.cg_sh_sat, self.cg_sh_sat),
            cg_sh_lum: m(orig.cg_sh_lum, self.cg_sh_lum),
            cg_hi_hue: m(orig.cg_hi_hue, self.cg_hi_hue), cg_hi_sat: m(orig.cg_hi_sat, self.cg_hi_sat),
            cg_hi_lum: m(orig.cg_hi_lum, self.cg_hi_lum),
        }
    }
}

/// One tunable axis: how to read/write it on MatchedParams, its valid range, and
/// the initial coordinate-descent step.
struct Axis {
    get: fn(&MatchedParams) -> f32,
    set: fn(&mut MatchedParams, f32),
    lo: f32,
    hi: f32,
    step: f32,
}

/// Axes the optimizer is allowed to move. Deliberately limited to white balance
/// (temp/tint), contrast and saturation — the clean "colour cast + tone" set.
/// Exposure is excluded so the user's own brightness is preserved, and the
/// colour-grading shadow/highlight wheels are excluded because forcing a scene's
/// absolute regional colour onto a different image produces a muddy brown wash
/// (the cg_* fields stay = original and the frontend strength slider controls
/// overall intensity instead).
fn axes() -> Vec<Axis> {
    vec![
        Axis { get: |m| m.temp, set: |m, v| m.temp = v, lo: 2000.0, hi: 12000.0, step: 800.0 },
        Axis { get: |m| m.tint, set: |m, v| m.tint = v, lo: -150.0, hi: 150.0, step: 20.0 },
        Axis { get: |m| m.contrast, set: |m, v| m.contrast = v, lo: -100.0, hi: 100.0, step: 15.0 },
        Axis { get: |m| m.saturation, set: |m, v| m.saturation = v, lo: -100.0, hi: 100.0, step: 15.0 },
    ]
}

/// Bounded coordinate descent. Re-renders `src` per candidate and keeps the
/// best-loss param set. Deterministic; capped passes keep it fast (each eval is a
/// thumbnail-sized render).
fn optimize(start: MatchedParams, base: &InvertParams, src: &Image, dev_base: [f32; 3],
            dev_d_max: f32, target: &ImageStats) -> MatchedParams {
    let eval = |m: &MatchedParams| -> f32 {
        let mut p = base.clone();
        m.write_into(&mut p);
        loss(&render_stats(&p, src, dev_base, dev_d_max), target)
    };
    let mut best = start;
    let mut best_loss = eval(&best);
    let mut axes = axes();
    for _pass in 0..4 {
        for ax in axes.iter_mut() {
            let mut improved = true;
            while improved {
                improved = false;
                for &dir in &[1.0f32, -1.0] {
                    let v = ((ax.get)(&best) + dir * ax.step).clamp(ax.lo, ax.hi);
                    if (v - (ax.get)(&best)).abs() < f32::EPSILON { continue; }
                    let mut cand = best;
                    (ax.set)(&mut cand, v);
                    let l = eval(&cand);
                    if l + 1e-4 < best_loss { best = cand; best_loss = l; improved = true; }
                }
            }
            ax.step *= 0.5; // refine this axis on the next pass
        }
    }
    best
}

/// Full entry point: given the current image's raw-negative thumbnail + develop
/// state and a reference file, return scoped params blended by `strength` (0..100)
/// from the originals toward the optimized match.
pub fn match_to_reference(
    base: &InvertParams, src: &Image, dev_base: [f32; 3], dev_d_max: f32,
    ref_path: &str, strength: u8,
) -> Result<MatchedParams, String> {
    let target = reference_stats(ref_path)?;
    let orig = MatchedParams::from_params(base);
    let optimized = optimize(orig, base, src, dev_base, dev_d_max, &target);
    let s = (strength.min(100) as f32) / 100.0;
    Ok(optimized.blend(&orig, s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use film_core::Image;

    const DEFAULT_PARAMS_JSON: &str = r#"{
        "mode":"d","stock":"none","exposure":0,"black":0,"gamma":0.4545,
        "auto_wb":true,"temp":5500,"tint":0,
        "contrast":0,"highlights":0,"shadows":0,"whites":0,"blacks":0,
        "texture":0,"vibrance":0,"saturation":0
    }"#;

    /// Write a solid-color PNG to a temp path and return it. Caller deletes.
    fn write_ref_png(rgb: [u8; 3], name: &str) -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(name);
        let buf = image::RgbImage::from_pixel(8, 8, image::Rgb(rgb));
        buf.save(&path).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn neg_thumb() -> Image {
        // A mid-gray-ish negative thumbnail; values are raw negative samples.
        Image { width: 8, height: 8, pixels: vec![[0.45, 0.4, 0.35]; 64], ir: None }
    }

    fn base_params() -> InvertParams {
        serde_json::from_str(DEFAULT_PARAMS_JSON).unwrap()
    }

    #[test]
    fn strength_zero_returns_originals() {
        let p = base_params();
        let r = write_ref_png([200, 120, 40], "cm_test_warm.png");
        let m = match_to_reference(&p, &neg_thumb(), [0.5, 0.4, 0.3], 1.5, &r, 0).unwrap();
        let _ = std::fs::remove_file(&r);
        assert!((m.temp - p.temp).abs() < 1e-3 && (m.tint - p.tint).abs() < 1e-3,
            "strength 0 → unchanged");
    }

    #[test]
    fn match_lowers_loss_vs_start() {
        let p = base_params();
        let r = write_ref_png([60, 90, 200], "cm_test_cool.png"); // strong cool ref
        let src = neg_thumb();
        let (db, dd) = ([0.5, 0.4, 0.3], 1.5);
        let target = reference_stats(&r).unwrap();
        let start_loss = loss(&render_stats(&p, &src, db, dd), &target);
        let m = match_to_reference(&p, &src, db, dd, &r, 100).unwrap();
        let mut pm = p.clone();
        m.write_into(&mut pm);
        let end_loss = loss(&render_stats(&pm, &src, db, dd), &target);
        let _ = std::fs::remove_file(&r);
        assert!(end_loss <= start_loss + 1e-3, "optimizer must not worsen the seed");
    }

    fn solid(rgb: [f32; 3], px: usize) -> Image {
        Image { width: px, height: 1, pixels: vec![rgb; px], ir: None }
    }

    #[test]
    fn white_is_near_l100_neutral() {
        let s = compute_stats(&solid([1.0, 1.0, 1.0], 16));
        assert!((s.mid.l).max(s.hi.l) > 95.0, "white L should be ~100");
        assert!(s.hi.a.abs() < 2.0 && s.hi.b.abs() < 2.0, "white is neutral a/b≈0");
    }

    #[test]
    fn warm_pixel_has_positive_b() {
        // A warm (orange) pixel should have positive b* (yellow) and positive a* (red).
        let s = compute_stats(&solid([0.8, 0.5, 0.2], 16));
        assert!(s.mid.b > 5.0 || s.hi.b > 5.0, "warm → +b*");
    }

    #[test]
    fn loss_is_zero_for_identical_stats() {
        let s = compute_stats(&solid([0.5, 0.4, 0.3], 32));
        assert!(loss(&s, &s) < 1e-6, "identical stats → ~0 loss");
    }

    #[test]
    fn loss_grows_with_cast_difference() {
        let warm = compute_stats(&solid([0.8, 0.5, 0.2], 32));
        let cool = compute_stats(&solid([0.2, 0.5, 0.8], 32));
        let neutral = compute_stats(&solid([0.5, 0.5, 0.5], 32));
        assert!(loss(&warm, &cool) > loss(&warm, &neutral), "opposite cast → larger loss");
    }
}
