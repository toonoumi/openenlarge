# One-Click AI Dust & Hair Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click feature to the Eraser panel that uses two local ONNX models — a learned defect detector and a learned inpainter (MI-GAN) — to automatically find and fill every dust speck and hair across the frame, with a sensitivity slider.

**Architecture:** Mirror the existing IR dust-removal flow (`dust::apply_ir`: detect → `inpaint_masked`) and the Upscale module (`ort` inference + downloadable, SHA-256-verified model assets behind a gate). A new `autodust` backend module runs both nets; pure mask/tile logic lives in `film-core` and is unit-tested; the detector's probability map is cached per-image in the Session so the sensitivity slider only re-thresholds + re-fills (no detector re-inference). The frontend adds an `autoDust` block to `EraserPanel`, wired through the same `ViewSpec`/bake path as IR removal.

**Tech Stack:** Rust (`film-core`, Tauri commands, `ort` 2.0-rc.12 with CoreML/DirectML, `ndarray`), Svelte/TypeScript frontend, ONNX models hosted as GitHub release assets.

---

## Phase 0 — Model validation spike (GO/NO-GO gate)

This phase is exploratory and **gates all later phases**. Do not build UI or commands until it passes. It produces: (a) two `.onnx` files, (b) their exact I/O contract (input/output tensor names, shapes, normalization, channel order), and (c) a visual go/no-go on real scans.

### Task 0.1: Acquire + export the two models to ONNX

**Files:**
- Create: `docs/superpowers/spikes/autodust-model-notes.md`
- Create (local, git-ignored): `spike/detector.onnx`, `spike/migan.onnx`

- [ ] **Step 1: Detector** — export a scratch/dust segmentation U-Net to ONNX. Primary candidate: the scratch-detection model from Microsoft's *Bringing Old Photos Back to Life* (`global/detection` U-Net). Record its license. Note input: grayscale, normalization, and output: single-channel logits/probability.
- [ ] **Step 2: Inpainter** — obtain MI-GAN ONNX (the lightweight model shipped by IOPaint). Record its license, fixed input resolution (commonly 512), and that it takes image + mask → RGB.
- [ ] **Step 3:** Write `docs/superpowers/spikes/autodust-model-notes.md` capturing for each model: download URL/source, license, input tensor name+shape+dtype+normalization, output tensor name+shape, and channel order (RGB vs BGR).

- [ ] **Step 4: Commit the notes doc**

```bash
git add docs/superpowers/spikes/autodust-model-notes.md
git commit -m "docs(autodust): Phase 0 model I/O + license notes"
```

### Task 0.2: Run both models on real scans (throwaway harness)

**Files:**
- Create (throwaway): `spike/run_spike.py` (or a `cargo` example) — not shipped.

- [ ] **Step 1:** Load 5–8 representative real scans (color + B&W, fine-grain + coarse, a clean sky, a detailed portrait).
- [ ] **Step 2:** For each: run detector → probability map; threshold at a few levels; dilate 1px; overlay the mask on the positive image and save a PNG.
- [ ] **Step 3:** For each: feed image + thresholded mask to MI-GAN; save the filled result PNG.
- [ ] **Step 4: Visual review.** Confirm: dust + hairs are caught; fine real detail (stars, catchlights, freckles, fabric) is mostly NOT flagged at a reasonable threshold; fills are clean.

- [ ] **Step 5: GO/NO-GO.** Record the verdict in the notes doc.
  - **GO:** proceed to Phase 1 with these two models.
  - **NO-GO (detector over/under-flags grain):** swap the detector candidate, or fall back to the classical-CV detector noted in the spec, then re-run this task. Architecture downstream is unchanged either way.

- [ ] **Step 6: Commit the verdict**

```bash
git add docs/superpowers/spikes/autodust-model-notes.md
git commit -m "docs(autodust): Phase 0 GO/NO-GO verdict on real scans"
```

---

## Phase 1 — Pure mask logic in `film-core` (TDD)

The probability-map → `Mask` step is pure and fully testable without any model. It mirrors `ir_defect_mask`.

### Task 1.1: `prob_defect_mask` — threshold + dilate + size-gate

**Files:**
- Modify: `crates/film-core/src/dust.rs` (add after `ir_defect_mask`, ~line 198)
- Test: `crates/film-core/src/dust.rs` (`#[cfg(test)]` module at bottom)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn prob_mask_thresholds_dilates_and_drops_large_blobs() {
    // 10x10 prob map: one strong speck at (5,5), and a large 6x6 block (a real
    // feature) in the top-left that must be size-gated out.
    let (w, h) = (10usize, 10usize);
    let mut prob = vec![0.0f32; w * h];
    prob[5 * w + 5] = 0.9;
    for y in 0..6 { for x in 0..6 { prob[y * w + x] = 0.9; } }
    // sensitivity 50 → threshold ~0.5; max_blob 9 px drops the 36px block.
    let m = prob_defect_mask(w, h, &prob, 50.0, 9);
    // The speck (and its 1px dilation) is masked.
    assert!(m.bits[5 * m.w + 5], "speck masked");
    // The large block's center is NOT masked (size-gated).
    assert!(!m.bits[2 * m.w + 2], "large feature dropped");
}

