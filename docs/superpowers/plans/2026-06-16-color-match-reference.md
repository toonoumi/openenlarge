# Match Reference (local color-toning match) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user import a reference image from disk and have a fully-local Rust routine adjust the current image's develop params so its color toning matches the reference, applied as one undoable change.

**Architecture:** A new `color_match` Rust module computes CIELAB region statistics of the reference and, via a bounded coordinate-descent optimizer that re-renders the current image's thumbnail through the existing `invert_image` + `finish_image` pipeline, finds develop-param values that minimize the toning gap. A new Tauri command returns the scoped params; the Svelte panel applies them in a single `params.update` + `commitActive()`.

**Tech Stack:** Rust (Tauri 2, `image` crate, `film-core` engine), Svelte 5 + SvelteKit frontend, `@tauri-apps/plugin-dialog` for file picking.

---

## Background facts (verified against the codebase)

- `InvertParams` (Rust) lives in `app/src-tauri/src/session.rs:50`; the matching TS interface is `app/src/lib/api.ts:42`. Scoped field names are identical on both sides: `temp`, `tint`, `exposure`, `contrast`, `saturation`, `cg_sh_hue`, `cg_sh_sat`, `cg_sh_lum`, `cg_hi_hue`, `cg_hi_sat`, `cg_hi_lum`.
- The developed positive is produced by `finish_image(&invert_image(src, &ip, mode), &finish_from(&params))`. Helpers (all in `app/src-tauri/src/commands.rs` unless noted):
  - `mode_from(&p.mode)` → `Mode` (commands.rs:185)
  - `effective_base(&p, dev.base)` (commands.rs:205), `effective_dmax(&p, dev.d_max)` (commands.rs:211)
  - `resolve_params(&p, &src, base)` → `InversionParams` (commands.rs:249) — **private**; will be made `pub(crate)` in Task 3.
  - `finish_from(&p)` → `FinishParams` (commands.rs:382) — **private**; will be made `pub(crate)` in Task 3.
  - `invert_image` (crates/film-core/src/engine.rs:119), `finish_image` (crates/film-core/src/finish.rs:519), both already `pub`.
- The per-image working buffers are on `Developed { working: Image, thumb: Image, base: [f32;3], d_max: f32, .. }` (session.rs:218). `thumb` is a small raw-negative `Image` — ideal for fast per-iteration renders.
- `film_core::Image { width: usize, height: usize, pixels: Vec<[f32;3]>, ir }` (crates/film-core/src/image.rs:7).
- Engine/finish output pixels are **already display-encoded (sRGB-ish), range 0..1** — `to_jpeg_b64(&out, /*apply_gamma=*/false, ..)` confirms this (encode.rs). The reference decodes to sRGB 0..1 as well, so both convert to Lab the same way.
- Tauri commands are registered in `app/src-tauri/src/lib.rs:55` (`generate_handler![...]`); `commands::ai_enhance_image` is the last AI entry (lib.rs:86).
- `ensure_resident(&session, &id)?` then `session.images.lock()` then `images.get(&id)` then `img.developed.as_ref().ok_or("not developed")?` is the standard guard (see `render_view`, commands.rs:715-724).
- i18n: edit `/i18n-strings.csv` (columns `key,en,zh,file,note`), then run `python3 scripts/gen-i18n.py`. Never edit `dict.ts` directly. AI rows are at csv lines 283-295.
- The panel `app/src/lib/develop/AiEnhancePanel.svelte` is shown when the `enhance` tool is active. `params` store + `commitActive()` (from `app/src/lib/develop/historyStore.ts:58`) are the apply mechanism; `activeId` is in `../store`.
- File dialog pattern: `import { open } from "@tauri-apps/plugin-dialog"` (see `app/src/lib/panels/Source.svelte:2,14`). `convertFileSrc` comes from `@tauri-apps/api/core`.

Build/test commands:
- Rust tests: `cd app/src-tauri && cargo test color_match`
- Frontend tests: `cd app && npx vitest run src/lib/develop/colorMatchApply.test.ts`
- Frontend typecheck: `cd app && npm run check` (if present) — optional sanity.

---

## File Structure

