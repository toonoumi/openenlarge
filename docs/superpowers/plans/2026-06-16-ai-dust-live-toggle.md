# AI Dust Removal → Live, Undoable Main-Display Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI dust button a live, undoable toggle whose heal shows on the main develop viewport (like IR removal), and remove the standalone preview image and export button.

**Architecture:** Carry the existing `autoDust { enabled, sensitivity }` through the GPU **bake** path (`working_baked_pixels` → `bake_for_view`). When enabled, the backend inverts the baked working buffer, runs the cached detector to build a defect mask, unions it with the manual brush-stroke mask, and MI-GAN-heals the combined mask — all at the baked working resolution so the mask and heal align with no resizing. The result is the normal viewport texture, so undo (which already snapshots `DustEdits`) reverts it for free.

**Tech Stack:** Rust (Tauri commands, `ort`/`autodust::engine`, `film_core::dust`), Svelte/TypeScript, WebGL2 bake/upload path.

## Global Constraints

- ONNX runs on **CPU on Windows/Linux**, CoreML on macOS — do NOT re-enable any GPU EP (prior fix). One line each, verbatim from the repo.
- Detector prob map is cached per `(id, dims)` in `session.autodust_prob` and is treated as **params-independent** (existing assumption — do not key the cache on tone/color).
- The heal re-runs only when `dustRev` bumps (toggle / sensitivity / strokes), never on tone/color edits.
- i18n strings are generated from `/i18n-strings.csv` via `scripts/gen-i18n.py` — never hand-edit `dict.ts`. (This plan needs **no** new strings.)
- `pending_upscale` / `save_upscaled` are SHARED with the upscaler — keep them; only remove autodust's use.
- Work commits directly on `main` (no feature branch).

## Scope / non-goals

- **CPU fallback (`render_view`, no-WebGL2) is out of scope** for auto-dust in this plan: it lacks an `AppHandle`, runs at zoom resolution (detector cache would thrash), and is a rare path. Auto-dust applies on the GPU bake path (all WebGL2 machines). Documented as a follow-up.
- **Export of the auto-dust heal is out of scope** here: `export_image`/`export_begin` keep applying committed brush strokes only. Auto-dust is a live-view feature in this iteration. Documented as a follow-up.

## File map

- `app/src-tauri/src/gpu_upload.rs` — add `auto_dust: AutoDust` to `BakeSpec`.
- `app/src-tauri/src/commands.rs` — `AutoDust` doc comment; `union_mask`, `auto_dust_mask` helpers; refactor `bake_for_view`; thread `params` + caching into `working_baked_pixels`; delete `autodust_detect`.
- `app/src-tauri/src/autodust/mod.rs` — remove `AutoDustResult`.
- `app/src-tauri/src/lib.rs` — drop `autodust_detect` from the handler list.
- `app/src/lib/api.ts` — `BakeSpec.auto_dust`; `workingBakedPixels` gains `params`; remove `autodustDetect`.
- `app/src/lib/viewport/Viewport.svelte` — bake mode/key/spec + `params` wiring for auto-dust.
- `app/src/lib/develop/AutoDustPanel.svelte` — toggle button; remove preview/count/Save.
- `app/src/lib/tabs/Develop.svelte` — `setAutoOn` handler; pass `autoDust` to Viewport + panel.

---

### Task 1: Add `auto_dust` to the bake spec

**Files:**
- Modify: `app/src-tauri/src/gpu_upload.rs:13-29` (`BakeSpec`)
- Modify: `app/src-tauri/src/commands.rs:659-666` (`AutoDust` doc comment)

**Interfaces:**
- Produces: `BakeSpec.auto_dust: AutoDust` (where `AutoDust { enabled: bool, sensitivity: f32 }`, already defined in `commands.rs`).

- [ ] **Step 1: Add the field to `BakeSpec`.** In `gpu_upload.rs`, mirror the existing `DustStroke`/`IrRemoval` import to also bring in `AutoDust` (same module), then add to the struct after `migan`:

