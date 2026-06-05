# Per-Roll Base Calibration + Base-Picker Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user calibrate the film-base (orange-mask) value once per roll/folder via a manual picker tool, with a per-image override, instead of today's content-dependent whole-frame auto sample.

**Architecture:** Backend gains a `base_override` field on `InvertParams` and uses `override ?? dev.base` at every resolve site, plus a `sample_base_at(id, rect)` command. Frontend stores a folder default (`folderBaseByPath`, persisted via the existing `app_state` KV) and the per-image override (in params), resolves precedence with a `withEffectiveBase(params, dir)` helper injected at render time, and adds a `base_picker` tool (overlay + panel) following the existing crop/eraser pattern.

**Tech Stack:** Rust (Tauri commands, `film-core`), Svelte 5 + TypeScript, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-05-per-roll-base-calibration-design.md`

---

## File Structure

**Backend (Rust):**
- Modify `app/src-tauri/src/session.rs` — add `base_override: Option<[f32;3]>` to `InvertParams`; remove dead `base_rect`.
- Modify `app/src-tauri/src/commands.rs` — `effective_base` helper; use it at resolve sites; new `sample_base_at` command.
- Modify `app/src-tauri/src/lib.rs` — register `sample_base_at` in the invoke handler.

**Frontend (TypeScript / Svelte):**
- Modify `app/src/lib/api.ts` — `base_override` on `InvertParams`, drop `base_rect`, `sampleBaseAt` binding, `defaultParams`.
- Modify `app/src/lib/store.ts` — `folderBaseByPath` store; `base_picker` in `Tool`.
- Create `app/src/lib/develop/base.ts` — `withEffectiveBase`, `setFolderBase`, `clearFolderBase` helpers.
- Modify `app/src/lib/catalog.ts` — hydrate/persist folder bases via `app_state`.
- Modify `app/src/lib/icons/Icon.svelte` — `pipette` icon.
- Modify `app/src/lib/develop/Toolbar.svelte` — base-picker button.
- Create `app/src/lib/develop/BasePickerOverlay.svelte` — drag box + live swatch.
- Create `app/src/lib/develop/BaseView.svelte` — uncropped raw scan + overlay.
- Create `app/src/lib/develop/BasePanel.svelte` — swatch + apply/reset buttons.
- Modify `app/src/lib/tabs/Develop.svelte` — mount `BaseView`/`BasePanel`, inject effective params.
- Modify `app/src/lib/viewport/Viewport.svelte` and `app/src/lib/crop/CropView.svelte` — add `base_override` to render reactivity keys.
- Modify `app/src/lib/i18n/dict.ts` — toolbar + panel strings (en + zh).

---

## Task 1: Backend — `base_override` field + `effective_base` helper

**Files:**
- Modify: `app/src-tauri/src/session.rs:36-41` (InvertParams), `app/src-tauri/src/commands.rs`
- Test: inline `#[cfg(test)]` in `commands.rs`

- [ ] **Step 1: Add the field to `InvertParams`** in `app/src-tauri/src/session.rs`. Replace the `base_rect` field (lines 40-41):

```rust
    /// Per-image film-base override. When set, used verbatim as the orange-mask
    /// base; when None, the develop-time auto base (`Developed.base`) is used.
    #[serde(default)]
    pub base_override: Option<[f32; 3]>,
```

(Removes `#[allow(dead_code)] pub base_rect: Option<[usize; 4]>`. The `#[serde(default)]` keeps old catalog blobs loadable.)

- [ ] **Step 2: Fix `default_invert_params`** in `app/src-tauri/src/commands.rs:82`. Change `base_rect: None,` to:

```rust
        base_override: None,
```

- [ ] **Step 3: Add the `effective_base` helper** in `commands.rs`, right after `build_params` (after line 130):

```rust
/// The base to invert with: the per-image override if set, else the develop-time
/// auto base sampled at `develop_image` time.
pub(crate) fn effective_base(p: &InvertParams, dev_base: [f32; 3]) -> [f32; 3] {
    p.base_override.unwrap_or(dev_base)
}
```

- [ ] **Step 4: Write the failing test** at the top of `commands.rs`'s `#[cfg(test)] mod tests` (after `use super::*;`):