#[test]
fn prob_mask_empty_when_nothing_passes_threshold() {
    let m = prob_defect_mask(8, 8, &vec![0.1f32; 64], 50.0, 9);
    assert!(!m.bits.iter().any(|&b| b));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p film-core prob_mask`
Expected: FAIL — `cannot find function prob_defect_mask`

- [ ] **Step 3: Implement `prob_defect_mask`**

```rust
/// Build a whole-frame defect `Mask` from a single-channel probability map
/// (`prob[y*w+x]` in [0,1], higher = more likely a defect). `sensitivity`
/// (0..100) maps to a threshold (high sensitivity → low threshold → more
/// flagged). Flagged pixels are dilated 1px (8-neighborhood). Connected
/// components larger than `max_blob` pixels are dropped (they are real features,
/// not dust/hair). The returned mask spans the whole frame (`x0=y0=0`).
pub fn prob_defect_mask(
    w: usize,
    h: usize,
    prob: &[f32],
    sensitivity: f32,
    max_blob: usize,
) -> Mask {
    let empty = Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
    if w == 0 || h == 0 || prob.len() != w * h {
        return empty;
    }
    // sensitivity 0..100 → threshold 0.85..0.25 (more sensitive = lower bar).
    let s = sensitivity.clamp(0.0, 100.0) / 100.0;
    let thr = 0.85 - 0.60 * s;

    let mut raw = vec![false; w * h];
    for i in 0..w * h {
        if prob[i] >= thr {
            raw[i] = true;
        }
    }
    // Drop connected components (4-neighborhood) larger than max_blob.
    let mut visited = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if !raw[start] || visited[start] {
            continue;
        }
        let mut comp: Vec<usize> = Vec::new();
        stack.push(start);
        visited[start] = true;
        while let Some(i) = stack.pop() {
            comp.push(i);
            let (x, y) = (i % w, i / w);
            let mut push = |nx: usize, ny: usize, stack: &mut Vec<usize>, visited: &mut Vec<bool>| {
                let ni = ny * w + nx;
                if raw[ni] && !visited[ni] {
                    visited[ni] = true;
                    stack.push(ni);
                }
            };
            if x > 0 { push(x - 1, y, &mut stack, &mut visited); }
            if x + 1 < w { push(x + 1, y, &mut stack, &mut visited); }
            if y > 0 { push(x, y - 1, &mut stack, &mut visited); }
            if y + 1 < h { push(x, y + 1, &mut stack, &mut visited); }
        }
        if comp.len() > max_blob {
            for i in comp {
                raw[i] = false;
            }
        }
    }
    // Dilate 1px (8-neighborhood).
    let mut bits = raw.clone();
    for y in 0..h {
        for x in 0..w {
            if !raw[y * w + x] {
                continue;
            }
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                        bits[ny as usize * w + nx as usize] = true;
                    }
                }
            }
        }
    }
    Mask { x0: 0, y0: 0, w, h, bits }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core prob_mask`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/dust.rs
git commit -m "feat(film-core): prob_defect_mask (threshold+dilate+size-gate) for AI dust removal"
```

---

## Phase 2 — `autodust` backend module (assets + inference)

Mirrors `app/src-tauri/src/upscale/`. ONNX inference cannot be unit-tested deterministically without a model, so the *pure* helper (tile selection) is TDD'd and the inference glue is verified by `cargo build` + a manual run against the Phase 0 models.

### Task 2.1: Module skeleton + tile-selection helper (TDD)

**Files:**
- Create: `app/src-tauri/src/autodust/mod.rs`
- Create: `app/src-tauri/src/autodust/engine.rs`
- Create: `app/src-tauri/src/autodust/assets.rs`
- Modify: `app/src-tauri/src/lib.rs` (add `mod autodust;` near the other `mod` lines)

- [ ] **Step 1: Create `engine.rs` with the failing test for `masked_tiles`**