```rust
    /// AI auto-dust: detector-driven defect mask, MI-GAN healed at bake time.
    #[serde(default)]
    pub auto_dust: AutoDust,
```

- [ ] **Step 2: Fix the now-stale `AutoDust` doc comment** in `commands.rs` (replace the `autodust_detect`-era note):

```rust
/// AI (learned-model) auto dust/hair removal settings from the UI. When
/// `enabled`, the bake path inverts the working buffer, runs the cached detector,
/// thresholds at `sensitivity`, and MI-GAN-heals the defect mask (unioned with
/// brush strokes) — see `working_baked_pixels` / `bake_for_view`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AutoDust {
    pub enabled: bool,
    pub sensitivity: f32,
}
```

- [ ] **Step 3: Compile.** Run: `cd app/src-tauri && cargo check`
Expected: PASS (warnings OK). `BakeSpec` callers still compile because `auto_dust` defaults.

- [ ] **Step 4: Commit.**

```bash
git add app/src-tauri/src/gpu_upload.rs app/src-tauri/src/commands.rs
git commit -m "feat(autodust): add auto_dust to BakeSpec"
```

---

### Task 2: `union_mask` helper (with test)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add helper near `full_mask_from_stamps` ~line 1505, and a `#[cfg(test)]` test in the existing tests module)

**Interfaces:**
- Produces: `fn union_mask(a: film_core::dust::Mask, b: &film_core::dust::Mask) -> film_core::dust::Mask` — OR of two full-frame masks (`x0=y0=0`, equal `w,h`); if one is empty (`w==0||h==0`) returns the other.

- [ ] **Step 1: Write the failing test** in the `mod tests` block of `commands.rs`:

```rust
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
```

- [ ] **Step 2: Run to verify it fails.** Run: `cargo test union_mask -- --nocapture`
Expected: FAIL ("cannot find function `union_mask`").

- [ ] **Step 3: Implement** the helper (place above `bake_for_view`):

```rust
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
```

- [ ] **Step 4: Run to verify it passes.** Run: `cargo test union_mask`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(autodust): union_mask helper to merge defect + stroke masks"
```

---

### Task 3: `auto_dust_mask` helper (detector → mask, with prob cache passthrough)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add helper above `bake_for_view`)

**Interfaces:**
- Consumes: `bake_geometry` output (a baked NEGATIVE `film_core::Image`), a resolved `InversionParams` (`ip`), `Mode`, `sensitivity: f32`, and an optional cached prob `Option<(usize, usize, Vec<f32>)>`.
- Produces:
  `fn auto_dust_mask(app_data: &Path, baked: &film_core::Image, ip: &InversionParams, mode: Mode, sensitivity: f32, cached: Option<(usize, usize, Vec<f32>)>) -> (film_core::dust::Mask, Option<(usize, usize, Vec<f32>)>)`
  — returns the defect mask at `baked` dims, plus `Some(prob)` to insert into the cache when the detector freshly ran (else `None`).

- [ ] **Step 1: Implement** (no isolated unit test — needs the ONNX model; covered by the manual checks in Task 9). Reuse the exact thresholding the old `autodust_detect` used:

```rust
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
```

- [ ] **Step 2: Compile.** Run: `cargo check`
Expected: PASS. (Function is unused until Task 4 — `cargo check` allows dead code with a warning. If a `deny(warnings)` lint blocks it, proceed to Task 4 in the same commit.)

- [ ] **Step 3: Commit.**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(autodust): auto_dust_mask helper (detector → thresholded mask)"
```

---

### Task 4: Heal auto-dust in the bake path

**Files:**
- Modify: `app/src-tauri/src/commands.rs:1536-1563` (`bake_for_view` + `working_baked_pixels`)

**Interfaces:**
- Consumes: `union_mask`, `auto_dust_mask`, `full_mask_from_stamps`, `export_stamps`, `bake_geometry`, `crate::autodust::engine::inpaint`, `crate::autodust::assets::installed`.
- Produces: `bake_for_view(app_data, working, spec, auto_mask: Option<&film_core::dust::Mask>) -> film_core::Image`; `working_baked_pixels` now takes `params: InvertParams`.

