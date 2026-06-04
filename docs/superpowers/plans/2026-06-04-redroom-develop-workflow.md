# RedRoom Library-First Develop Workflow + Preview Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make import instant (thumbnail + metadata, no decode), add an explicit "Develop all" batch (decode at a Preview-Quality cap, drop full-res) with progress that switches to Develop, disable Develop until images exist, and add an early-jump confirm popup.

**Architecture:** `import_image` becomes light (embedded-preview thumbnail + metadata + stored path). A new `develop_image(id)` decodes the file, builds the working image at the quality cap (4096 Performance / full Quality) + a small auto-WB thumb + base, and caches them (no permanent full_res). `render_view` runs on the developed working image; `export_image` re-decodes full-res from the path. The frontend orchestrates a sequential develop-all flow with a progress overlay, tab-disable logic, a confirm popup, and a quality context menu.

**Tech Stack:** Rust (Tauri commands, `image`, `rawler`, film-core), Svelte 5 (SvelteKit), TypeScript, vitest.

**Reference spec:** `docs/superpowers/specs/2026-06-04-redroom-develop-workflow-design.md`

**Environment:** Work from `/Users/mohaelder/Repos/filmrev`, branch `feat/inversion-poc`. `cargo` NOT on PATH — prefix with `source "$HOME/.cargo/env" && `. Backend tests: `(cd app/src-tauri && cargo test <filter>)`. Frontend build: `(cd app && npm run build)`. Frontend unit: `(cd app && npx vitest run)`.

---

## File Structure

```
app/src-tauri/src/
├── session.rs    Quality enum (+cap, Default); Developed{working,thumb,base};
│                 CachedImage{path,file_name,metadata,thumbnail,developed:Option<Developed>};
│                 Session.quality; ImageEntry.developed:bool
├── commands.rs   import_image (LIGHT); develop_image; set_quality; render_view (on developed);
│                 export_image (re-decode full-res)
└── lib.rs        register import_image, develop_image, set_quality, render_view, export_image
app/src/lib/
├── store.ts            quality, developProgress writables; allDeveloped, canDevelop derived
├── api.ts              developImage, setQuality; ImageEntry.developed
├── workflow.ts         developAll() orchestration (pure-ish, testable reducer + flow)
├── workflow.test.ts    vitest for the progress reducer + allDeveloped
├── panels/Source.svelte         "Develop all" button
├── overlay/ProgressOverlay.svelte   develop progress overlay
├── overlay/ConfirmDevelop.svelte    early-jump confirm modal
├── viewport/QualityMenu.svelte      right-click Performance/Quality menu
├── tabs/Library.svelte    center shows thumbnail (no render/zoom in Library)
├── tabs/Develop.svelte    Viewport on developed image
└── App.svelte             Develop tab disabled when empty; popup when jumping early
```

---

## Task 1: Backend session restructure (Quality, Developed, light CachedImage)

**Files:** Modify `app/src-tauri/src/session.rs`.

- [ ] **Step 1: Rewrite session.rs**

Replace the contents of `app/src-tauri/src/session.rs` with:

```rust
//! In-memory session: lightweight image records (path + thumbnail + metadata),
//! with decoded working data filled in lazily by `develop_image`.

use crate::metadata::Metadata;
use film_core::Image;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Preview render quality: caps the decoded working-image resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Performance,
    Quality,
}

impl Quality {
    /// Max long-edge (px) for the working image. Quality = no cap.
    pub fn cap(self) -> u32 {
        match self {
            Quality::Performance => 4096,
            Quality::Quality => u32::MAX,
        }
    }
}

impl Default for Quality {
    fn default() -> Self {
        Quality::Performance
    }
}

/// Knobs the UI sends for an inversion (mirrors the engine's exposed controls).
#[derive(Debug, Clone, Deserialize)]
pub struct InvertParams {
    pub mode: String,
    pub stock: String,
    pub base_rect: Option<[usize; 4]>,
    pub exposure: f32,
    pub black: f32,
    pub gamma: f32,
    pub auto_wb: bool,
    pub temp: f32,
    pub tint: f32,
}

/// What the frontend gets per image.
#[derive(Debug, Clone, Serialize)]
pub struct ImageEntry {
    pub id: String,
    pub file_name: String,
    pub thumbnail: String,
    pub metadata: Metadata,
    pub developed: bool,
}

/// Decoded working data, present once an image is developed.
pub struct Developed {
    /// Decoded RGB at the quality cap — what previews render from.
    pub working: Image,
    /// Small (~256px) copy of `working` for the cheap auto-WB pass.
    pub thumb: Image,
    /// Film base (orange mask) sampled from `working`.
    pub base: [f32; 3],
}

/// A session image: always has path/metadata/thumbnail; `developed` is lazy.
pub struct CachedImage {
    pub path: String,
    pub file_name: String,
    pub metadata: Metadata,
    pub thumbnail: String,
    pub developed: Option<Developed>,
}

#[derive(Default)]
pub struct Session {
    pub images: Mutex<HashMap<String, CachedImage>>,
    pub next_id: Mutex<u64>,
    pub quality: Mutex<Quality>,
}

impl Session {
    pub fn insert(&self, img: CachedImage) -> ImageEntry {
        let mut id_guard = self.next_id.lock().unwrap();
        let id = format!("img{}", *id_guard);
        *id_guard += 1;
        drop(id_guard);
        let entry = ImageEntry {
            id: id.clone(),
            file_name: img.file_name.clone(),
            thumbnail: img.thumbnail.clone(),
            metadata: img.metadata.clone(),
            developed: img.developed.is_some(),
        };
        self.images.lock().unwrap().insert(id, img);
        entry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_cap_values() {
        assert_eq!(Quality::Performance.cap(), 4096);
        assert_eq!(Quality::Quality.cap(), u32::MAX);
        assert_eq!(Quality::default(), Quality::Performance);
    }

    #[test]
    fn quality_deserializes_from_lowercase() {
        let p: Quality = serde_json::from_str("\"performance\"").unwrap();
        let q: Quality = serde_json::from_str("\"quality\"").unwrap();
        assert_eq!(p, Quality::Performance);
        assert_eq!(q, Quality::Quality);
    }

    #[test]
    fn insert_reports_undeveloped_then_assigns_ids() {
        let s = Session::default();
        let img = CachedImage {
            path: "/x/a.dng".into(),
            file_name: "a.dng".into(),
            metadata: Metadata::default(),
            thumbnail: "data:,".into(),
            developed: None,
        };
        let e = s.insert(img);
        assert_eq!(e.id, "img0");
        assert!(!e.developed);
    }
}
```

- [ ] **Step 2: Run tests**

Run: `source "$HOME/.cargo/env" && (cd app/src-tauri && cargo test session::)`
Expected: 3 tests PASS. (The crate won't fully build until Task 2 updates commands.rs to the new
shapes — run `cargo test session::` which compiles the lib; if commands.rs references old fields
it will fail to compile. In that case proceed to Task 2 and run tests at the end of Task 2.)

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(redroom): session restructure — Quality, lazy Developed, light CachedImage"
```

---

## Task 2: Backend commands (light import, develop_image, set_quality, render_view, export)

**Files:** Modify `app/src-tauri/src/commands.rs`, `app/src-tauri/src/lib.rs`.

- [ ] **Step 1: Rewrite commands.rs**

Replace the contents of `app/src-tauri/src/commands.rs` with:

```rust
//! Tauri commands orchestrating film-core for the RedRoom UI.

use crate::convert::{proxy, resize_to};
use crate::encode::{to_jpeg_b64, to_png_b64};
use crate::metadata::extract;
use crate::session::{CachedImage, Developed, ImageEntry, InvertParams, Quality, Session};
use film_core::calibrate::{auto_wb_gains, sample_base, Rect};
use film_core::decode::{decode_raw, decode_tiff};
use film_core::engine::{invert_image, params_for_stock, InversionParams, Mode};
use film_core::spectral::Stock;
use serde::Deserialize;
use std::path::Path;
use tauri::State;

const THUMB_EDGE: u32 = 320;
const AUTOWB_EDGE: u32 = 256;
const PREVIEW_JPEG_QUALITY: u8 = 88;

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