```rust
//! AI dust/hair: detector U-Net → probability map, MI-GAN inpaint over masked
//! tiles. Reuses the upscaler's `plan_tiles`-style tiling.

use crate::upscale::engine::{plan_tiles, Tile};
use film_core::dust::Mask;

/// Indices of `tiles` whose inner rect overlaps any masked pixel. Used to skip
/// clean tiles so MI-GAN only runs where there is something to fill.
pub fn masked_tiles(tiles: &[Tile], mask: &Mask) -> Vec<usize> {
    let mut out = Vec::new();
    for (i, t) in tiles.iter().enumerate() {
        let mut hit = false;
        'scan: for yy in t.oy..(t.oy + t.ih) {
            for xx in t.ox..(t.ox + t.iw) {
                // mask spans the whole frame (x0=y0=0); index directly.
                if mask.w > 0 && xx < mask.w && yy < mask.h && mask.bits[yy * mask.w + xx] {
                    hit = true;
                    break 'scan;
                }
            }
        }
        if hit {
            out.push(i);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masked_tiles_selects_only_tiles_overlapping_the_mask() {
        // 500x300 frame, 128px tiles. Put one masked pixel at (10,10) → only the
        // top-left tile should be selected.
        let (w, h) = (500usize, 300usize);
        let tiles = plan_tiles(w, h, 128, 8);
        let mut bits = vec![false; w * h];
        bits[10 * w + 10] = true;
        let mask = Mask { x0: 0, y0: 0, w, h, bits };
        let sel = masked_tiles(&tiles, &mask);
        assert_eq!(sel.len(), 1);
        let t = tiles[sel[0]];
        assert!(t.ox <= 10 && 10 < t.ox + t.iw && t.oy <= 10 && 10 < t.oy + t.ih);
    }

    #[test]
    fn masked_tiles_empty_for_empty_mask() {
        let tiles = plan_tiles(200, 200, 128, 8);
        let mask = Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
        assert!(masked_tiles(&tiles, &mask).is_empty());
    }
}
```

- [ ] **Step 2: Make `plan_tiles`/`Tile` reusable** — in `app/src-tauri/src/upscale/engine.rs` they are already `pub`. Confirm `pub fn plan_tiles` and `pub struct Tile` (they are, per the file). No change needed if already public.

- [ ] **Step 3: Create `mod.rs`**

```rust
//! Local AI dust & hair removal. ALL ONNX/model/download logic lives under this
//! module — the rest of the app only sees the commands in `commands.rs`.

pub mod assets;
pub mod engine;

/// Tiling for both nets (256px tiles, 16px overlap), matching the upscaler.
pub const TILE: usize = 256;
pub const TILE_PAD: usize = 16;

/// Connected-component pixel cap above which a region is treated as a real
/// feature, not a defect, and dropped from the mask. Scales with image area in
/// the caller; this is the base value for a ~2k-long image.
pub const MAX_BLOB: usize = 600;
```

- [ ] **Step 4: Add `mod autodust;` to `lib.rs`** next to the existing module declarations (search for `mod upscale;` and add `mod autodust;` beside it).

- [ ] **Step 5: Create a placeholder `assets.rs`** so the module compiles (real content in Task 2.2):

```rust
//! Download + integrity-check the two ONNX models for AI dust removal.
//! Assets live under <app_data>/autodust/. Runtime dylib is shared with the
//! upscaler (see upscale::assets).
// Filled in Task 2.2.
```

- [ ] **Step 6: Run the test**

Run: `cargo test -p app masked_tiles` (adjust crate name to the `src-tauri` package name in its `Cargo.toml`)
Expected: PASS (both tests)

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/autodust/ app/src-tauri/src/lib.rs
git commit -m "feat(autodust): module skeleton + masked_tiles tile-selection helper"
```

### Task 2.2: Asset download + verify (mirror `upscale/assets.rs`)

**Files:**
- Modify: `app/src-tauri/src/autodust/assets.rs`

- [ ] **Step 1: Implement** by copying `app/src-tauri/src/upscale/assets.rs` and adapting:
  - Directory: `<app_data>/autodust/` (function `dir`).
  - `required()` returns **two** `Asset`s: `detector.onnx` and `migan.onnx` (NO runtime asset here — reuse `crate::upscale::assets::runtime_path` for `ORT_DYLIB_PATH`, and include the runtime in the download only if `upscale::assets` hasn't already installed it).
  - URLs/sha256/size are placeholders until Phase 6 (same convention as the upscaler — see the `RELEASE CONFIG` comment block there). Keep the same "verify-in-memory-before-write" download logic.
  - Emit progress on event `autodust://download-progress`.
  - Expose `detector_path(app_data)`, `migan_path(app_data)`, `installed(app_data)`, `status(app_data) -> Status`, `total_download_bytes()`, `download(app, app_data)`.
  - For the shared runtime: `installed()` must also require the upscaler runtime dylib to be present (check `crate::upscale::assets::runtime_path(app_data).exists()`); if missing, `download()` fetches it too (reuse the upscaler RUNTIME asset constant via a shared helper, or duplicate the constant — duplication is acceptable to keep modules independent).

- [ ] **Step 2: Port the asset unit tests** from `upscale/assets.rs` (`sha256_known_vector`, `installed_false_when_missing`, a `required_lists_two_models` test).