- [ ] **Step 1: Refactor `bake_for_view`** to accept an optional auto-dust mask and always MI-GAN-heal when one is present (current single caller is `working_baked_pixels`). Replace the function body’s heal block:

```rust
fn bake_for_view(
    app_data: &Path,
    working: &film_core::Image,
    spec: &BakeSpec,
    auto_mask: Option<&film_core::dust::Mask>,
) -> film_core::Image {
    let mut img = bake_geometry(working, spec);
    let stamps = export_stamps(&spec.dust, img.width, img.height);
    let want_migan = (spec.migan || auto_mask.is_some())
        && crate::autodust::assets::installed(app_data);
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
```

- [ ] **Step 2: Thread `params` + auto-dust into `working_baked_pixels`.** Replace the command (resolve `ip` from the image’s base/thumb, pull the cached prob, compute the mask + heal off-thread, then write any fresh prob back):

```rust
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
    // The heal can run the detector + MI-GAN (seconds) — keep it off the main thread.
    let (bytes, fresh) = tauri::async_runtime::spawn_blocking(move || {
        let baked = bake_geometry(&working, &spec);
        let (auto_mask, fresh) = if do_auto && crate::autodust::assets::installed(&app_data) {
            let (m, fr) = auto_dust_mask(&app_data, &baked, &ip, mode, sens, cached);
            (Some(m), fr)
        } else {
            (None, None)
        };
        let healed = bake_for_view_from_baked(&app_data, baked, &spec, auto_mask.as_ref());
        let (_, _, bytes) = pack_rgba16f(&healed, MAX_GPU_EDGE);
        (bytes, fresh)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(p) = fresh {
        session.autodust_prob.lock().unwrap().insert(id, p);
    }
    Ok(tauri::ipc::Response::new(bytes))
}
```

Note: `bake_geometry` is computed in the command, so refactor `bake_for_view` to a `bake_for_view_from_baked(app_data, baked: film_core::Image, spec, auto_mask)` that takes the already-geometry-baked image (avoids double geometry). Apply that rename: change the Step-1 signature to `fn bake_for_view_from_baked(app_data: &Path, mut img: film_core::Image, spec: &BakeSpec, auto_mask: Option<&film_core::dust::Mask>) -> film_core::Image` and drop its internal `bake_geometry` call (the caller already baked).

- [ ] **Step 3: Compile.** Run: `cargo check`
Expected: PASS. Confirm no other caller of the old `bake_for_view` remains: `grep -n "bake_for_view\b" app/src-tauri/src/commands.rs` shows only the definition + the call inside `working_baked_pixels`.

- [ ] **Step 4: Run the Rust test suite.** Run: `cargo test`
Expected: PASS (existing autodust/upscale/union tests green).

- [ ] **Step 5: Commit.**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(autodust): heal auto-dust mask in the GPU bake path"
```

---

### Task 5: Remove the old `autodust_detect` command

**Files:**
- Modify: `app/src-tauri/src/commands.rs:2088-2145` (delete `autodust_detect`)
- Modify: `app/src-tauri/src/autodust/mod.rs` (remove `AutoDustResult`)
- Modify: `app/src-tauri/src/lib.rs` (remove `commands::autodust_detect` from the `generate_handler!` list)

**Interfaces:**
- Removes: the `autodust_detect` command and `AutoDustResult` type. Keeps `autodust_status`, `download_autodust`, the `autodust_prob` cache, and `pending_upscale`/`save_upscaled` (upscaler).

- [ ] **Step 1: Delete** the entire `autodust_detect` command (its doc comment through the closing brace, `commands.rs` ~2083-2145). Confirm `pending_upscale` is still written by `upscale_image` (`grep -n "pending_upscale" app/src-tauri/src/commands.rs` keeps the upscale + `save_upscaled` references).

- [ ] **Step 2: Remove `AutoDustResult`** from `app/src-tauri/src/autodust/mod.rs` (the struct + any `use`/`Serialize` only it needed). Keep `MAX_BLOB`, `DETECT_SHORT`, `TILE`, `TILE_PAD`.

- [ ] **Step 3: Remove from the handler list** in `app/src-tauri/src/lib.rs`: delete the `commands::autodust_detect,` line inside `tauri::generate_handler![...]`.

- [ ] **Step 4: Compile.** Run: `cargo check`
Expected: PASS. (If the compiler flags an unused import that only `autodust_detect` used, remove it.)

- [ ] **Step 5: Commit.**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/autodust/mod.rs app/src-tauri/src/lib.rs
git commit -m "refactor(autodust): remove autodust_detect (heal now lives in bake)"
```