fn wb_from_temp_tint(temp: f32, tint: f32) -> [f32; 3] {
    let r = (1.0 + 0.4 * temp + 0.2 * tint).max(0.1);
    let g = (1.0 - 0.4 * tint).max(0.1);
    let b = (1.0 - 0.4 * temp + 0.2 * tint).max(0.1);
    [r, g, b]
}

fn resolve_params(p: &InvertParams, autowb_src: &film_core::Image, base: [f32; 3]) -> InversionParams {
    let manual = wb_from_temp_tint(p.temp, p.tint);
    let mut ip = build_params(p, base);
    ip.wb = manual;
    if p.auto_wb {
        let first = invert_image(autowb_src, &ip, mode_from(&p.mode));
        let auto = auto_wb_gains(&first);
        ip.wb = [manual[0] * auto[0], manual[1] * auto[1], manual[2] * auto[2]];
    }
    ip
}

/// LIGHT import: thumbnail (embedded preview if available) + metadata + stored
/// path. No full decode — the heavy work happens in `develop_image`.
#[tauri::command]
pub fn import_image(path: String, session: State<Session>) -> Result<ImageEntry, String> {
    let p = Path::new(&path);
    // Embedded preview via the tiff reader (DNGs expose a small preview IFD).
    // Falls back to a neutral placeholder if unavailable (e.g. some RAFs); the
    // real image appears after develop.
    let thumbnail = match decode_tiff(p) {
        Ok(prev) => to_png_b64(&proxy(&prev, THUMB_EDGE), true)?,
        Err(_) => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string(),
    };
    let metadata = extract(p, 0, 0); // full dims filled in at develop time
    let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let cached = CachedImage { path, file_name, metadata, thumbnail, developed: None };
    Ok(session.insert(cached))
}

/// HEAVY step: decode the file, build the working image at the quality cap, a
/// small auto-WB thumb, and sample the base. Drops full_res. Returns the updated
/// entry (now with real dimensions + developed=true).
#[tauri::command]
pub fn develop_image(id: String, session: State<Session>) -> Result<ImageEntry, String> {
    let cap = session.quality.lock().unwrap().cap();
    let path = {
        let images = session.images.lock().unwrap();
        images.get(&id).ok_or("unknown image id")?.path.clone()
    };
    let full = decode_any(Path::new(&path))?;
    let working = proxy(&full, cap);
    let thumb = proxy(&full, AUTOWB_EDGE);
    let base = sample_base(&working, None);
    let (w, h) = (full.width as u32, full.height as u32);
    drop(full);

    let mut images = session.images.lock().unwrap();
    let img = images.get_mut(&id).ok_or("unknown image id")?;
    img.metadata.width = w;
    img.metadata.height = h;
    img.developed = Some(Developed { working, thumb, base });
    Ok(ImageEntry {
        id: id.clone(),
        file_name: img.file_name.clone(),
        thumbnail: img.thumbnail.clone(),
        metadata: img.metadata.clone(),
        developed: true,
    })
}

#[tauri::command]
pub fn set_quality(quality: Quality, session: State<Session>) -> Result<(), String> {
    *session.quality.lock().unwrap() = quality;
    Ok(())
}

/// The visible region to render, in FULL-RES pixel coordinates, plus the output
/// (≈ viewport) pixel size. `raw` selects the un-inverted scan.
#[derive(Debug, Clone, Deserialize)]
pub struct ViewSpec {
    pub crop: [f64; 4],
    pub out_w: u32,
    pub out_h: u32,
    pub raw: bool,
}

#[tauri::command]
pub fn render_view(id: String, params: InvertParams, view: ViewSpec, session: State<Session>) -> Result<String, String> {
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;

    // The working image IS the only render source (full_res isn't cached). Map
    // the full-res crop coords into working coords by the working scale.
    let s_scale = dev.working.width as f64 / img.metadata.width.max(1) as f64;

    let cx = (view.crop[0] * s_scale).max(0.0).round() as usize;
    let cy = (view.crop[1] * s_scale).max(0.0).round() as usize;
    let cw = (view.crop[2] * s_scale).round().max(1.0) as usize;
    let ch = (view.crop[3] * s_scale).round().max(1.0) as usize;

    let cropped = crate::convert::crop(&dev.working, cx, cy, cw, ch);
    if cropped.pixels.is_empty() {
        return Err("empty crop".into());
    }
    let scaled = resize_to(&cropped, view.out_w.max(1), view.out_h.max(1));

    if view.raw {
        return to_jpeg_b64(&scaled, true, PREVIEW_JPEG_QUALITY);
    }
    let ip = resolve_params(&params, &dev.thumb, dev.base);
    let inv = invert_image(&scaled, &ip, mode_from(&params.mode));
    to_jpeg_b64(&inv, false, PREVIEW_JPEG_QUALITY)
}