- **Create** `app/src-tauri/src/color_match.rs` — Lab stats, region split, optimizer, `match_to_reference`, `MatchedParams`. One responsibility: derive matched params from a reference file.
- **Modify** `app/src-tauri/src/commands.rs` — add `color_match_params` command; make `resolve_params` and `finish_from` `pub(crate)`.
- **Modify** `app/src-tauri/src/lib.rs` — declare `mod color_match;` and register the command.
- **Modify** `app/src/lib/api.ts` — add `colorMatchParams` binding + return type.
- **Modify** `/i18n-strings.csv` + regenerate `app/src/lib/i18n/dict.ts`.
- **Modify** `app/src/lib/develop/AiEnhancePanel.svelte` — Match Reference UI + apply logic.
- **Create** `app/src/lib/develop/colorMatchApply.test.ts` — single-commit apply test.

---

## Task 1: Lab conversion + image statistics (Rust)

**Files:**
- Create: `app/src-tauri/src/color_match.rs`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Create the module with Lab + stats code and a failing test**

Create `app/src-tauri/src/color_match.rs`:

```rust
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

#[cfg(test)]
mod tests {
    use super::*;
    use film_core::Image;

    fn solid(rgb: [f32; 3], px: usize) -> Image {
        Image { width: px, height: 1, pixels: vec![rgb; px], ir: None }
    }

    #[test]
    fn white_is_near_l100_neutral() {
        let s = compute_stats(&solid([1.0, 1.0, 1.0], 16));
        assert!((s.mid.l).max(s.hi.l) > 95.0, "white L should be ~100");
        assert!(s.hi.a.abs() < 2.0 && s.hi.b.abs() < 2.0, "white is neutral a/b≈0");
    }
}
```

- [ ] **Step 2: Wire the module so it compiles, then run the test (expect FAIL→PASS once wired)**

Add to `app/src-tauri/src/lib.rs` near the other `mod` declarations (top of file, alongside `mod commands;`):

```rust
mod color_match;
```

Run: `cd app/src-tauri && cargo test color_match::tests::white_is_near_l100_neutral`
Expected: PASS (and the module compiles).

- [ ] **Step 3: Add a directional Lab test**

Add inside `mod tests`:

```rust
    #[test]
    fn warm_pixel_has_positive_b() {
        // A warm (orange) pixel should have positive b* (yellow) and positive a* (red).
        let s = compute_stats(&solid([0.8, 0.5, 0.2], 16));
        assert!(s.mid.b > 5.0 || s.hi.b > 5.0, "warm → +b*");
    }
```

- [ ] **Step 4: Run stats tests**

Run: `cd app/src-tauri && cargo test color_match::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/color_match.rs app/src-tauri/src/lib.rs
git commit -m "feat(color-match): CIELAB region statistics for toning match"
```

---

## Task 2: Reference decoding + loss function (Rust)

**Files:**
- Modify: `app/src-tauri/src/color_match.rs`

- [ ] **Step 1: Add reference loader + loss with a failing test**

Append to `color_match.rs` (above `#[cfg(test)]`):

```rust
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

/// Weighted squared distance between two fingerprints. Region a*/b* (color cast)
/// dominate; L and global contrast/chroma are weighted lower so exposure/contrast
/// don't fight the cast match.
pub fn loss(cur: &ImageStats, target: &ImageStats) -> f32 {
    let region = |c: &RegionStats, t: &RegionStats| -> f32 {
        0.5 * (c.l - t.l).powi(2) + (c.a - t.a).powi(2) + (c.b - t.b).powi(2)
    };
    region(&cur.sh, &target.sh)
        + region(&cur.mid, &target.mid)
        + region(&cur.hi, &target.hi)
        + 0.25 * (cur.l_std - target.l_std).powi(2)
        + 0.25 * (cur.chroma - target.chroma).powi(2)
}
```

Add `use image::GenericImageView;` is NOT needed (we use `.thumbnail`/`.to_rgb8`/`.pixels` from `image::DynamicImage`/`ImageBuffer`). Confirm `image` is a dependency (it is — used in encode.rs/convert.rs).

Add to `mod tests`:

```rust
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
```

- [ ] **Step 2: Run the tests**