- [ ] **Step 3: Build + test**

Run: `cargo test -p app autodust` and `cargo build -p app`
Expected: PASS / builds clean.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/autodust/assets.rs
git commit -m "feat(autodust): downloadable, sha256-verified model assets (gate)"
```

### Task 2.3: Detector + inpainter inference (`engine.rs`)

**Files:**
- Modify: `app/src-tauri/src/autodust/engine.rs`

Build the two inference functions, modeled on `upscale::engine` (`make_session`, `run_tile`). Use the I/O contract recorded in Phase 0 (input/output names via `session.inputs()[0].name()`, normalization, channel order).

- [ ] **Step 1: `detect`** — runs the detector tiled over a positive `Image`, returns a whole-frame `Vec<f32>` probability map (length `w*h`, values in [0,1]).

```rust
use crate::autodust::{TILE, TILE_PAD};
use crate::upscale::assets as up_assets;
use crate::autodust::assets;
use film_core::Image;
use ndarray::Array4;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use std::path::Path;
use std::sync::Once;

static INIT: Once = Once::new();
fn init_runtime(app_data: &Path) {
    INIT.call_once(|| {
        std::env::set_var("ORT_DYLIB_PATH", up_assets::runtime_path(app_data));
    });
}

fn make_session(app_data: &Path, model: &Path) -> Result<Session, String> {
    init_runtime(app_data);
    let builder = Session::builder().map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let builder = { use ort::execution_providers::CoreMLExecutionProvider;
        builder.with_execution_providers([CoreMLExecutionProvider::default().build()]).map_err(|e| e.to_string())? };
    #[cfg(target_os = "windows")]
    let builder = { use ort::execution_providers::DirectMLExecutionProvider;
        builder.with_execution_providers([DirectMLExecutionProvider::default().build()]).map_err(|e| e.to_string())? };
    let mut builder = builder;
    builder.commit_from_file(model).map_err(|e| format!("load model: {e}"))
}

/// Run the detector over `src` (positive RGB f32 [0,1]) → probability map in [0,1].
/// NOTE: convert to the detector's expected input per Phase 0 notes (grayscale +
/// normalization). Output is resampled/cropped back to per-tile inner rects and
/// stitched into the full-frame map.
pub fn detect(app_data: &Path, src: &Image) -> Result<Vec<f32>, String> {
    let mut session = make_session(app_data, &assets::detector_path(app_data))?;
    let tiles = plan_tiles(src.width, src.height, TILE, TILE_PAD);
    let mut prob = vec![0f32; src.width * src.height];
    for t in &tiles {
        // Build the model input from the padded tile (grayscale per Phase 0).
        // Run, read the single-channel output, sigmoid if the model emits logits,
        // then copy the inner (unpadded) rect into `prob`.
        // ... (fill per Phase 0 I/O contract; pattern matches upscale::run_tile) ...
        let _ = (&mut session, t); // replaced by real inference
    }
    Ok(prob)
}
```

> The inner per-tile inference body is left to follow the Phase 0 I/O contract exactly (input tensor name/shape/dtype, grayscale conversion, sigmoid-on-logits if needed, output tensor name). Use `upscale::engine::run_tile` as the structural template (build `Array4`, `Tensor::from_array`, `session.run(ort::inputs![...])`, `try_extract_array`, copy inner rect out).

- [ ] **Step 2: `inpaint`** — fills `img` (RGB f32 [0,1]) in place using MI-GAN, only on tiles selected by `masked_tiles`. For each selected tile, build the MI-GAN input (image + mask, at the model's fixed resolution per Phase 0; resize tile→model res→back), run, and write back **only masked pixels** (read-modify-write like `inpaint_masked` does).

```rust
/// Inpaint the masked pixels of `img` using MI-GAN, tile by tile, only where the
/// mask has content. Falls back to leaving pixels untouched on a per-tile error
/// (degrading a render beats aborting it — same policy as dust::inpaint_masked).
pub fn inpaint(app_data: &Path, img: &mut Image, mask: &Mask) -> Result<(), String> {
    if mask.w == 0 || mask.h == 0 { return Ok(()); }
    let mut session = make_session(app_data, &assets::migan_path(app_data))?;
    let tiles = plan_tiles(img.width, img.height, TILE, TILE_PAD);
    for &i in &masked_tiles(&tiles, mask) {
        let t = tiles[i];
        // build padded RGB + mask sub-windows, resize to MI-GAN input res, run,
        // resize result back, write masked pixels only. (Phase 0 I/O contract.)
        let _ = (&mut session, t);
    }
    Ok(())
}
```

- [ ] **Step 3: Build**

Run: `cargo build -p app`
Expected: builds clean (the tile-body TODOs replaced with real inference referencing Phase 0 names).

- [ ] **Step 4: Manual smoke test** — with the Phase 0 `.onnx` files placed under `<app_data>/autodust/`, add a temporary `#[test]` (or a `cargo` example) that loads one scan, calls `detect` then `prob_defect_mask` then `inpaint`, and writes the result PNG. Eyeball it. Remove the throwaway test after.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/autodust/engine.rs
git commit -m "feat(autodust): detector + MI-GAN inpaint inference (ort)"
```

---

## Phase 3 — Commands + pipeline integration

### Task 3.1: Session cache for the probability map

**Files:**
- Modify: `app/src-tauri/src/session.rs` (add a field beside `pending_upscale`)

- [ ] **Step 1:** Add to the `Session` struct a cache keyed by image id:

```rust
/// Cached AI-dust probability map per image id (w*h f32 in [0,1]), plus dims.
/// Detector runs once; the sensitivity slider only re-thresholds + re-fills.
pub autodust_prob: std::sync::Mutex<std::collections::HashMap<String, (usize, usize, Vec<f32>)>>,
```

Initialize it in `Session::new`/`Default` (mirror how `pending_upscale` is initialized — search `pending_upscale` in `session.rs`).

- [ ] **Step 2: Build**

Run: `cargo build -p app`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(autodust): per-image probability-map cache in Session"
```