/// Re-decode the file at full resolution and export a 16-bit TIFF. Always
/// full quality regardless of the preview setting.
#[tauri::command]
pub fn export_image(id: String, params: InvertParams, out_path: String, session: State<Session>) -> Result<(), String> {
    let (path, base, thumb) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (img.path.clone(), dev.base, dev.thumb.clone())
    };
    let full = decode_any(Path::new(&path))?;
    let ip = resolve_params(&params, &thumb, base);
    let inv = invert_image(&full, &ip, mode_from(&params.mode));
    film_core::export::write_tiff16(&inv, Path::new(&out_path)).map_err(|e| format!("{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wb_temp_tint_directions() {
        let warm = wb_from_temp_tint(0.5, 0.0);
        assert!(warm[0] > 1.0 && warm[2] < 1.0); // warmer: R up, B down
        let green = wb_from_temp_tint(0.0, -0.5);
        assert!(green[1] > 1.0); // negative tint adds green
    }
}
```

Note: `base_rect` is intentionally unused now (auto base from develop); the field stays on
`InvertParams` for wire-compatibility. If clippy warns about an unused `Rect` import, remove
`Rect` from the `use film_core::calibrate::...` line (keep `auto_wb_gains, sample_base`).

- [ ] **Step 2: Register commands in lib.rs**

In `app/src-tauri/src/lib.rs`, set the handler to:

```rust
        .invoke_handler(tauri::generate_handler![
            commands::import_image,
            commands::develop_image,
            commands::set_quality,
            commands::render_view,
            commands::export_image,
        ])
```

- [ ] **Step 3: Build + test**

Run: `source "$HOME/.cargo/env" && (cd app/src-tauri && cargo build 2>&1 | tail -15 && cargo test 2>&1 | grep 'test result' && cargo clippy 2>&1 | grep -c warning | xargs echo warnings:)`
Expected: compiles; session + commands tests pass; 0 warnings (remove any unused import flagged).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri
git commit -m "feat(redroom): light import + develop_image + set_quality; render/export on developed"
```

---

## Task 3: Frontend store + api

**Files:** Modify `app/src/lib/store.ts`, `app/src/lib/api.ts`.

- [ ] **Step 1: Update api.ts**

In `app/src/lib/api.ts`: add `developed: boolean` to `ImageEntry`, and add `developImage` +
`setQuality` to the `api` object (keep `importImage`, `renderView`, `exportImage`):

```ts
export interface ImageEntry {
  id: string; file_name: string; thumbnail: string; metadata: Metadata; developed: boolean;
}
export type Quality = "performance" | "quality";
```
In the `api` object add:
```ts
  developImage: (id: string) => invoke<ImageEntry>("develop_image", { id }),
  setQuality: (quality: Quality) => invoke<void>("set_quality", { quality }),
```

- [ ] **Step 2: Update store.ts**

Replace `app/src/lib/store.ts` with:

```ts
import { writable, derived } from "svelte/store";
import type { ImageEntry, InvertParams, Quality } from "./api";
import { defaultParams } from "./api";

export const images = writable<ImageEntry[]>([]);
export const activeId = writable<string | null>(null);
export const module = writable<"library" | "develop">("library");
export const params = writable<InvertParams>(defaultParams());
export const quality = writable<Quality>("performance");

/** Develop-all progress. active=true shows the overlay. */
export const developProgress = writable<{ active: boolean; done: number; total: number }>({
  active: false, done: 0, total: 0,
});

export const hasImages = derived(images, ($i) => $i.length > 0);
export const allDeveloped = derived(images, ($i) => $i.length > 0 && $i.every((x) => x.developed));
```