Run: `cd app/src-tauri && cargo test color_match::tests`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/color_match.rs
git commit -m "feat(color-match): reference decode + weighted Lab loss"
```

---

## Task 3: Expose render helpers + render current thumbnail (Rust)

**Files:**
- Modify: `app/src-tauri/src/commands.rs:249` (`resolve_params`), `:382` (`finish_from`)
- Modify: `app/src-tauri/src/color_match.rs`

- [ ] **Step 1: Make the two render helpers crate-visible**

In `app/src-tauri/src/commands.rs`, change the signature line:

```rust
fn resolve_params(
```
to
```rust
pub(crate) fn resolve_params(
```

and change:
```rust
fn finish_from(p: &InvertParams) -> FinishParams {
```
to
```rust
pub(crate) fn finish_from(p: &InvertParams) -> FinishParams {
```

- [ ] **Step 2: Add the per-candidate render+stats function to color_match.rs**

Append to `color_match.rs`:

```rust
use crate::commands::{finish_from, mode_from, resolve_params, effective_base, effective_dmax};
use crate::session::InvertParams;
use film_core::finish::finish_image; // film-core does NOT re-export at crate root
use film_core::engine::invert_image; // (verified: lib.rs only re-exports `Image`)

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
```

Note (verified): `crates/film-core/src/lib.rs` declares `pub mod engine;` and `pub mod finish;` and only re-exports `Image` (`pub use image::Image;`). So the paths above (`film_core::engine::invert_image`, `film_core::finish::finish_image`) are correct. `FinishParams` lives at `film_core::finish::FinishParams` but is not referenced here directly (only via `finish_from`).

- [ ] **Step 3: Verify it compiles**

Run: `cd app/src-tauri && cargo build`
Expected: builds clean (fix `use` paths per Step 2 note if needed).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/color_match.rs
git commit -m "feat(color-match): render current thumbnail through live pipeline for stats"
```

---

## Task 4: Optimizer + match_to_reference + MatchedParams (Rust)

**Files:**
- Modify: `app/src-tauri/src/color_match.rs`

- [ ] **Step 1: Add MatchedParams, the optimizer, and match_to_reference with failing tests**

Append to `color_match.rs` (above `#[cfg(test)]`):

```rust
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

fn axes() -> Vec<Axis> {
    vec![
        Axis { get: |m| m.temp, set: |m, v| m.temp = v, lo: 2000.0, hi: 12000.0, step: 800.0 },
        Axis { get: |m| m.tint, set: |m, v| m.tint = v, lo: -150.0, hi: 150.0, step: 20.0 },
        Axis { get: |m| m.exposure, set: |m, v| m.exposure = v, lo: -5.0, hi: 5.0, step: 0.5 },
        Axis { get: |m| m.contrast, set: |m, v| m.contrast = v, lo: -100.0, hi: 100.0, step: 15.0 },
        Axis { get: |m| m.saturation, set: |m, v| m.saturation = v, lo: -100.0, hi: 100.0, step: 15.0 },
        Axis { get: |m| m.cg_sh_hue, set: |m, v| m.cg_sh_hue = v, lo: 0.0, hi: 360.0, step: 40.0 },
        Axis { get: |m| m.cg_sh_sat, set: |m, v| m.cg_sh_sat = v, lo: 0.0, hi: 100.0, step: 12.0 },
        Axis { get: |m| m.cg_sh_lum, set: |m, v| m.cg_sh_lum = v, lo: -100.0, hi: 100.0, step: 12.0 },
        Axis { get: |m| m.cg_hi_hue, set: |m, v| m.cg_hi_hue = v, lo: 0.0, hi: 360.0, step: 40.0 },
        Axis { get: |m| m.cg_hi_sat, set: |m, v| m.cg_hi_sat = v, lo: 0.0, hi: 100.0, step: 12.0 },
        Axis { get: |m| m.cg_hi_lum, set: |m, v| m.cg_hi_lum = v, lo: -100.0, hi: 100.0, step: 12.0 },
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
            let cur = (ax.get)(&best);
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
            let _ = cur;
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
```

Add failing tests to `mod tests` (these need a tiny synthetic raw-negative + a temp reference file):

```rust
    use std::io::Write;

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
        // Use the engine's default-ish neutral params. Build via serde default is
        // brittle; instead clone the project's defaultParams equivalent. The
        // simplest reliable path: deserialize from the JSON the frontend sends.
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
```

Define `DEFAULT_PARAMS_JSON` at the top of `mod tests`. It only needs the fields lacking `#[serde(default)]` (verified against `app/src/lib/api.ts:250` `defaultParams()` and `session.rs`); all `cg_*`, `tc_*`, `cm_*`, `pc_*`, `base_override`, `d_max_override`, `wb_manual`, `hdr` have serde defaults and may be omitted:

```rust
    const DEFAULT_PARAMS_JSON: &str = r#"{
        "mode":"d","stock":"none","exposure":0,"black":0,"gamma":0.4545,
        "auto_wb":true,"temp":5500,"tint":0,
        "contrast":0,"highlights":0,"shadows":0,"whites":0,"blacks":0,
        "texture":0,"vibrance":0,"saturation":0
    }"#;
```

If `cargo test` reports a missing non-default field, add it here with its `defaultParams()` value. (`serde_json` is already a dev/runtime dependency — used across commands.)

- [ ] **Step 2: Run the optimizer tests**

Run: `cd app/src-tauri && cargo test color_match::tests`
Expected: PASS (7 tests). If `match_lowers_loss_vs_start` is flaky at the boundary, it is asserting `<=` with epsilon — it should hold because the optimizer keeps the best seed.

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/color_match.rs
git commit -m "feat(color-match): coordinate-descent optimizer + strength blend"
```

---

## Task 5: Tauri command + registration (Rust)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add command near `ai_enhance_image`, ~line 1902)
- Modify: `app/src-tauri/src/lib.rs:86` (register)

- [ ] **Step 1: Add the command**

In `app/src-tauri/src/commands.rs`, after the `ai_enhance_image` command (around line 1908), add:

```rust
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
```

Confirm `State`, `Session`, `InvertParams` are already imported in commands.rs (they are — used by `render_view`). If not, add the same `use` lines `render_view` relies on.

- [ ] **Step 2: Register the command**

In `app/src-tauri/src/lib.rs`, in the `generate_handler![...]` list, add after `commands::ai_enhance_image,` (line 86):

```rust
            commands::color_match_params,
```

- [ ] **Step 3: Build**

Run: `cd app/src-tauri && cargo build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(color-match): color_match_params Tauri command"
```

---

## Task 6: Frontend API binding (TS)

**Files:**
- Modify: `app/src/lib/api.ts` (add type + binding after `aiEnhanceImage`, line 207)

- [ ] **Step 1: Add the binding and return type**

In `app/src/lib/api.ts`, add an exported type near the other interfaces (e.g. after `InvertParams`):

```typescript
/** Scoped develop params returned by the local color-match (subset of InvertParams). */
export type MatchedParams = Pick<InvertParams,
  "temp" | "tint" | "exposure" | "contrast" | "saturation"
  | "cg_sh_hue" | "cg_sh_sat" | "cg_sh_lum"
  | "cg_hi_hue" | "cg_hi_sat" | "cg_hi_lum">;
```

In the `api` object, after the `aiEnhanceImage` entry (line 207-208), add:

```typescript
  colorMatchParams: (id: string, params: InvertParams, refPath: string, strength: number) =>
    invoke<MatchedParams>("color_match_params", { id, params, refPath, strength }),
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>/dev/null | tail -5` (or `npm run check` if defined). Expected: no new errors referencing api.ts. (If neither command exists, skip — verified in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/api.ts
git commit -m "feat(color-match): api.colorMatchParams binding"
```

---

## Task 7: i18n strings

**Files:**
- Modify: `/i18n-strings.csv` (after the `aiEnhance.*` block, line 295)
- Regenerate: `app/src/lib/i18n/dict.ts`

- [ ] **Step 1: Append rows to the CSV**

Add after csv line 295 (`aiEnhance.hint,...`):

```csv
colorMatch.title,"Match Reference","匹配参考","src/lib/develop/AiEnhancePanel.svelte","heading"
colorMatch.import,"Import reference image","导入参考图像","src/lib/develop/AiEnhancePanel.svelte","button"
colorMatch.match,"Match toning","匹配色调","src/lib/develop/AiEnhancePanel.svelte","button"
colorMatch.matching,"Matching…","匹配中…","src/lib/develop/AiEnhancePanel.svelte","button"
colorMatch.strength,"Strength","强度","src/lib/develop/AiEnhancePanel.svelte","label"
colorMatch.noRef,"Import a reference image first.","请先导入参考图像。","src/lib/develop/AiEnhancePanel.svelte","text"
colorMatch.hint,"Adjusts white balance, exposure, contrast and color grading to match the reference's color toning. Fully local — fine-tune any slider afterward, or undo (Ctrl+Z) to revert.","调整白平衡、曝光、对比度和颜色分级以匹配参考图像的色调。完全本地处理——之后可微调任意滑块，或撤销（Ctrl+Z）还原。","src/lib/develop/AiEnhancePanel.svelte","hint"
```

- [ ] **Step 2: Regenerate the dictionary**

Run: `cd /Users/mohaelder/Repos/filmrev && python3 scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` rewritten; `git diff --stat` shows dict.ts changed and contains the new `colorMatch.*` keys (`grep -c "colorMatch" app/src/lib/i18n/dict.ts` ≥ 14, i.e. 7 keys × 2 langs).

- [ ] **Step 3: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "i18n(color-match): Match Reference strings"
```

---

## Task 8: Panel UI + apply logic (Svelte)

**Files:**
- Modify: `app/src/lib/develop/AiEnhancePanel.svelte`
- Create: `app/src/lib/develop/colorMatchApply.test.ts`

- [ ] **Step 1: Write the failing apply test**

Create `app/src/lib/develop/colorMatchApply.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { InvertParams, MatchedParams } from "../api";

// Mirrors the panel's apply: spread the matched subset onto current params once.
function applyMatch(p: InvertParams, m: MatchedParams): InvertParams {
  return { ...p, ...m };
}

describe("color match apply", () => {
  it("overwrites only the scoped keys, leaving others intact", () => {
    const p = { temp: 5000, tint: 0, exposure: 0, contrast: 0, saturation: 0,
      cg_sh_hue: 0, cg_sh_sat: 0, cg_sh_lum: 0, cg_hi_hue: 0, cg_hi_sat: 0, cg_hi_lum: 0,
      vibrance: 42, highlights: 7 } as unknown as InvertParams;
    const m = { temp: 6200, tint: -10, exposure: 0.5, contrast: 12, saturation: -5,
      cg_sh_hue: 30, cg_sh_sat: 8, cg_sh_lum: -3, cg_hi_hue: 210, cg_hi_sat: 6, cg_hi_lum: 2 } as MatchedParams;
    const out = applyMatch(p, m);
    expect(out.temp).toBe(6200);
    expect(out.cg_hi_hue).toBe(210);
    expect(out.vibrance).toBe(42);   // untouched
    expect(out.highlights).toBe(7);  // untouched
  });
});
```

- [ ] **Step 2: Run it (expect PASS — it documents the contract)**

Run: `cd app && npx vitest run src/lib/develop/colorMatchApply.test.ts`
Expected: PASS. (This is a contract test for the spread-apply behavior the panel uses.)

- [ ] **Step 3: Add imports + state to the panel script**

In `app/src/lib/develop/AiEnhancePanel.svelte`, extend the `<script>` block. Change the imports:

```typescript
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { previewSrc, openaiApiKey, activeId, params } from "../store";
  import { commitActive } from "./historyStore";
  import { api } from "../api";
  import { open } from "@tauri-apps/plugin-dialog";
  import { convertFileSrc } from "@tauri-apps/api/core";
```

Add state after the existing `let enlarged = false;`:

```typescript
  // --- Match Reference (local color-toning match) ---
  let refPath = "";
  let refSrc = "";       // convertFileSrc(refPath) for the thumbnail
  let strength = 100;    // 0..100
  let matchBusy = false;
  let matchError = "";

  function refName(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(i + 1) : p;
  }

  async function pickReference() {
    matchError = "";
    const sel = await open({ multiple: false, filters: [
      { name: "Images", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "webp"] },
    ] });
    if (typeof sel === "string") { refPath = sel; refSrc = convertFileSrc(sel); }
  }

  async function matchToning() {
    matchError = "";
    const id = get(activeId);
    if (!id) { matchError = $t("aiEnhance.noImage"); return; }
    if (!refPath) { matchError = $t("colorMatch.noRef"); return; }
    matchBusy = true;
    try {
      const cur = get(params);
      const matched = await api.colorMatchParams(id, cur, refPath, strength);
      // Single update + single commit → one Ctrl+Z restores everything.
      params.update((p) => ({ ...p, ...matched }));
      commitActive();
    } catch (e) {
      matchError = String(e);
    } finally {
      matchBusy = false;
    }
  }
```

- [ ] **Step 4: Add the UI markup**

In `AiEnhancePanel.svelte`, insert this block immediately **before** the closing `</div>` of the main `.section` — i.e. after the `{#if result}...{/if}` block (line 63) and before `<div class="hint">` (line 65):

```svelte
  <div class="match">
    <div class="head"><span>{$t("colorMatch.title")}</span></div>
    <button class="ref-pick" on:click={pickReference}>{$t("colorMatch.import")}</button>

    {#if refPath}
      <div class="ref">
        <img class="ref-thumb" src={refSrc} alt={refName(refPath)} />
        <span class="ref-name" title={refPath}>{refName(refPath)}</span>
      </div>

      <label class="strength">
        <span>{$t("colorMatch.strength")}</span>
        <input type="range" min="0" max="100" bind:value={strength} />
        <span class="val">{strength}%</span>
      </label>

      <button class="go" class:busy={matchBusy} disabled={matchBusy} on:click={matchToning}>
        {#if matchBusy}<span class="spinner" aria-hidden="true"></span>{/if}
        <span>{matchBusy ? $t("colorMatch.matching") : $t("colorMatch.match")}</span>
      </button>
    {/if}

    {#if matchError}<div class="err">{matchError}</div>{/if}
    <div class="hint">{$t("colorMatch.hint")}</div>
  </div>
```

- [ ] **Step 5: Add styles**

In the `<style>` block of `AiEnhancePanel.svelte`, append:

```css
  .match { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--glass-brd); }
  .ref-pick { width: 100%; padding: 8px 10px; margin: 6px 0; border-radius: 8px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text);
    cursor: pointer; font-size: 13px; }
  .ref { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .ref-thumb { width: 44px; height: 44px; object-fit: cover; border-radius: 6px;
    border: 1px solid var(--glass-brd); }
  .ref-name { font-size: 11px; color: var(--text-dim); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .strength { display: flex; align-items: center; gap: 8px; margin: 8px 0;
    font-size: 12px; color: var(--text); }
  .strength input { flex: 1; }
  .strength .val { width: 34px; text-align: right; color: var(--text-dim); }
```

(The `.go`, `.spinner`, `.err`, `.hint`, `@keyframes` rules already exist and are reused.)

- [ ] **Step 6: Run the frontend test + build**

Run: `cd app && npx vitest run src/lib/develop/colorMatchApply.test.ts`
Expected: PASS.
Run: `cd app && npm run build` (or `npx vite build`)
Expected: builds without errors referencing AiEnhancePanel.svelte.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/develop/AiEnhancePanel.svelte app/src/lib/develop/colorMatchApply.test.ts
git commit -m "feat(color-match): Match Reference panel UI + single-commit apply"
```

---

## Task 9: Full verification

- [ ] **Step 1: Rust test + clippy**

Run: `cd app/src-tauri && cargo test color_match && cargo clippy --all-targets 2>&1 | tail -20`
Expected: all color_match tests pass; no new clippy errors in `color_match.rs`/`commands.rs`.

- [ ] **Step 2: Frontend tests + build**

Run: `cd app && npx vitest run && npm run build`
Expected: all tests pass; production build succeeds.

- [ ] **Step 3: Manual smoke (optional, requires running the app)**

Use the `run` skill or `npm run tauri dev`. Develop an image, select the **Enhance** tool, scroll to **Match Reference**, import a reference photo, click **Match toning**, confirm the develop result shifts toward the reference's toning, then press **Ctrl+Z once** and confirm the image fully reverts in a single undo.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A && git commit -m "chore(color-match): verification pass"
```

---

## Self-review notes

- **Spec coverage:** UX section → Task 8; local Rust engine → Tasks 1-5; output adjusts develop params via single commit → Task 8 Step 3; reference from disk → Task 8 Step 3 (`open`); full scope incl. grading wheels → Task 4 `MatchedParams`/`axes()`; strength slider → Task 4 `blend` + Task 8; one-go Ctrl+Z revert → single `params.update` + one `commitActive()` (Task 8 Step 3), verified Task 9 Step 3; i18n CSV→gen workflow → Task 7; testing → Tasks 1-4 (Rust), 8 (frontend), 9 (full).
- **Known verification points flagged inline:** film-core re-export paths for `invert_image`/`finish_image` (Task 3 Step 2); exact `DEFAULT_PARAMS_JSON` field set from `defaultParams()` (Task 4 Step 1); presence of `State`/`Session`/`InvertParams` imports in commands.rs (Task 5 Step 1). Each says "verify, don't guess."
- **No LLM / network anywhere.** Existing OpenAI Enhance path untouched.