### Task 3.2: `AutoDust` ViewSpec field + helper to apply it

**Files:**
- Modify: `app/src-tauri/src/commands.rs`

- [ ] **Step 1:** Add the settings struct next to `IrRemoval` (~line 645):

```rust
/// AI auto dust/hair removal settings from the UI.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AutoDust {
    pub enabled: bool,
    pub sensitivity: f32,
}
```

- [ ] **Step 2:** Add to `ViewSpec` (beside `ir_removal`, ~line 690):

```rust
    #[serde(default)]
    pub auto_dust: AutoDust,
```

- [ ] **Step 3:** Add a helper that mirrors `dust::apply_ir`, but uses the cached prob map (detecting + caching on first use). It takes the positive image, the session, the image id, and the settings:

```rust
/// Apply AI auto dust/hair removal to a POSITIVE image in place. Uses the
/// Session-cached probability map (runs the detector once per image, then
/// caches). No-op when disabled or models aren't installed. `max_blob` scales
/// with image area so the size-gate is resolution-independent.
fn apply_autodust(
    app_data: &std::path::Path,
    session: &Session,
    id: &str,
    img: &mut film_core::Image,
    ad: &AutoDust,
) {
    if !ad.enabled || !crate::autodust::assets::installed(app_data) {
        return;
    }
    let key_dims = (img.width, img.height);
    let prob = {
        let mut cache = session.autodust_prob.lock().unwrap();
        match cache.get(id) {
            Some((w, h, p)) if (*w, *h) == key_dims => p.clone(),
            _ => {
                let p = match crate::autodust::engine::detect(app_data, img) {
                    Ok(p) => p,
                    Err(_) => return, // leave image untouched on detector failure
                };
                cache.insert(id.to_string(), (key_dims.0, key_dims.1, p.clone()));
                p
            }
        }
    };
    let max_blob = crate::autodust::MAX_BLOB
        * (img.width.max(img.height)).max(1) / 2000;
    let mask = film_core::dust::prob_defect_mask(
        img.width, img.height, &prob, ad.sensitivity, max_blob.max(1));
    if mask.bits.iter().any(|&b| b) {
        let _ = crate::autodust::engine::inpaint(app_data, img, &mask);
    }
}
```

- [ ] **Step 4:** Find every `dust::apply_ir(&mut inv, ...)` call site (commands.rs lines ~775, ~803, ~951, ~1004 — grep `apply_ir`) and add `apply_autodust(&app_data, &session, &id, &mut inv, &view.auto_dust)` (or the matching local var names at that site) immediately after it. **At each site**, document in a one-line comment whether `inv` is the positive image (it is, in the `apply_ir` sites). Obtain `app_data` the same way the upscale commands do (`app.path().app_data_dir()` / however that site resolves it) and `session`/`id` from the surrounding function args.

> If a call site does not have `session`/`id`/`app_data` in scope, thread them through that function's signature (these are CPU preview/thumbnail/export functions; the callers already have `session` and `id`).

- [ ] **Step 5: Build**

Run: `cargo build -p app`
Expected: builds clean.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(autodust): AutoDust ViewSpec field + apply_autodust at the apply_ir sites"
```

### Task 3.3: Status / download / detect commands

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs` (register in `generate_handler!`)

- [ ] **Step 1: Add commands** (mirror `upscaler_status` / `download_upscaler` at ~line 1962):