```rust
    #[test]
    fn effective_base_prefers_override_then_dev_base() {
        let mut p = crate::commands_test_support::sample_invert_params();
        p.base_override = None;
        assert_eq!(effective_base(&p, [0.8, 0.6, 0.4]), [0.8, 0.6, 0.4], "None -> dev base");
        p.base_override = Some([0.1, 0.2, 0.3]);
        assert_eq!(effective_base(&p, [0.8, 0.6, 0.4]), [0.1, 0.2, 0.3], "Some -> override");
    }
```

- [ ] **Step 5: Update `commands_test_support::sample_invert_params`** in `app/src-tauri/src/lib.rs` (around line 14) — change its `base_rect: None,` to `base_override: None,`. Run: `grep -n "base_rect" app/src-tauri/src/lib.rs` and replace the field. If `sample_invert_params` does not set it, no change needed (serde default covers construction, but struct literals must list all non-default fields — verify the literal compiles).

- [ ] **Step 6: Run the test (expect compile-driven failures elsewhere first)**

Run: `cd app/src-tauri && cargo test effective_base_prefers_override -- --nocapture`
Expected: compile errors at every `InvertParams { ... base_rect ... }` literal and every `resolve_params`/`build_params` call still passing `dev.base`. Fix each literal to use `base_override: None` (or remove the line — serde default + struct-update syntax). Search: `grep -rn "base_rect" app/src-tauri/src`.

- [ ] **Step 7: Wire `effective_base` into the resolve sites.** In `commands.rs`, the call sites that pass `dev.base`/`base`/`thumb`-base into `resolve_params`/`build_params` must first resolve the effective base. Update each:

  - `render_view`: change `let ip = resolve_params(&params, &dev.thumb, dev.base);` to
    `let ip = resolve_params(&params, &dev.thumb, effective_base(&params, dev.base));`
  - `thumbnail`: same substitution (`effective_base(&params, dev.base)`).
  - `export_image`: change `resolve_params(&params, &thumb, base)` to `resolve_params(&params, &thumb, effective_base(&params, base))`.
  - `as_shot_wb`: change `build_params(&params, base)` to `build_params(&params, effective_base(&params, base))`.
  - `resolved_inversion` (GPU): the uniforms are built in `gpu_upload::resolve_to_uniforms(&params, dev.base)`. Change that call to `resolve_to_uniforms(&params, effective_base(&params, dev.base))`.

Run: `grep -rn "resolve_params\|build_params\|resolve_to_uniforms" app/src-tauri/src/commands.rs` to confirm every site is covered.

- [ ] **Step 8: Run all backend tests**

Run: `cd app/src-tauri && cargo test`
Expected: PASS (79+ tests, including `effective_base_prefers_override_then_dev_base`).

- [ ] **Step 9: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(base): base_override field + effective_base at resolve sites"
```

---

## Task 2: Backend — `sample_base_at` command

**Files:**
- Modify: `app/src-tauri/src/commands.rs`, `app/src-tauri/src/lib.rs`
- Test: inline in `commands.rs` (tests the rect→base mapping via the resident-image-free core path)

- [ ] **Step 1: Write the failing test** in `commands.rs` tests module. It exercises the exact mapping the command uses (`crop_px` → `sample_base(Some(Rect))`) on a synthetic image, independent of Tauri `State`:

```rust
    #[test]
    fn sample_base_at_maps_normalized_rect_to_region() {
        use film_core::calibrate::{sample_base, Rect};
        // 4x4 image: left half bright [0.9,...], right half dark [0.1,...].
        let mut pixels = vec![[0.1f32; 3]; 16];
        for y in 0..4 { for x in 0..2 { pixels[y * 4 + x] = [0.9, 0.9, 0.9]; } }
        let img = film_core::Image { width: 4, height: 4, pixels, ir: None };
        // Normalized rect over the left half -> bright base.
        let (x, y, w, h) = crop_px([0.0, 0.0, 0.5, 1.0], img.width, img.height);
        let base = sample_base(&img, Some(Rect { x, y, w, h }));
        assert!(base[0] >= 0.85, "left-half base should be bright, got {base:?}");
    }