(`Quality` is imported as a type from api.ts — add `export type Quality` there as in Step 1.)

- [ ] **Step 3: Build**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run build 2>&1 | tail -6`
Expected: builds (other components still referencing old shapes are updated in later tasks; if
build fails ONLY due to tabs/Source referencing removed things, that's expected — note and
proceed). The gate for this task is that store.ts/api.ts compile.

- [ ] **Step 4: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/store.ts app/src/lib/api.ts
git commit -m "feat(redroom): store/api for develop state + quality"
```

---

## Task 4: Develop-all orchestration (vitest-tested reducer)

**Files:** Create `app/src/lib/workflow.ts`, `app/src/lib/workflow.test.ts`.

- [ ] **Step 1: workflow.ts**

```ts
import { get } from "svelte/store";
import { images, activeId, module, developProgress } from "./store";
import { api, type ImageEntry } from "./api";

/** Ids of images not yet developed, in order. Pure helper (testable). */
export function undevelopedIds(list: ImageEntry[]): string[] {
  return list.filter((i) => !i.developed).map((i) => i.id);
}

/** Develop every not-yet-developed image sequentially, updating progress, then
 * switch to the Develop module. Resolves when done. */
export async function developAll(): Promise<void> {
  const ids = undevelopedIds(get(images));
  if (ids.length === 0) { module.set("develop"); return; }
  developProgress.set({ active: true, done: 0, total: ids.length });
  for (const id of ids) {
    try {
      const updated = await api.developImage(id);
      images.update((list) => list.map((i) => (i.id === id ? updated : i)));
    } catch (e) {
      // mark failed images so the loop can finish; skip them
      console.error("develop failed", id, e);
    }
    developProgress.update((p) => ({ ...p, done: p.done + 1 }));
  }
  developProgress.set({ active: false, done: ids.length, total: ids.length });
  if (!get(activeId)) {
    const first = get(images)[0];
    if (first) activeId.set(first.id);
  }
  module.set("develop");
}

/** Mark all images undeveloped (used when the quality setting changes). */
export function markAllUndeveloped(): void {
  images.update((list) => list.map((i) => ({ ...i, developed: false })));
}
```

- [ ] **Step 2: workflow.test.ts (vitest)**

```ts
import { describe, it, expect } from "vitest";
import { undevelopedIds } from "./workflow";
import type { ImageEntry } from "./api";

const mk = (id: string, developed: boolean): ImageEntry => ({
  id, file_name: id, thumbnail: "", developed,
  metadata: { width: 0, height: 0, file_size: 0 },
});

describe("undevelopedIds", () => {
  it("returns only not-developed ids in order", () => {
    const list = [mk("a", true), mk("b", false), mk("c", false)];
    expect(undevelopedIds(list)).toEqual(["b", "c"]);
  });
  it("returns empty when all developed", () => {
    expect(undevelopedIds([mk("a", true)])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run vitest**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npx vitest run src/lib/workflow.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/workflow.ts app/src/lib/workflow.test.ts
git commit -m "feat(redroom): develop-all orchestration + tested undevelopedIds"
```

---

## Task 5: UI — Develop-all button, overlays, tab gating, quality menu, tab views

**Files:** Create `app/src/lib/overlay/ProgressOverlay.svelte`, `app/src/lib/overlay/ConfirmDevelop.svelte`, `app/src/lib/viewport/QualityMenu.svelte`; modify `app/src/lib/panels/Source.svelte`, `app/src/lib/tabs/Library.svelte`, `app/src/lib/tabs/Develop.svelte`, `app/src/App.svelte`.

- [ ] **Step 1: ProgressOverlay.svelte**

```svelte
<script lang="ts">
  import { developProgress } from "../store";
  $: p = $developProgress;
  $: pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
</script>

{#if p.active}
  <div class="scrim">
    <div class="card">
      <div class="title">Developing {p.done + 1 > p.total ? p.total : p.done + 1} of {p.total}…</div>
      <div class="bar"><div class="fill" style="width:{pct}%"></div></div>
    </div>
  </div>
{/if}

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(8px);
    display: grid; place-items: center; z-index: 50; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px 26px; min-width: 320px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .title { margin-bottom: 14px; }
  .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width 0.2s; }
</style>
```