---

### Task 6: Frontend API — `BakeSpec.auto_dust`, `params` on bake, drop `autodustDetect`

**Files:**
- Modify: `app/src/lib/api.ts:1-3` (type import), `:108-113` (`BakeSpec`), `:279-283` (`workingBaked*`), `:247-260` (remove `autodustDetect`)

**Interfaces:**
- Consumes (Rust): `working_baked_pixels(id, params, spec)`.
- Produces (TS): `BakeSpec.auto_dust: AutoDust`; `api.workingBakedPixels(id, spec, params)`.

- [ ] **Step 1: Import the `AutoDust` type.** At the top of `api.ts`, extend the dust import:

```ts
import type { DustStroke, IrRemoval, AutoDust } from "./develop/dust";
export type { DustStroke, IrRemoval };
```

- [ ] **Step 2: Add `auto_dust` to the `BakeSpec` interface:**

```ts
export interface BakeSpec {
  rot90: number; flip_h: boolean; flip_v: boolean; angle: number;
  image_crop: [number, number, number, number] | null;
  dust: DustStroke[];
  ir_removal: IrRemoval;
  auto_dust: AutoDust;
}
```

- [ ] **Step 3: Pass `params` to `workingBakedPixels`** (detection needs them). `workingBakedInfo` is geometry-only — leave it unchanged:

```ts
  workingBakedPixels: (id: string, spec: BakeSpec, params: InvertParams) =>
    invoke<ArrayBuffer>("working_baked_pixels", {
      id, params, spec: { ...spec, dust: wireDust(spec.dust) },
    }),
```

- [ ] **Step 4: Delete the `autodustDetect` method** (the whole `autodustDetect: (...) => invoke<{ previewDataUrl … }>("autodust_detect", {...})` block). Keep `autodustStatus` and `downloadAutodust`.

- [ ] **Step 5: Typecheck.** Run: `cd app && npm run check`
Expected: errors ONLY in `Viewport.svelte` / `AutoDustPanel.svelte` (fixed in Tasks 7-8) for the changed call signature / removed method. No errors in `api.ts` itself.

- [ ] **Step 6: Commit.**

```bash
git add app/src/lib/api.ts
git commit -m "feat(autodust): BakeSpec.auto_dust + params on workingBakedPixels; drop autodustDetect"
```

---

### Task 7: Viewport — bake on auto-dust toggle and pass params

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte` (props ~top; `bakeMode` ~222; `currentUploadKey` ~234; `uploadWorking` spec ~245-260; reactive trigger ~306)

**Interfaces:**
- Consumes: `autoDustEnabled`, `autoDustSensitivity` props from `Develop.svelte`; existing `params` prop.
- Produces: bake requests whose `spec.auto_dust` and `params` drive the backend heal.

- [ ] **Step 1: Add props** alongside the existing `brushMigan`/`aiApplied` exports:

```ts
  export let autoDustEnabled = false;
  export let autoDustSensitivity = 50;
```

- [ ] **Step 2: Include auto-dust in `bakeMode`** (so enabling it with no strokes still bakes):

```ts
  $: bakeMode = dust.length > 0 || irRemoval.enabled || autoDustEnabled;
```

- [ ] **Step 3: Key the texture on auto-dust** in `currentUploadKey()`'s bake branch (append before the geometry fields):

```ts
      return `bake|${id}|${developRev}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${brushMigan}|${aiApplied}|${autoDustEnabled}|${autoDustSensitivity}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}`;