```

- [ ] **Step 2: Run it to verify it fails (or passes trivially if helpers exist)**

Run: `cd app/src-tauri && cargo test sample_base_at_maps_normalized_rect -- --nocapture`
Expected: PASS already (it uses existing `crop_px` + `sample_base`). This test pins the mapping contract the command relies on. If `Rect` is not re-exported, add `pub use` — check `grep -n "pub struct Rect" crates/film-core/src/calibrate.rs` and that `film_core::calibrate::Rect` is public (it is).

- [ ] **Step 3: Add the command** in `commands.rs` (near `resolved_inversion`, end of file before tests):

```rust
/// Sample the orange-mask base from a normalized rect [x,y,w,h] (0..1) over the
/// resident working image. Used by the base-picker tool; cheap, no re-decode.
#[tauri::command]
pub fn sample_base_at(
    id: String, rect: [f64; 4], session: State<Session>,
) -> Result<[f32; 3], String> {
    use film_core::calibrate::Rect;
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let (x, y, w, h) = crop_px(rect, dev.working.width, dev.working.height);
    Ok(sample_base(&dev.working, Some(Rect { x, y, w, h })))
}
```

- [ ] **Step 4: Register the command** in `app/src-tauri/src/lib.rs`. In the `tauri::generate_handler![ ... ]` list (after `commands::resolved_inversion,` around line 69), add:

```rust
            commands::sample_base_at,
```

- [ ] **Step 5: Build and test**

Run: `cd app/src-tauri && cargo build && cargo test sample_base_at -- --nocapture`
Expected: builds; test PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(base): sample_base_at command for the picker tool"
```

---

## Task 3: Frontend — `base_override` type, defaults, drop `base_rect`

**Files:**
- Modify: `app/src/lib/api.ts`

- [ ] **Step 1: Update the `InvertParams` interface** in `app/src/lib/api.ts`. Replace the line `base_rect: [number, number, number, number] | null;` with:

```typescript
  base_override: [number, number, number] | null;
```

- [ ] **Step 2: Update `defaultParams()`** in `api.ts`. Replace `base_rect: null,` with:

```typescript
  base_override: null,
```

- [ ] **Step 3: Add the `sampleBaseAt` binding** in the `api` object (after `resolvedInversion`):

```typescript
  sampleBaseAt: (id: string, rect: [number, number, number, number]) =>
    invoke<[number, number, number]>("sample_base_at", { id, rect }),
```

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: errors only where `base_rect` was referenced (likely none beyond defaults). Fix any. `0 errors` when done.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/api.ts
git commit -m "feat(base): base_override + sampleBaseAt in the JS api contract"
```

---

## Task 4: Frontend — `folderBaseByPath` store + persistence

**Files:**
- Modify: `app/src/lib/store.ts`, `app/src/lib/catalog.ts`
- Test: `app/src/lib/catalog.test.ts`

- [ ] **Step 1: Add the store and the `base_picker` tool** in `app/src/lib/store.ts`. After the `tool` declaration (line ~70), change the `Tool` type and add the store near the other per-folder/global stores:

```typescript
export type Tool = "edit" | "crop" | "eraser" | "base_picker";
```

And after the `selectedFolder` block (~line 62):

```typescript
/** Folder/roll-default film base, keyed by image directory path. Persisted via
 * app_state as `folder_base:{dir}`. A per-image base_override wins over this. */
export const folderBaseByPath = writable<Record<string, [number, number, number]>>({});
```

- [ ] **Step 2: Write the failing hydrate test** in `app/src/lib/catalog.test.ts`. Add `folderBaseByPath` to the store import (line 5-6), then add a test inside `describe("applySnapshot")`:

```typescript
  it("hydrates folder bases from app_state folder_base: keys", () => {
    const snap: CatalogSnapshot = {
      images: [], edits: [],
      prefs: {},
      app_state: { "folder_base:/x/roll1": "[0.42,0.19,0.11]" },
    };
    applySnapshot(snap);
    expect(get(folderBaseByPath)["/x/roll1"]).toEqual([0.42, 0.19, 0.11]);
  });
```

- [ ] **Step 2b: Run it to verify it fails**

Run: `cd app && npm run test:unit -- catalog`
Expected: FAIL (`folderBaseByPath` empty — not hydrated yet).

- [ ] **Step 3: Hydrate in `applySnapshot`** in `app/src/lib/catalog.ts`. Add `folderBaseByPath` to the store import block (lines 5-8), then after the `app_state` reads (after line 78, the `active_id` block) add:

```typescript
  const fb: Record<string, [number, number, number]> = {};
  for (const [k, v] of Object.entries(st)) {
    if (!k.startsWith("folder_base:")) continue;
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr) && arr.length === 3) fb[k.slice("folder_base:".length)] = arr as [number, number, number];
    } catch { /* skip malformed */ }
  }
  folderBaseByPath.set(fb);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npm run test:unit -- catalog`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/catalog.ts app/src/lib/catalog.test.ts
git commit -m "feat(base): folderBaseByPath store hydrated from app_state"
```