```rust
/// Whether the AI-dust models (+ shared runtime) are installed, and download size.
#[tauri::command]
pub fn autodust_status(app: tauri::AppHandle) -> Result<crate::autodust::assets::Status, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::autodust::assets::status(&app_data))
}

/// Download + verify the AI-dust assets, emitting `autodust://download-progress`.
#[tauri::command]
pub async fn download_autodust(app: tauri::AppHandle) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::autodust::assets::download(&app, &app_data).await
}

/// Run detection now (populates the Session prob-map cache) and return the count
/// of defect pixels found at the given sensitivity, so the panel can show a
/// readout. Rendering of the fill happens via the normal ViewSpec/bake path.
#[tauri::command]
pub fn autodust_detect(
    app: tauri::AppHandle,
    session: tauri::State<Session>,
    id: String,
    params: InvertParams,
    image_crop: Option<[f64; 4]>,
    geom: GeomArgs,         // use the SAME geom/params types the upscale_image command uses
    sensitivity: f32,
) -> Result<u32, String> {
    // 1. Develop/finish the positive image for `id` at full-or-preview res — reuse
    //    whatever helper upscale_image uses to obtain the finished `Image` (`fin`).
    // 2. let app_data = app.path().app_data_dir()?;
    // 3. crate::autodust::engine::detect → cache into session.autodust_prob[id].
    // 4. prob_defect_mask at `sensitivity` → count set bits → return as u32.
    unimplemented!("wire using the same finished-image helper as upscale_image")
}
```

> Replace `GeomArgs`/the finished-image step with the exact types/helper `upscale_image` (commands.rs ~line 1980) already uses — read that command and mirror its argument list and its `fin` acquisition. Keep `autodust_detect` signature aligned with `upscaleImage` in `api.ts`.

- [ ] **Step 2: Register** all three in `lib.rs` `generate_handler![...]` next to `upscaler_status, download_upscaler, upscale_image`:

```rust
            commands::autodust_status,
            commands::download_autodust,
            commands::autodust_detect,
```

- [ ] **Step 3: Build**

Run: `cargo build -p app`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(autodust): status/download/detect Tauri commands"
```

---

## Phase 4 — Frontend state + API

### Task 4.1: Extend dust state with `autoDust`

**Files:**
- Modify: `app/src/lib/develop/dust.ts`

- [ ] **Step 1:** Add the interface + field + helpers (mirror `IrRemoval`):

```ts
/** AI auto dust/hair removal settings. */
export interface AutoDust { enabled: boolean; sensitivity: number }
/** Per-image dust edit state. */
export interface DustEdits { strokes: DustStroke[]; irRemoval: IrRemoval; autoDust: AutoDust }
```

Update `emptyDust` and add setters:

```ts
export const emptyDust = (): DustEdits => ({
  strokes: [],
  irRemoval: { enabled: false, sensitivity: 50 },
  autoDust: { enabled: false, sensitivity: 50 },
});

export function setAutoDustEnabled(d: DustEdits, enabled: boolean): DustEdits {
  return { ...d, autoDust: { ...d.autoDust, enabled } };
}
export function setAutoDustSensitivity(d: DustEdits, sensitivity: number): DustEdits {
  return { ...d, autoDust: { ...d.autoDust, sensitivity } };
}
```

> Check for any code that constructs `DustEdits` literally or persists/loads it (catalog persistence). Add `autoDust` defaulting to the empty value on load so older saved edits stay valid.

- [ ] **Step 2: Build the frontend**

Run: `cd app && npm run check` (or the project's typecheck script)
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/develop/dust.ts
git commit -m "feat(autodust): autoDust field + setters in dust state"
```

### Task 4.2: Store + API methods

**Files:**
- Modify: `app/src/lib/store.ts` (add `autodustInstalled`)
- Modify: `app/src/lib/api.ts` (add methods + wire `auto_dust` into the view payload)

- [ ] **Step 1: store.ts** — beside `upscalerInstalled` (line 131):

```ts
export const autodustInstalled = writable<boolean>(false);
```

- [ ] **Step 2: api.ts** — add to the `api` object (mirror the upscaler methods ~line 215):

```ts
  autodustStatus: () =>
    invoke<{ installed: boolean; downloadBytes: number }>("autodust_status"),
  downloadAutodust: () => invoke<void>("download_autodust"),
  autodustDetect: (
    id: string,
    params: InvertParams,
    imageCrop: [number, number, number, number] | null,
    geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number },
    sensitivity: number,
  ) =>
    invoke<number>("autodust_detect", { id, params, imageCrop, geom, sensitivity }),
```

- [ ] **Step 3: api.ts** — find where `ir_removal` is added to the view payload (grep `ir_removal` in api.ts — the `WireView`/`InvertParams` view object around lines 100–116 / 238 in Develop) and add `auto_dust` alongside it, sourced from `DustEdits.autoDust`.

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/api.ts
git commit -m "feat(autodust): autodustInstalled store + api methods + auto_dust payload"
```