```

- [ ] **Step 4: Send `auto_dust` in the spec and pass `params`** in `uploadWorking()`:

```ts
      const spec = {
        rot90, flip_h: flipH, flip_v: flipV, angle,
        image_crop: imageCrop, dust, ir_removal: irRemoval,
        migan: brushMigan && aiApplied,
        skip_dust_heal: brushMigan && !aiApplied,
        auto_dust: { enabled: autoDustEnabled, sensitivity: autoDustSensitivity },
      };
      const info = await api.workingBakedInfo(id, spec);
      const buf = await api.workingBakedPixels(id, spec, params);
```

- [ ] **Step 5: Re-fire the upload reaction on auto-dust changes.** In the reactive trigger line that lists `brushMigan; aiApplied; …; uploadWorking();`, add `autoDustEnabled; autoDustSensitivity;`:

```ts
  $: if (gpuEligible) { id; developRev; dustRev; irRemoval.enabled; irRemoval.sensitivity; brushMigan; aiApplied; autoDustEnabled; autoDustSensitivity; imageCrop; rot90; flipH; flipV; angle; uploadWorking(); }
```

- [ ] **Step 6: Typecheck.** Run: `cd app && npm run check`
Expected: errors only in `AutoDustPanel.svelte` now (Task 8).

- [ ] **Step 7: Commit.**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(autodust): viewport bakes auto-dust heal live"
```

---

### Task 8: AutoDustPanel — toggle button; remove preview/count/Save

**Files:**
- Modify: `app/src/lib/develop/AutoDustPanel.svelte`

**Interfaces:**
- Consumes: `enabled` prop; emits `toggle: boolean` and `sensitivity: number`.
- Produces: a toggle that flips `autoDust.enabled` via `Develop.svelte`.

- [ ] **Step 1: Replace the script's result/save state and imports.** Remove `import { save } from "@tauri-apps/plugin-dialog";` and `ExportFormat` from the api import; remove `result`, `count`, `busy`, `detect()`, `saveResult()`. Add the `enabled` prop and a `toggle` event:

```ts
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { t } from "$lib/i18n";
  import { api } from "../api";
  import { autodustInstalled } from "../store";

  export let enabled = false;
  /** Persisted per-image sensitivity (0..100). */
  export let sensitivity = 50;

  const dispatch = createEventDispatcher<{ sensitivity: number; toggle: boolean }>();
```

(Keep the existing `id`, `params`, `imageCrop`, `geom`, `dust`, `irRemoval` exports if other bindings still pass them; they are now unused by the panel but harmless. Remove them only if `Develop.svelte` stops passing them in Task 9.)

- [ ] **Step 2: Simplify the handlers.** Keep download/status logic; replace `onSensitivity` so it only persists + emits (the viewport re-bakes via its key), and add a toggle:

```ts
  function onSensitivity(v: number) {
    sensitivity = v;
    dispatch("sensitivity", v);
  }
  function toggle() {
    dispatch("toggle", !enabled);
  }
```

- [ ] **Step 3: Replace the installed-branch markup.** Swap the "detect" button + result block for a toggle and keep the sensitivity slider:

```svelte
    <button class="go" class:active={enabled} disabled={!id} on:click={toggle}>
      <span>{$t("eraser.autoButton")}</span>
    </button>
```

Delete the entire `{#if result} … {/if}` block (preview `<img>`, `.dims` count, and the Save `button.row`).

- [ ] **Step 4: Drop now-unused CSS** (`.result`, `.result img`, `.dims`, `.row`, `.spinner`, `@keyframes spin`) and add an active style:

```css
  .go.active { background: rgba(244,157,78,0.34); border-color: rgba(244,157,78,0.85); }
```

- [ ] **Step 5: Typecheck.** Run: `cd app && npm run check`
Expected: PASS (no errors). If `Develop.svelte` still references the panel’s old API, those are fixed in Task 9 — re-run after Task 9.

- [ ] **Step 6: Commit.**