- [ ] **Step 2: ConfirmDevelop.svelte**

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let count = 0;
  const dispatch = createEventDispatcher();
</script>

<div class="scrim" on:click|self={() => dispatch("cancel")}>
  <div class="card">
    <div class="title">Develop all {count} image{count === 1 ? "" : "s"}?</div>
    <div class="sub">They'll be decoded and inverted, then opened in Develop.</div>
    <div class="row">
      <button class="ghost" on:click={() => dispatch("cancel")}>Cancel</button>
      <button class="go" on:click={() => dispatch("confirm")}>Develop all</button>
    </div>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 60; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px; min-width: 320px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .title { font-weight: 600; margin-bottom: 6px; }
  .sub { color: var(--text-dim); margin-bottom: 18px; font-size: 12px; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  button { padding: 8px 14px; border-radius: 9px; border: 1px solid var(--glass-brd); background: transparent; }
  .go { background: var(--accent); color: white; border: 0; font-weight: 600; }
</style>
```

- [ ] **Step 3: QualityMenu.svelte**

```svelte
<script lang="ts">
  import { quality } from "../store";
  import { api, type Quality } from "../api";
  import { developAll, markAllUndeveloped } from "../workflow";
  export let x = 0;
  export let y = 0;
  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher();

  async function pick(q: Quality) {
    if (q !== $quality) {
      quality.set(q);
      await api.setQuality(q);
      markAllUndeveloped();
      dispatch("close");
      await developAll(); // rebuild everything at the new cap
    } else {
      dispatch("close");
    }
  }
</script>

<div class="menu" style="left:{x}px; top:{y}px" on:pointerleave={() => dispatch("close")}>
  <div class="head">Preview quality</div>
  <button class:on={$quality === "performance"} on:click={() => pick("performance")}>Performance · 4K</button>
  <button class:on={$quality === "quality"} on:click={() => pick("quality")}>Quality · full res</button>
</div>

<style>
  .menu { position: fixed; z-index: 70; background: var(--glass-bg); border: 1px solid var(--glass-brd);
    border-radius: 10px; padding: 6px; min-width: 180px; backdrop-filter: blur(20px);
    box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  .head { font-size: 11px; color: var(--text-dim); padding: 4px 8px; }
  button { display: block; width: 100%; text-align: left; padding: 7px 8px; border: 0;
    background: transparent; border-radius: 7px; color: var(--text-dim); }
  button.on { color: var(--text); background: rgba(224,52,52,0.16); }
</style>
```

- [ ] **Step 4: Source.svelte — add the Develop-all button**

Replace `app/src/lib/panels/Source.svelte` with:

```svelte
<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { api } from "../api";
  import { images, activeId, allDeveloped } from "../store";
  import { developAll } from "../workflow";
  import GlassPanel from "../glass/GlassPanel.svelte";

  let importing = false;
  let error = "";

  async function pickAndImport() {
    const sel = await open({ multiple: true, filters: [{ name: "Film scans", extensions: ["dng", "tif", "tiff", "raf"] }] });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    importing = true; error = "";
    for (const path of paths) {
      try {
        const entry = await api.importImage(path as string);
        images.update((xs) => [...xs, entry]);
        activeId.update((id) => id ?? entry.id);
      } catch (e) { error = String(e); }
    }
    importing = false;
  }
</script>

<GlassPanel>
  <div class="wrap">
    <button class="import" on:click={pickAndImport} disabled={importing}>
      {importing ? "Importing…" : "Import"}
    </button>
    {#if error}<div class="err">{error}</div>{/if}
    <ul>
      {#each $images as img}
        <li class:active={$activeId === img.id} on:click={() => activeId.set(img.id)}>
          <span class="name">{img.file_name}</span>
          {#if img.developed}<span class="dot" title="developed"></span>{/if}
        </li>
      {/each}
    </ul>
    {#if $images.length > 0 && !$allDeveloped}
      <button class="develop" on:click={() => developAll()}>Develop all</button>
    {/if}
  </div>
</GlassPanel>

<style>
  .wrap { display: flex; flex-direction: column; height: 100%; }
  .import { width: 100%; padding: 9px; border-radius: 10px; border: 0;
    background: rgba(255,255,255,0.08); color: var(--text); font-weight: 600; }
  .import:disabled { opacity: 0.6; }
  .err { color: var(--accent); margin-top: 8px; font-size: 12px; }
  ul { list-style: none; padding: 0; margin: 12px 0; flex: 1; overflow: auto; }
  li { padding: 7px 9px; border-radius: 8px; color: var(--text-dim); cursor: pointer;
    display: flex; align-items: center; gap: 8px; }
  li.active { background: rgba(255,255,255,0.06); color: var(--text); }
  .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; }
  .develop { width: 100%; padding: 10px; border: 0; border-radius: 10px; margin-top: auto;
    background: var(--accent); color: white; font-weight: 700; }
</style>
```

- [ ] **Step 5: Library.svelte — center shows the thumbnail (no render/zoom)**

Replace `app/src/lib/tabs/Library.svelte` with:

```svelte
<script lang="ts">
  import { activeId, images } from "../store";
  import Source from "../panels/Source.svelte";
  import Metadata from "../panels/Metadata.svelte";
  import Filmstrip from "../panels/Filmstrip.svelte";
  $: active = $images.find((i) => i.id === $activeId);
</script>

<div class="layout">
  <aside class="left"><Source /></aside>
  <section class="center">
    {#if active}<img src={active.thumbnail} alt={active.file_name} />
    {:else}<div class="hint">Import a film scan to begin</div>{/if}
  </section>
  <aside class="right"><Metadata /></aside>
  <footer class="bottom"><Filmstrip /></footer>
</div>

<style>
  .layout { display: grid; height: 100%; gap: 12px;
    grid-template-columns: 220px 1fr 260px; grid-template-rows: 1fr 88px;
    grid-template-areas: "left center right" "bottom bottom bottom"; }
  .left { grid-area: left; } .right { grid-area: right; }
  .center { grid-area: center; display: grid; place-items: center; min-height: 0; }
  .center img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 10px;
    image-rendering: auto; }
  .hint { color: var(--text-dim); }
  .bottom { grid-area: bottom; }
</style>
```

- [ ] **Step 6: Develop.svelte — Viewport + right-click quality menu + not-developed guard**

Replace `app/src/lib/tabs/Develop.svelte` with:

```svelte
<script lang="ts">
  import { activeId, params, images } from "../store";
  import Adjustments from "../panels/Adjustments.svelte";
  import Filmstrip from "../panels/Filmstrip.svelte";
  import Viewport from "../viewport/Viewport.svelte";
  import QualityMenu from "../viewport/QualityMenu.svelte";

  $: active = $images.find((i) => i.id === $activeId);
  let menu: { x: number; y: number } | null = null;
  function onContext(e: MouseEvent) { e.preventDefault(); menu = { x: e.clientX, y: e.clientY }; }
</script>

<div class="layout" on:contextmenu={onContext}>
  <aside class="left"></aside>
  <section class="center">
    {#if active?.developed}
      <Viewport id={$activeId} params={$params}
                imgW={active.metadata.width} imgH={active.metadata.height} />
    {:else}<div class="hint">Not developed yet</div>{/if}
  </section>
  <aside class="right"><Adjustments /></aside>
  <footer class="bottom"><Filmstrip /></footer>
</div>
{#if menu}<QualityMenu x={menu.x} y={menu.y} on:close={() => (menu = null)} />{/if}

<style>
  .layout { display: grid; height: 100%; gap: 12px;
    grid-template-columns: 220px 1fr 260px; grid-template-rows: 1fr 88px;
    grid-template-areas: "left center right" "bottom bottom bottom"; }
  .left { grid-area: left; } .right { grid-area: right; }
  .center { grid-area: center; min-height: 0; display: grid; place-items: center; }
  .hint { color: var(--text-dim); }
  .bottom { grid-area: bottom; }
</style>
```

- [ ] **Step 7: App.svelte — tab gating, popup, overlay**

Replace `app/src/routes/+page.svelte` with:

```svelte
<script lang="ts">
  import "../styles/theme.css";
  import { module, hasImages, allDeveloped, images } from "$lib/store";
  import { developAll, undevelopedIds } from "$lib/workflow";
  import Library from "$lib/tabs/Library.svelte";
  import Develop from "$lib/tabs/Develop.svelte";
  import ProgressOverlay from "$lib/overlay/ProgressOverlay.svelte";
  import ConfirmDevelop from "$lib/overlay/ConfirmDevelop.svelte";

  let confirmCount = 0;
  let confirming = false;

  function gotoDevelop() {
    if (!$hasImages) return;
    if ($allDeveloped) { module.set("develop"); return; }
    confirmCount = undevelopedIds($images).length;
    confirming = true;
  }
</script>

<div class="app">
  <header class="topbar">
    <div class="brand"><span class="dot"></span> RedRoom</div>
    <nav class="tabs">
      <button class:active={$module === "library"} on:click={() => module.set("library")}>Library</button>
      <button class:active={$module === "develop"} disabled={!$hasImages} on:click={gotoDevelop}>Develop</button>
    </nav>
    <div class="spacer"></div>
  </header>
  <main>
    {#if $module === "library"}<Library />{:else}<Develop />{/if}
  </main>
</div>

<ProgressOverlay />
{#if confirming}
  <ConfirmDevelop count={confirmCount}
    on:confirm={() => { confirming = false; developAll(); }}
    on:cancel={() => (confirming = false)} />
{/if}

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  .topbar { display: flex; align-items: center; gap: 18px; padding: 10px 16px;
    border-bottom: 1px solid var(--glass-brd); }
  .brand { font-weight: 600; letter-spacing: 0.3px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
  .tabs button { background: transparent; border: 0; padding: 6px 14px; border-radius: 8px; color: var(--text-dim); }
  .tabs button.active { color: var(--text); background: rgba(224,52,52,0.14); box-shadow: inset 0 0 0 1px rgba(224,52,52,0.4); }
  .tabs button:disabled { opacity: 0.35; cursor: not-allowed; }
  .spacer { flex: 1; }
  main { flex: 1; min-height: 0; padding: 12px; }
</style>
```

- [ ] **Step 8: Build + vitest**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run build 2>&1 | tail -6 && npx vitest run 2>&1 | grep -E 'Test Files|Tests '`
Expected: build succeeds; all vitest pass. (a11y warnings on click/contextmenu divs are OK.)

- [ ] **Step 9: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src
git commit -m "feat(redroom): develop-all button, progress overlay, confirm popup, quality menu, tab gating"
```

---

## Task 6: Verify + findings

**Files:** `docs/superpowers/poc-findings.md`.

- [ ] **Step 1: Full verification**

Run:
```
source "$HOME/.cargo/env"
(cd app/src-tauri && cargo test 2>&1 | grep 'test result')
(cd app && npx vitest run 2>&1 | grep -E 'Test Files|Tests ')
(cd app && npm run build 2>&1 | tail -3)
(cd app/src-tauri && cargo build 2>&1 | tail -1)
```
Expected: all green.

- [ ] **Step 2: Record results**

Add a "Library-first develop workflow — results" section to `docs/superpowers/poc-findings.md`
summarizing: instant import, Develop-all + progress + auto-switch, quality menu, tab gating,
and note the manual E2E checklist still to run live (`npm run tauri dev`): drop a batch → instant
Library → Develop disabled when empty → Develop all shows progress → lands in Develop at Fit →
early-jump popup → Performance/Quality sharpness → export full-res.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/poc-findings.md
git commit -m "docs: develop workflow results + manual E2E checklist"
```

---

## Definition of Done

- [ ] `cargo test` green (session Quality/insert; commands choose_source/wb).
- [ ] `npx vitest run` green (undevelopedIds + existing deriveView).
- [ ] `npm run build` + backend `cargo build` succeed; 5 commands registered.
- [ ] Import is light (no full decode); `develop_image` builds working@cap + drops full_res;
      `render_view`/`export` work on developed images; quality switch re-develops.
- [ ] Develop tab disabled when empty; Develop-all button + progress overlay + auto-switch;
      early-jump confirm popup; quality context menu.
- [ ] Findings + manual E2E checklist recorded.
```