---

## Task 5: Frontend — `withEffectiveBase` + folder-base mutators

**Files:**
- Create: `app/src/lib/develop/base.ts`
- Test: `app/src/lib/develop/base.test.ts`

- [ ] **Step 1: Write the failing test** `app/src/lib/develop/base.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { folderBaseByPath } from "../store";
import { withEffectiveBase, setFolderBase, clearFolderBase } from "./base";
import { defaultParams } from "../api";

describe("withEffectiveBase", () => {
  beforeEach(() => folderBaseByPath.set({}));

  it("uses per-image override over the folder default", () => {
    folderBaseByPath.set({ "/x": [0.4, 0.2, 0.1] });
    const p = { ...defaultParams(), base_override: [0.9, 0.8, 0.7] as [number, number, number] };
    expect(withEffectiveBase(p, "/x").base_override).toEqual([0.9, 0.8, 0.7]);
  });

  it("falls back to the folder default when no override", () => {
    folderBaseByPath.set({ "/x": [0.4, 0.2, 0.1] });
    const p = defaultParams();
    expect(withEffectiveBase(p, "/x").base_override).toEqual([0.4, 0.2, 0.1]);
  });

  it("is null when neither is set (backend uses dev.base)", () => {
    expect(withEffectiveBase(defaultParams(), "/x").base_override).toBeNull();
  });

  it("setFolderBase / clearFolderBase mutate the store", () => {
    setFolderBase("/x", [0.4, 0.2, 0.1]);
    expect(get(folderBaseByPath)["/x"]).toEqual([0.4, 0.2, 0.1]);
    clearFolderBase("/x");
    expect(get(folderBaseByPath)["/x"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npm run test:unit -- base`
Expected: FAIL (`./base` does not exist).

- [ ] **Step 3: Implement** `app/src/lib/develop/base.ts`:

```typescript
import { get } from "svelte/store";
import { folderBaseByPath } from "../store";
import { api, type InvertParams } from "../api";

/** Resolve the effective base for a frame and inject it into a throwaway params
 * object: per-image override -> folder default -> null (backend uses dev.base).
 * Never mutates the persisted per-image base_override. */
export function withEffectiveBase(params: InvertParams, dir: string): InvertParams {
  const base = params.base_override ?? get(folderBaseByPath)[dir] ?? null;
  return { ...params, base_override: base };
}

/** Set the roll/folder default and persist it via app_state. */
export function setFolderBase(dir: string, base: [number, number, number]): void {
  folderBaseByPath.update((m) => ({ ...m, [dir]: base }));
  api.saveAppState(`folder_base:${dir}`, JSON.stringify(base)).catch(() => {});
}

/** Clear the roll/folder default (persists an empty string = removed). */
export function clearFolderBase(dir: string): void {
  folderBaseByPath.update((m) => { const n = { ...m }; delete n[dir]; return n; });
  api.saveAppState(`folder_base:${dir}`, "").catch(() => {});
}
```

Note: hydration in Task 4 skips empty/malformed values, so an empty string reads back as "no folder base".

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npm run test:unit -- base`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/base.ts app/src/lib/develop/base.test.ts
git commit -m "feat(base): withEffectiveBase + folder-base mutators"
```

---

## Task 6: Wire effective base into the preview + reactivity

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte`, `app/src/lib/viewport/Viewport.svelte`, `app/src/lib/crop/CropView.svelte`

- [ ] **Step 1: Compute effective params in `Develop.svelte`.** Add imports near the top `<script>`:

```typescript
  import { imageDir } from "../library/folderScope";
  import { withEffectiveBase } from "../develop/base";
  import { folderBaseByPath } from "../store";
```

Add a reactive derived value after `$: active = ...` (line 23). Reference `$folderBaseByPath` so it re-runs when the folder default changes:

```typescript
  $: dir = active ? imageDir(active) : "";
  $: effParams = ($folderBaseByPath, withEffectiveBase($params, dir));
```

- [ ] **Step 2: Pass `effParams` to the views.** In the center section (lines 195-202), replace `params={$params}` with `params={effParams}` in BOTH the `CropView` and `Viewport` instances.

- [ ] **Step 3: Use `effParams` for the thumbnail.** In `refreshThumb` (line 160), change `api.thumbnail(id, $params, view)` to `api.thumbnail(id, effParams, view)`. Also add `$folderBaseByPath` to the reactive thumb trigger (line 165):

```typescript
  $: $params, $activeId, $activeCrop, $activeDust, $folderBaseByPath, refreshThumb();