```bash
git add app/src/lib/develop/AutoDustPanel.svelte
git commit -m "feat(autodust): panel becomes a live toggle; remove preview + Save"
```

---

### Task 9: Develop.svelte wiring + end-to-end verification

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte:27` (import), `:262` area (add `setAutoOn`), `:338-341` (Viewport props), `:375-379` (panel props)

**Interfaces:**
- Consumes: `setAutoDustEnabled` from `dust.ts`; the panel’s `toggle` event.
- Produces: `dust.autoDust.enabled/sensitivity` flow to the Viewport bake and into undo.

- [ ] **Step 1: Import `setAutoDustEnabled`.** Extend the dust import on line 27 to include `setAutoDustEnabled`.

- [ ] **Step 2: Add the toggle handler** near `setAutoSens` (line ~262):

```ts
  function setAutoOn(on: boolean) { updateDust((d) => setAutoDustEnabled(d, on)); }
```

- [ ] **Step 3: Pass auto-dust to the Viewport** (add to the `<Viewport …>` props near `brushMigan={…} aiApplied={…}`):

```svelte
                  autoDustEnabled={dust.autoDust.enabled}
                  autoDustSensitivity={dust.autoDust.sensitivity}
```

- [ ] **Step 4: Wire the panel** (lines 375-379) — add `enabled` + `on:toggle`:

```svelte
            <AutoDustPanel id={$activeId} params={effParams} imageCrop={imageCrop}
                           geom={{ rot90, flip_h: flipH, flip_v: flipV, angle }}
                           dust={dust.strokes} irRemoval={dust.irRemoval}
                           enabled={dust.autoDust.enabled}
                           sensitivity={dust.autoDust.sensitivity}
                           on:toggle={(e) => setAutoOn(e.detail)}
                           on:sensitivity={(e) => setAutoSens(e.detail)} />
```

(Match the existing prop lines; keep whatever `geom`/`dust`/`irRemoval` props were there.)

- [ ] **Step 5: Typecheck + build.** Run: `cd app && npm run check`
Expected: PASS, no errors anywhere.

- [ ] **Step 6: Full backend test.** Run: `cd app/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Manual verification (run the app).** With the AI models installed:
  - Toggle **AI dust removal** on → the main viewport updates to show the heal (no separate preview image appears). Button shows active state.
  - Move the **sensitivity** slider and release → the heal updates on the main viewport.
  - Tweak exposure/contrast → instant (no re-heal lag), heal persists.
  - **Cmd+Z** → reverts the last auto-dust change (slider step, then toggle-off); **Cmd+Shift+Z** redoes.
  - The **Save**/export button and the count line are gone from the panel.
  - Draw a manual eraser stroke with auto-dust on → both heal together.
  - **Regression:** the upscaler’s Save/export still works (it uses `pending_upscale`).
  - Verify on macOS (CoreML) and Windows (CPU) — expect a couple-second heal per toggle/slider-release on Windows; the slider commits on release only.

- [ ] **Step 8: Commit.**

```bash
git add app/src/lib/tabs/Develop.svelte
git commit -m "feat(autodust): wire live auto-dust toggle into Develop view"
```

---

## Self-review notes

- **Spec coverage:** data model (Task 1, 9), bake/render integration (Tasks 2-4), frontend toggle + removal of preview/Save (Tasks 6-9), cleanup of `autodust_detect` keeping `pending_upscale` (Task 5), undo (no code — Task 9 Step 7 verifies). CPU `render_view` and export-of-auto-dust are explicitly deferred (Scope section) — a deviation from the spec’s mention of `render_view`, called out so the reviewer can object.
- **Type consistency:** `auto_dust` (Rust `BakeSpec`) ↔ `auto_dust` (TS `BakeSpec`) ↔ `AutoDust { enabled, sensitivity }` (dust.ts) all match; `working_baked_pixels(id, params, spec)` matches `api.workingBakedPixels(id, spec, params)` argument mapping in the invoke object.
- **No placeholders:** all steps carry concrete code/commands.
```