---

## Phase 5 — UI + i18n + Develop wiring

### Task 5.1: i18n strings

**Files:**
- Modify: `i18n-strings.csv`
- Generated: `app/src/lib/i18n/dict.ts` (via script — never hand-edit)

- [ ] **Step 1:** Append rows to `i18n-strings.csv` (after the `eraser.*` block, ~line 251). Provide en + zh:

```
eraser.autoTitle,"Auto remove dust & hair · AI","自动去除灰尘和毛发 · AI","src/lib/develop/EraserPanel.svelte","heading"
eraser.autoLocal,"local","本地","src/lib/develop/EraserPanel.svelte","label"
eraser.autoDownloadPrompt,"Download the local AI models (~{mb} MB) to auto-detect and remove dust & hairs on-device.","下载本地 AI 模型（约 {mb} MB），在设备端自动检测并去除灰尘和毛发。","src/lib/develop/EraserPanel.svelte","text"
eraser.autoDownload,"Download AI models","下载 AI 模型","src/lib/develop/EraserPanel.svelte","button"
eraser.autoButton,"Detect & remove","检测并去除","src/lib/develop/EraserPanel.svelte","button"
eraser.autoWorking,"Detecting…","检测中…","src/lib/develop/EraserPanel.svelte","button"
eraser.autoCount,"{n} spots removed","已去除 {n} 处","src/lib/develop/EraserPanel.svelte","text"
eraser.autoChecking,"Checking AI models…","正在检查 AI 模型…","src/lib/develop/EraserPanel.svelte","text"
eraser.autoHint,"Runs local AI models on your device (no upload). Use the sensitivity slider if it removes too much or too little.","在本地设备上运行 AI 模型（不上传）。如果去除过多或过少，请使用灵敏度滑块。","src/lib/develop/EraserPanel.svelte","hint"
```

- [ ] **Step 2: Regenerate**

Run: `python3 scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` updated with the new keys.

- [ ] **Step 3: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "i18n(autodust): strings for AI dust & hair removal"
```

### Task 5.2: Auto-remove UI block in `EraserPanel.svelte`

**Files:**
- Modify: `app/src/lib/develop/EraserPanel.svelte`

- [ ] **Step 1:** Add props + events for the AI block and a download gate. New props:

```ts
  export let autoEnabled = false;
  export let autoSensitivity = 50;
```

New dispatch events: `autoEnabled: boolean`, `autoSensitivity: number`, `autoDetect: void`.

- [ ] **Step 2:** Add the block above the existing IR block, using `autodustInstalled` (imported from `../store`), `api.autodustStatus()`/`downloadAutodust()` for the gate, and listening to `autodust://download-progress` — copy the gate structure from `UpscalePanel.svelte` (checking / download prompt + progress bar / installed states). When installed: a `Detect & remove` button (dispatches `autoDetect`, shows a spinner while busy + the `{n} spots removed` count when done), then the On/Off toggle (`autoEnabled`) and a Sensitivity slider (`autoSensitivity`) styled exactly like the existing IR `.slrow`. Reuse the existing `.ir`, `.slrow`, `.val`, `.sub` styles; add an `.exp`/badge style copied from `UpscalePanel`.

> The sensitivity slider dispatches `autoSensitivity` on `change` (not `input`) to debounce re-fill (each change re-runs MI-GAN fill). Add a brief code comment saying why.

- [ ] **Step 3: Typecheck**

Run: `cd app && npm run check`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/develop/EraserPanel.svelte
git commit -m "feat(autodust): auto-remove UI block (gate + detect + sensitivity) in EraserPanel"
```

### Task 5.3: Wire `EraserPanel` events in `Develop.svelte`

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte`

- [ ] **Step 1:** Import the new setters and add handlers mirroring `setIrOn`/`setIrSens` (~line 260):

```ts
  import { addStroke, resetDust, emptyDust, setIrEnabled, setIrSensitivity,
           setAutoDustEnabled, setAutoDustSensitivity, type DustStroke, type DustEdits } from "../develop/dust";

  function setAutoOn(on: boolean) { updateDust((d) => setAutoDustEnabled(d, on)); }
  function setAutoSens(v: number) { updateDust((d) => setAutoDustSensitivity(d, v)); }

  let autoCount: number | null = null;
  let autoBusy = false;
  async function runAutoDetect() {
    if (!$activeId) return;
    autoBusy = true;
    try {
      autoCount = await api.autodustDetect($activeId, effParams, imageCrop, geom, dust.autoDust.sensitivity);
      // enabling triggers the bake path to render the fill via auto_dust in the ViewSpec
      updateDust((d) => setAutoDustEnabled(d, true));
    } catch (e) { /* surface via existing error channel */ }
    finally { autoBusy = false; }
  }
```