```

- [ ] **Step 4: Add `base_override` to Viewport's render key.** In `app/src/lib/viewport/Viewport.svelte`, find the resolved-inversion fetch (around line 179, `api.resolvedInversion(id, params)`) and the key/guard that decides when to re-fetch. Add `params.base_override` to that dependency. Search: `grep -n "resolvedInversion\|params.stock\|params.temp" app/src/lib/viewport/Viewport.svelte`. Append `${JSON.stringify(params.base_override)}` to the reactive key string that gates the GPU uniform refresh (mirror how `params.stock`/`params.temp` are already included).

- [ ] **Step 5: Add `base_override` to CropView's key.** In `app/src/lib/crop/CropView.svelte` line 58, append to the `key` template string:

```typescript
|${JSON.stringify(params.base_override)}
```

- [ ] **Step 6: Typecheck + unit tests**

Run: `cd app && npm run check && npm run test:unit`
Expected: 0 errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/tabs/Develop.svelte app/src/lib/viewport/Viewport.svelte app/src/lib/crop/CropView.svelte
git commit -m "feat(base): inject effective base into preview + thumbnail + GPU refresh"
```

---

## Task 7: Base-picker tool — toolbar button, icon, strings

**Files:**
- Modify: `app/src/lib/icons/Icon.svelte`, `app/src/lib/develop/Toolbar.svelte`, `app/src/lib/i18n/dict.ts`

- [ ] **Step 1: Add the `pipette` icon** in `app/src/lib/icons/Icon.svelte` `paths` map (after `settings`):

```typescript
    pipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
```

- [ ] **Step 2: Add the toolbar button** in `app/src/lib/develop/Toolbar.svelte` `tools` array (after `eraser`, line 9):

```typescript
    { id: "base_picker", icon: "pipette", labelKey: "toolbar.basePicker", enabled: true },
```

- [ ] **Step 3: Add i18n strings** in `app/src/lib/i18n/dict.ts`. Under the `en` block near the other `toolbar.*` keys add:

```typescript
    "toolbar.basePicker": "Base",
    "base.title": "Film Base",
    "base.hint": "Drag a box over clear film (the orange rebate) to sample the base.",
    "base.swatch": "Sampled base",
    "base.applyRoll": "Apply to roll",
    "base.thisImage": "This image only",
    "base.reset": "Reset",
    "base.scopeOverride": "This image is using a custom base.",
    "base.scopeFolder": "Using the roll base.",
    "base.scopeAuto": "Using the auto base.",
```

Under the `zh` block add the same keys (translate): `"toolbar.basePicker": "基准"`, `"base.title": "胶片基准"`, `"base.hint": "在透明片基(橙色片边)上拖一个框来采样基准。"`, `"base.swatch": "已采样基准"`, `"base.applyRoll": "应用到整卷"`, `"base.thisImage": "仅此照片"`, `"base.reset": "重置"`, `"base.scopeOverride": "此照片使用自定义基准。"`, `"base.scopeFolder": "使用整卷基准。"`, `"base.scopeAuto": "使用自动基准。"`.

> If `dict.ts` is auto-generated from `i18n-strings.csv` (header comment says so), add these rows to `i18n-strings.csv` instead and regenerate via `scripts/gen-i18n.py`. Check the file header first: `head -3 app/src/lib/i18n/dict.ts`.

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: 0 errors. The toolbar now shows a 4th (pipette) button; clicking it sets `tool === "base_picker"` (panel/overlay wired in Tasks 8-9).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/icons/Icon.svelte app/src/lib/develop/Toolbar.svelte app/src/lib/i18n/dict.ts
git commit -m "feat(base): base-picker tool button, pipette icon, strings"
```

---

## Task 8: `BasePickerOverlay` + `BaseView` (uncropped raw scan)

**Files:**
- Create: `app/src/lib/develop/BasePickerOverlay.svelte`, `app/src/lib/develop/BaseView.svelte`
- Modify: `app/src/lib/tabs/Develop.svelte`

- [ ] **Step 1: Create `BasePickerOverlay.svelte`** — a single draggable/resizable box over the displayed image, emitting the normalized rect. Reuses crop math helpers (`toScreen`, `handleAt`, `applyDrag`, `ScreenRect`):

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { Rect, Handle } from "../crop/types";
  import { toScreen, handleAt, applyDrag, type ScreenRect } from "../crop/cropMath";

  export let rect: Rect;       // bound draft, normalized to the displayed image
  export let img: ScreenRect;  // displayed image rect, container px

  const dispatch = createEventDispatcher<{ change: Rect }>();
  let host: HTMLDivElement;
  let active: Handle = null;
  let startRect: Rect = rect;
  let startX = 0, startY = 0;

  $: box = toScreen(rect, img);

  function localXY(e: PointerEvent): [number, number] {
    const r = host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const [px, py] = localXY(e);
    const h = handleAt(px, py, box, 12);
    const inside = px > box.left && px < box.left + box.width && py > box.top && py < box.top + box.height;
    active = h ?? (inside ? "move" : null);
    if (!active) return;
    startRect = rect; startX = px; startY = py;
    host.setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!active) return;
    const [px, py] = localXY(e);
    const dnx = (px - startX) / Math.max(1, img.width);
    const dny = (py - startY) / Math.max(1, img.height);
    rect = applyDrag(active, startRect, dnx, dny, null);
    dispatch("change", rect);
  }
  function onUp() { if (active) { active = null; dispatch("change", rect); } }
</script>

<div bind:this={host} class="overlay"
  on:pointerdown={onDown} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onUp}>
  <div class="frame" style="left:{box.left}px; top:{box.top}px; width:{box.width}px; height:{box.height}px"></div>
  {#each [["nw",box.left,box.top],["ne",box.left+box.width,box.top],["sw",box.left,box.top+box.height],["se",box.left+box.width,box.top+box.height]] as b}
    <div class="bracket" style="left:{b[1]}px; top:{b[2]}px"></div>
  {/each}
</div>

<style>
  .overlay { position: absolute; inset: 0; user-select: none; touch-action: none; cursor: crosshair; }
  .frame { position: absolute; border: 1.5px solid rgba(120,220,255,0.95);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5); box-sizing: border-box; }
  .bracket { position: absolute; width: 12px; height: 12px; transform: translate(-50%,-50%);
    border-radius: 2px; background: rgba(120,220,255,0.95); box-shadow: 0 0 2px rgba(0,0,0,0.6); }
</style>
```

- [ ] **Step 2: Create `BaseView.svelte`** — shows the full UNCROPPED RAW scan + the overlay, samples on box change (debounced), emits the sampled base. Mirrors `CropView`'s fit/measure but with `raw: true` and `image_crop: null`:

```svelte
<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { api, type InvertParams } from "../api";
  import type { Rect } from "../crop/types";
  import type { ScreenRect } from "../crop/cropMath";
  import BasePickerOverlay from "./BasePickerOverlay.svelte";

  export let id: string | null;
  export let params: InvertParams;
  export let imgW = 0;   // working-image dims (uncropped, oriented identity)
  export let imgH = 0;

  const dispatch = createEventDispatcher<{ sampled: [number, number, number] }>();
  const PAD = 60, CAP = 4000;
  let el: HTMLDivElement;
  let src = "";
  let vpW = 0, vpH = 0;
  let rect: Rect = { x: 0.02, y: 0.02, w: 0.14, h: 0.14 };

  function measure() { if (el) { vpW = el.clientWidth; vpH = el.clientHeight; } }
  onMount(() => { measure(); const ro = new ResizeObserver(measure); if (el) ro.observe(el); return () => ro.disconnect(); });

  $: avW = Math.max(1, vpW - 2 * PAD);
  $: avH = Math.max(1, vpH - 2 * PAD);
  $: fit = imgW > 0 && imgH > 0 && vpW > 0 ? Math.min(avW / imgW, avH / imgH) : 0;
  $: dispW = imgW * fit;
  $: dispH = imgH * fit;
  $: imgScreen = { left: (vpW - dispW) / 2, top: (vpH - dispH) / 2, width: dispW, height: dispH } as ScreenRect;

  let lastKey = "";
  async function render() {
    if (!id || !imgW || !vpW) return;
    const rscale = Math.min(fit, CAP / Math.max(imgW, imgH));
    const out_w = Math.max(1, Math.round(imgW * rscale));
    const out_h = Math.max(1, Math.round(imgH * rscale));
    try {
      src = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw: true, finish: false,
        image_crop: null, rot90: 0, flip_h: false, flip_v: false, angle: 0,
      });
    } catch { /* keep last */ }
  }
  $: key = `${id}|${vpW}|${vpH}|${imgW}|${imgH}`;
  $: if (key !== lastKey) { lastKey = key; render(); }

  let timer: ReturnType<typeof setTimeout> | null = null;
  async function sample() {
    if (!id) return;
    try {
      const b = await api.sampleBaseAt(id, [rect.x, rect.y, rect.w, rect.h]);
      dispatch("sampled", b);
    } catch { /* ignore */ }
  }
  function onChange() { if (timer) clearTimeout(timer); timer = setTimeout(sample, 120); }
  onMount(() => { sample(); });
</script>

<div class="basevp" bind:this={el}>
  {#if src}
    <img {src} alt="negative" draggable="false"
      style="position:absolute; left:{imgScreen.left}px; top:{imgScreen.top}px; width:{dispW}px; height:{dispH}px;" />
    <BasePickerOverlay bind:rect img={imgScreen} on:change={onChange} />
  {:else}<div class="hint">…</div>{/if}
</div>

<style>
  .basevp { position: relative; width: 100%; height: 100%; overflow: hidden;
    border-radius: 10px; user-select: none; }
  .hint { color: var(--text-dim); position: absolute; inset: 0; display: grid; place-items: center; }
</style>
```