- [ ] **Step 2:** Pass props/events to `<EraserPanel>` (~line 343):

```svelte
            <EraserPanel bind:brush {hasIr}
                         irEnabled={dust.irRemoval.enabled} irSensitivity={dust.irRemoval.sensitivity}
                         autoEnabled={dust.autoDust.enabled} autoSensitivity={dust.autoDust.sensitivity}
                         autoBusy={autoBusy} autoCount={autoCount}
                         on:reset={...} on:brush={...}
                         on:irEnabled={(e) => setIrOn(e.detail)}
                         on:irSensitivity={(e) => setIrSens(e.detail)}
                         on:autoEnabled={(e) => setAutoOn(e.detail)}
                         on:autoSensitivity={(e) => setAutoSens(e.detail)}
                         on:autoDetect={runAutoDetect} />
```

(Add `autoBusy`/`autoCount` as props in EraserPanel from Task 5.2 if not already; keep names consistent.)

- [ ] **Step 3:** Confirm `auto_dust` is included where the view payload is built (the `dust: d.strokes, ir_removal: d.irRemoval` object at ~line 238). Add `auto_dust: d.autoDust`.

- [ ] **Step 4:** Ensure `updateDust` bumps `dustRev` so the Viewport re-bakes (it already does — line 256). Sensitivity/enable changes therefore re-render through `auto_dust` in the ViewSpec.

- [ ] **Step 5: Typecheck + build**

Run: `cd app && npm run check`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/tabs/Develop.svelte
git commit -m "feat(autodust): wire auto-remove events + payload in Develop"
```

### Task 5.4: End-to-end manual verification

- [ ] **Step 1:** `cd app && npm run tauri dev` (or the project's run skill). Open a scan with visible dust/hairs.
- [ ] **Step 2:** Eraser tool → the AI block shows the download gate → download → models install.
- [ ] **Step 3:** Click **Detect & remove** → spinner → count appears → dust/hairs gone in the viewport.
- [ ] **Step 4:** Drag Sensitivity up/down → fill updates (more/less removed). Toggle Off → original returns. On → fill returns.
- [ ] **Step 5:** Export the image → confirm the fill is baked into the exported file.
- [ ] **Step 6:** Switch images and back → settings persist; re-detect works.

---

## Phase 6 — Release wiring (do before shipping)

### Task 6.1: Host + checksum the model assets

**Files:**
- Modify: `app/src-tauri/src/autodust/assets.rs`
- Modify: `docs/upscaler-assets.md` (or a new `docs/autodust-assets.md`)

- [ ] **Step 1:** Build/convert final `detector.onnx` + `migan.onnx`, upload as GitHub release assets (same hosting as the upscaler model).
- [ ] **Step 2:** Compute SHA-256 + byte size of each; replace the placeholder `url`/`sha256`/`size` constants in `assets.rs`.
- [ ] **Step 3:** Verify model **licenses** permit redistribution in the app; record them in the assets doc. If the detector's license is incompatible, swap to the CV-detector fallback (no architecture change).
- [ ] **Step 4:** Fresh-machine test: delete `<app_data>/autodust/`, launch, download via the gate, confirm checksums pass and the feature works.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/autodust/assets.rs docs/
git commit -m "release(autodust): real model asset URLs, checksums, license notes"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** detect→mask→fill (Tasks 1.1, 2.3, 3.2), two-stage learned models (Phase 0, 2.3), one-click + sensitivity (5.2/5.3), download gate (2.2, 5.2), prob-map cache so the slider re-thresholds without re-detect (3.1, 3.2), Phase 0 spike gate (Phase 0), license verification (6.1), i18n via CSV+script (5.1), no changes to brush/IR paths (apply_autodust is additive). All covered.
- **Inference glue is not unit-tested** by design (no deterministic ONNX test without a model); it is verified by build + the Phase 0 / Task 2.3 / Task 5.4 manual runs. The *pure* logic (`prob_defect_mask`, `masked_tiles`, assets) is TDD'd.
- **Type consistency:** `AutoDust`/`auto_dust` (Rust) ↔ `autoDust` (TS) ↔ `auto_dust` (wire payload); `autodust_status`/`download_autodust`/`autodust_detect` match `api.ts` `autodustStatus`/`downloadAutodust`/`autodustDetect`. `prob_defect_mask`, `masked_tiles`, `detect`, `inpaint`, `apply_autodust` names are used consistently across tasks.
- **Known follow-up to resolve during impl (not placeholders):** `autodust_detect`'s exact arg list + finished-image acquisition must mirror `upscale_image` (read it); the `apply_ir` call sites must be confirmed to operate on the positive image and have `session`/`id`/`app_data` in scope (thread them if not). These are explicit "read X and mirror" instructions, not deferred design.