Note: `imgW`/`imgH` here are the un-oriented working dims. Pass the raw `origW`/`origH` from `Develop.svelte` (the picker samples the working image in its native orientation; `sample_base_at` maps the rect onto `dev.working` directly, which is the same un-oriented buffer).

- [ ] **Step 3: Mount in `Develop.svelte`.** Add imports:

```typescript
  import BaseView from "../develop/BaseView.svelte";
```

In the center section, add a branch for the picker before the `{:else}` Viewport (around line 194):

```svelte
      {:else if $tool === "base_picker"}
        <BaseView id={$activeId} params={effParams} imgW={origW} imgH={origH}
                  on:sampled={(e) => (sampledBase = e.detail)} />
```

Add the draft state near the crop draft (line ~32):

```typescript
  let sampledBase: [number, number, number] | null = null;
```

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: 0 errors. (Panel buttons come in Task 9; `sampledBase` is set but not yet consumed — that's fine for this step.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/BasePickerOverlay.svelte app/src/lib/develop/BaseView.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(base): picker overlay + uncropped raw BaseView, live sampling"
```

---

## Task 9: `BasePanel` — swatch + apply/reset, commit logic

**Files:**
- Create: `app/src/lib/develop/BasePanel.svelte`
- Modify: `app/src/lib/tabs/Develop.svelte`

- [ ] **Step 1: Create `BasePanel.svelte`:**

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { t } from "$lib/i18n";

  export let sampled: [number, number, number] | null = null;
  export let scope: "override" | "folder" | "auto" = "auto";

  const dispatch = createEventDispatcher<{ applyRoll: void; thisImage: void; reset: void }>();
  // 8-bit swatch preview of the linear base (display-only, gamma ~1/2.2).
  $: css = sampled
    ? `rgb(${sampled.map((v) => Math.round(255 * Math.min(1, Math.max(0, v ** (1 / 2.2)))) ).join(",")})`
    : "transparent";
  const scopeKey = { override: "base.scopeOverride", folder: "base.scopeFolder", auto: "base.scopeAuto" } as const;
</script>

<div class="sec">
  <div class="sub">{$t("base.title")}</div>
  <p class="hint">{$t("base.hint")}</p>
  <div class="swatch-row">
    <div class="swatch" style="background:{css}"></div>
    <span class="vals">{sampled ? sampled.map((v) => v.toFixed(3)).join(", ") : "—"}</span>
  </div>
  <div class="btns">
    <button disabled={!sampled} on:click={() => dispatch("applyRoll")}>{$t("base.applyRoll")}</button>
    <button disabled={!sampled} on:click={() => dispatch("thisImage")}>{$t("base.thisImage")}</button>
  </div>
  <button class="reset" on:click={() => dispatch("reset")}>{$t("base.reset")}</button>
  <p class="scope">{$t(scopeKey[scope])}</p>
</div>

<style>
  .sec { padding: 4px 2px; }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); margin-bottom: 6px; }
  .hint { font-size: 11px; color: var(--text-faint); margin: 0 0 10px; }
  .swatch-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .swatch { width: 40px; height: 40px; border-radius: 6px; border: 1px solid var(--glass-brd); }
  .vals { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .btns { display: flex; gap: 6px; margin-bottom: 8px; }
  .btns button { flex: 1; padding: 7px; border-radius: 8px; font-size: 12px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text); }
  .btns button:disabled { opacity: 0.4; }
  .reset { width: 100%; padding: 6px; border-radius: 8px; font-size: 12px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text-dim); }
  .scope { font-size: 11px; color: var(--text-faint); margin: 8px 0 0; }
</style>
```

- [ ] **Step 2: Mount + wire in `Develop.svelte`.** Add imports:

```typescript
  import BasePanel from "../develop/BasePanel.svelte";
  import { setFolderBase, clearFolderBase } from "../develop/base";
```

Add the commit handlers near the crop handlers:

```typescript
  function applyBaseRoll() {
    if (!sampledBase || !dir) return;
    setFolderBase(dir, sampledBase);
  }
  function applyBaseThisImage() {
    if (!sampledBase) return;
    params.update((p) => ({ ...p, base_override: sampledBase }));
  }
  function resetBase() {
    // Clear the per-image override first; if none, clear the folder default.
    if ($params.base_override) params.update((p) => ({ ...p, base_override: null }));
    else if (dir) clearFolderBase(dir);
  }
  $: baseScope = $params.base_override ? "override" : ($folderBaseByPath[dir] ? "folder" : "auto");
```

In the right panel, add a branch (after the `eraser` branch, line ~225):

```svelte
      {:else if $tool === "base_picker"}
        <BasePanel sampled={sampledBase} scope={baseScope}
                   on:applyRoll={applyBaseRoll} on:thisImage={applyBaseThisImage} on:reset={resetBase} />
```

- [ ] **Step 3: Typecheck + unit tests**

Run: `cd app && npm run check && npm run test:unit`
Expected: 0 errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/develop/BasePanel.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(base): base panel — apply to roll / this image / reset"
```

---

## Task 10: Export wiring + manual verification

**Files:**
- Modify: `app/src/lib/export/ExportModal.svelte` (or wherever `api.exportImage` is called)

- [ ] **Step 1: Inject effective base into export.** Find the export call: `grep -rn "exportImage" app/src/lib`. At each `api.exportImage(id, params, ...)` site, wrap params: import `withEffectiveBase` and `imageDir`, look up the image by id to get its dir, and pass `withEffectiveBase(params, imageDir(img))` instead of `params`. If export iterates many images, compute per-image inside the loop.

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: 0 errors.

- [ ] **Step 3: Full test sweep**

Run: `cd app && npm run test:unit && npm run check` then `cd ../.. && cargo test -p film-core && cd app/src-tauri && cargo test`
Expected: all green.

- [ ] **Step 4: Manual verification** (restart the dev app: `cd app && npm run tauri dev`):
  - Select the base-picker (pipette) tool → viewport switches to the full uncropped raw negative; a box appears with a live swatch.
  - Drag the box over clear film (orange rebate) → swatch + values update live.
  - **Apply to roll** → switch to another frame in the same folder → its preview reflects the new base without re-developing. The "Using the roll base" scope line shows.
  - **This image only** on one frame, then change the roll base on another → the overridden frame keeps its own base ("This image is using a custom base").
  - **Reset** on the overridden frame → reverts to the roll base; Reset again (no override) → reverts to auto.
  - Restart the app → folder base + per-image overrides persist (loaded from catalog/app_state).
  - Export an overridden frame → output uses the override.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/export
git commit -m "feat(base): apply effective base on export"
```

---

## Self-Review Notes (verified during planning)

- **Spec coverage:** base resolution/precedence (Tasks 1,5,6,9); `base_override` field (Tasks 1,3); folder default via app_state, no migration (Task 4); `sample_base_at` (Task 2); picker tool/overlay/panel (Tasks 7,8,9); uncropped raw view (Task 8); live update (Task 6); reset semantics override→folder→auto (Task 9); export (Task 10); `base_rect` removed (Tasks 1,3).
- **Type consistency:** `base_override: Option<[f32;3]>` (Rust) ↔ `[number,number,number] | null` (TS); `sample_base_at(id, rect:[f64;4]) -> [f32;3]` ↔ `sampleBaseAt(id, rect) -> [number,number,number]`; `folderBaseByPath: Record<string,[number,number,number]>`; `withEffectiveBase`/`setFolderBase`/`clearFolderBase` names match across `base.ts`, tests, and `Develop.svelte`.
- **Edge cases:** empty rect handled by `crop_px` clamp; not-resident handled by `ensure_resident`; malformed app_state skipped on hydrate; empty-string app_state = removed folder base.
