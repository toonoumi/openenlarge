# Lazy Cache-Aware Develop on Quality Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switching preview quality (`Performance` ⇄ `Quality`) should re-develop only the image on screen, not the whole folder.

**Architecture:** Add an idempotent, cache-aware backend command `ensure_developed(id)` that re-decodes a RAW only when the resident working buffer is too small for the current quality. The quality-switch UI calls it for the active image only; the Develop view calls it on navigation (with a stale guard). A `developRev` token busts the Viewport's GPU/CPU render caches so an upgraded buffer actually re-renders.

**Tech Stack:** Rust (Tauri commands), Svelte/TypeScript frontend, vitest (TS unit tests), `cargo test` (Rust unit tests).

**Reference spec:** `docs/superpowers/specs/2026-06-05-lazy-develop-quality-switch-design.md`

---

## File Structure

- `app/src-tauri/src/commands.rs` — add `working_satisfies` helper, extract `develop_heavy`, add `ensure_developed` command.
- `app/src-tauri/src/lib.rs` — register `ensure_developed` in the invoke handler.
- `app/src/lib/api.ts` — add `ensureDeveloped` binding.
- `app/src/lib/store.ts` — add `developRev` store.
- `app/src/lib/viewport/QualityMenu.svelte` — cheap quality switch (active image only).
- `app/src/lib/viewport/Viewport.svelte` — accept `developRev` prop; thread into upload + CPU render cache keys.
- `app/src/lib/tabs/Develop.svelte` — develop-on-navigation effect + pass `developRev` to Viewport.
- `app/src/lib/workflow.ts` — remove now-dead `markAllUndeveloped`.

---

## Task 1: Backend adequacy helper (`working_satisfies`)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (near the other `const`/free fns at the top, after line 78 `const CACHE_WORKING_CAP`)
- Test: same file, in the existing `#[cfg(test)]` module (add one if none exists at the bottom of `commands.rs`)

A resident `working` buffer satisfies quality cap `cap` when its long edge is at least `min(native_edge, cap)`. Pure integer logic — easy to unit test.

- [ ] **Step 1: Write the failing test**

Add to `app/src-tauri/src/commands.rs` (create the test module if it does not already exist at the end of the file):

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/src-tauri && cargo test working_satisfies`
Expected: FAIL — `cannot find function working_satisfies in this scope`.

- [ ] **Step 3: Write minimal implementation**

Add near the top of `app/src-tauri/src/commands.rs` (just below `const CACHE_WORKING_CAP: u32 = 4096;` at line 78):

```rust
/// True when a resident working buffer is large enough for `cap`. The buffer is
/// adequate once its long edge reaches `min(native_edge, cap)` — Performance
/// (cap 4096) is satisfied by any cached buffer; Quality (cap u32::MAX) needs the
/// full-res decode unless the source is already smaller than the cache cap.
fn working_satisfies(working_edge: u32, native_edge: u32, cap: u32) -> bool {
    working_edge >= native_edge.min(cap)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/src-tauri && cargo test working_satisfies`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(develop): add working_satisfies adequacy helper"
```

---

## Task 2: Backend `ensure_developed` command

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (extract `develop_heavy` from `develop_image`; add `ensure_developed`)
- Modify: `app/src-tauri/src/lib.rs:51-54` (register command)

`develop_image` (lines 319-378) currently holds the whole heavy decode path. Extract the body into a private `develop_heavy(id, &session, &catalog)` so both the existing command and the new `ensure_developed` can call it. `ensure_developed` first tries `ensure_resident` (cache load, no decode), checks adequacy, and only decodes when needed.

- [ ] **Step 1: Extract the heavy path into `develop_heavy`**

In `app/src-tauri/src/commands.rs`, replace the `develop_image` command (lines 319-378) with a thin wrapper plus a shared private fn. The existing `#[tauri::command] pub fn develop_image(...)` keeps its signature; its body becomes a single call.

```rust
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
    let base = sample_base(&working, None);
    let (w, h) = (full.width as u32, full.height as u32);
    drop(full);

    let small = proxy(&working, THUMB_EDGE);
    let defaults = default_invert_params();
    let ip = resolve_params(&defaults, &thumb, base);
    let inv_thumb = invert_image(&small, &ip, Mode::B);
    let inv_thumb = finish_image(&inv_thumb, &finish_from(&defaults));
    let thumbnail = to_jpeg_b64(&inv_thumb, false, 82)?;

    let cache_working = if working.width.max(working.height) > CACHE_WORKING_CAP as usize {
        crate::convert::proxy(&working, CACHE_WORKING_CAP)
    } else {
        working.clone()
    };
    let cache_thumb = thumb.clone();

    let (entry, metadata_json) = {
        let mut images = session.images.lock().unwrap();
        let img = images.get_mut(&id).ok_or("unknown image id")?;
        img.metadata.width = w;
        img.metadata.height = h;
        img.thumbnail = thumbnail.clone();
        img.developed = Some(Developed { working, thumb, base });
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
        };
        (entry, metadata_json)
    };

    if let Err(e) = catalog.update_image_render(&id, &entry.thumbnail, &metadata_json) {
        eprintln!("[catalog] update_image_render failed for {id}: {e}");
    }

    if let Err(e) = crate::cache::write(&session.cache_path(&id), base, &cache_working, &cache_thumb) {
        eprintln!("[cache] write failed for {id}: {e}");
    }

    Ok(entry)
}
```

Note: `develop_heavy` takes `&Session`/`&crate::catalog::Catalog`. The command wrapper passes `&session`/`&catalog`; Tauri's `State<T>` derefs to `&T`, so `&session` yields `&State<Session>` — instead call `develop_heavy(id, &session, &catalog)` where `session`/`catalog` are `State` and rely on auto-deref via `&*`. Use explicit deref to be safe: `develop_heavy(id, &session, &catalog)` → change the wrapper call to `develop_heavy(id, &session, &catalog)` and the fn params to `session: &Session, catalog: &crate::catalog::Catalog`; pass `&*session, &*catalog`.

Concretely, the wrapper body is:

```rust
    develop_heavy(id, &session, &catalog)
```

and if the compiler complains about `&State<Session>` vs `&Session`, change it to:

```rust
    develop_heavy(id, &session, &catalog)   // State<T> derefs to &T
```

If that still fails to coerce, use `develop_heavy(id, &*session, &*catalog)`.

- [ ] **Step 2: Verify it still compiles (refactor is behavior-preserving)**

Run: `cd app/src-tauri && cargo build`
Expected: builds clean; `develop_image` unchanged in behavior.

- [ ] **Step 3: Add the `ensure_developed` command**

Add after `set_quality` (after line 391 in `app/src-tauri/src/commands.rs`):

```rust
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
```

- [ ] **Step 4: Register the command**

In `app/src-tauri/src/lib.rs`, add `commands::ensure_developed,` to the `generate_handler!` list (right after `commands::develop_image,` on line 53):

```rust
            commands::develop_image,
            commands::ensure_developed,
            commands::set_quality,
```

- [ ] **Step 5: Build + run backend tests**

Run: `cd app/src-tauri && cargo build && cargo test`
Expected: builds clean; all tests pass (including Task 1's `adequacy_tests`).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(develop): add idempotent cache-aware ensure_developed command"
```

---

## Task 3: Frontend API binding + `developRev` store

**Files:**
- Modify: `app/src/lib/api.ts:163-164` (add binding)
- Modify: `app/src/lib/store.ts` (add store)

- [ ] **Step 1: Add the `ensureDeveloped` binding**

In `app/src/lib/api.ts`, just after `developImage` (line 163):

```ts
  developImage: (id: string) => invoke<ImageEntry>("develop_image", { id }),
  ensureDeveloped: (id: string) => invoke<ImageEntry>("ensure_developed", { id }),
```

- [ ] **Step 2: Add the `developRev` store**

In `app/src/lib/store.ts`, next to the existing `quality` store (line 20):

```ts
export const quality = writable<Quality>("performance");
/** Bumped whenever an image's resident working buffer is re-developed/upgraded,
 *  so the Viewport busts its GPU/CPU render caches and re-fetches the buffer. */
export const developRev = writable(0);
```

(Confirm `writable` is already imported at the top of `store.ts`; it is used by `quality`.)

- [ ] **Step 3: Typecheck**

Run: `cd app && npm run check`
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/store.ts
git commit -m "feat(develop): add ensureDeveloped binding + developRev store"
```

---

## Task 4: Cheap quality switch in QualityMenu

**Files:**
- Modify: `app/src/lib/viewport/QualityMenu.svelte`

Replace the eager `markAllUndeveloped()` + `developAll()` with a single `ensureDeveloped` for the active image, then bump `developRev`.

- [ ] **Step 1: Rewrite the component script**

Replace lines 1-22 of `app/src/lib/viewport/QualityMenu.svelte` with:

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { get } from "svelte/store";
  import { quality, activeId, images, developRev } from "../store";
  import { api, type Quality } from "../api";
  import { t } from "$lib/i18n";
  export let x = 0;
  export let y = 0;
  const dispatch = createEventDispatcher();

  async function pick(q: Quality) {
    if (q !== $quality) {
      quality.set(q);
      await api.setQuality(q);
      dispatch("close");
      // Only the image on screen needs the new quality now; others upgrade lazily
      // when navigated to (see Develop.svelte). ensure_developed is a no-op when the
      // resident buffer already satisfies the new quality (e.g. switching to Performance).
      const id = get(activeId);
      if (id) {
        try {
          const updated = await api.ensureDeveloped(id);
          images.update((list) => list.map((i) => (i.id === id ? updated : i)));
          developRev.update((n) => n + 1);
        } catch (e) {
          console.error("ensureDeveloped failed", id, e);
        }
      }
    } else {
      dispatch("close");
    }
  }
</script>
```

(The `<div class="menu">...` markup and `<style>` below stay exactly as-is.)

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: no errors; note that `developAll`/`markAllUndeveloped` are no longer imported here (they are removed from `workflow.ts` in Task 7).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/viewport/QualityMenu.svelte
git commit -m "feat(develop): quality switch re-develops only the active image"
```

---

## Task 5: Thread `developRev` through the Viewport render caches

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte`

The GPU upload key (`raw|${id}`) and CPU `cpuKey` do not change when only the working buffer's resolution changes, so an upgraded buffer would not re-render. Add a `developRev` prop and include it in both cache keys + the upload trigger.

- [ ] **Step 1: Add the prop**

In `app/src/lib/viewport/Viewport.svelte`, alongside the other `export let` props (near the top of the `<script>`, with `dustRev`), add:

```ts
  export let developRev = 0;
```

- [ ] **Step 2: Include `developRev` in the GPU upload key**

In `currentUploadKey()` (lines 170-175), add `developRev` to both branches:

```ts
  function currentUploadKey(): string {
    if (bakeMode) {
      return `bake|${id}|${developRev}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}`;
    }
    return `raw|${id}|${developRev}`;
  }
```

- [ ] **Step 3: Add `developRev` to the upload trigger**

On the upload-trigger reactive line (line 247), add `developRev` to the dependency list:

```ts
  $: if (gpuEligible) { id; developRev; dustRev; irRemoval.enabled; irRemoval.sensitivity; imageCrop; rot90; flipH; flipV; angle; uploadWorking(); }
```

- [ ] **Step 4: Add `developRev` to the CPU render key**

In `cpuKey` (line 263), append `developRev` to the template string (e.g. right after `${id}|`):

```ts
  $: cpuKey = gpuEligible ? '' :
    `${id}|${developRev}|${raw}|${eff}|${vpW}|${vpH}|${params.mode}|${params.stock}|${params.exposure}|${params.temp}|${params.tint}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${JSON.stringify(params.base_override)}`;
```

- [ ] **Step 5: Typecheck**

Run: `cd app && npm run check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(develop): bust Viewport render caches on developRev bump"
```

---

## Task 6: Develop-on-navigation in Develop.svelte

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte` (script: add effect; markup: pass `developRev` prop)

When `activeId` changes, ensure the newly-selected image is developed at the current quality, then bump `developRev`. A stale guard discards results if the user has navigated on.

- [ ] **Step 1: Import the stores + `get`**

In `app/src/lib/tabs/Develop.svelte`, extend the existing imports:

- Add `developRev` to the store import on line 3 (the `from "../store"` list).
- Add `get` from svelte/store near the top of the script:

```ts
  import { get } from "svelte/store";
```

- [ ] **Step 2: Add the navigation effect**

In the `<script>` of `Develop.svelte`, after the `$: active = ...` derivations (around line 35), add:

```ts
  // Lazily upgrade the selected image to the current quality. No-op on the backend
  // when the resident buffer already satisfies it (Performance, or already full-res),
  // so this is cheap on every navigation. The stale guard drops results when the
  // user has already moved on (rapid arrow-key stepping in Quality mode).
  let lastEnsured: string | null = null;
  async function ensureActiveDeveloped(id: string | null) {
    if (!id || id === lastEnsured) return;
    lastEnsured = id;
    try {
      const updated = await api.ensureDeveloped(id);
      if (get(activeId) !== id) return; // navigated away mid-decode
      images.update((list) => list.map((i) => (i.id === id ? updated : i)));
      developRev.update((n) => n + 1);
    } catch (e) {
      console.error("ensureDeveloped failed", id, e);
    }
  }
  $: ensureActiveDeveloped($activeId);
```

- [ ] **Step 3: Pass `developRev` to the Viewport**

In the Viewport invocation (lines 230-235), add the `developRev` prop:

```svelte
        <Viewport id={$activeId} params={effParams} imgW={effW} imgH={effH} imageCrop={imageCrop}
                  rot90={cRot} flipH={committed?.flipH ?? false} flipV={committed?.flipV ?? false} angle={committed?.angle ?? 0}
                  eraser={$tool === "eraser"} {brush} dust={dust.strokes} irRemoval={dust.irRemoval} dustRev={$dustRev}
                  developRev={$developRev}
                  pointPick={pointPicking}
                  on:stroke={(e) => commitStroke(e.detail)} on:brush={(e) => (brush = e.detail)}
                  on:pointpick={onPointPick} />
```

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tabs/Develop.svelte
git commit -m "feat(develop): upgrade image to current quality on navigation"
```

---

## Task 7: Remove dead `markAllUndeveloped` + full verification

**Files:**
- Modify: `app/src/lib/workflow.ts:65-68` (remove the now-unused export)

After Task 4, `markAllUndeveloped` has no callers (verified: only QualityMenu used it). Remove it. `developAll` stays — still used for the first Library→Develop bulk develop.

- [ ] **Step 1: Confirm no remaining callers**

Run: `cd app && rg -n "markAllUndeveloped" src`
Expected: only the definition in `src/lib/workflow.ts` (no other references).

- [ ] **Step 2: Remove the function**

Delete these lines from `app/src/lib/workflow.ts`:

```ts
/** Mark all images undeveloped (used when the quality setting changes). */
export function markAllUndeveloped(): void {
  images.update((list) => list.map((i) => ({ ...i, developed: false })));
}
```

(If `images` becomes unused in `workflow.ts` after this, leave the import — `developAll` still uses `images` on line 48. Verify with `npm run check`.)

- [ ] **Step 3: Run the full TS test + check suite**

Run: `cd app && npm run check && npm run test:unit`
Expected: typecheck clean; all vitest suites pass (`workflow.test.ts` does not reference `markAllUndeveloped`).

- [ ] **Step 4: Run the full Rust test suite**

Run: `cd app/src-tauri && cargo test`
Expected: all tests pass.

- [ ] **Step 5: Manual verification (app running)**

Run the app (`cd app && npm run tauri dev`), import a folder with at least 3 RAWs (ideally from a >4096px camera), then:

1. Enter Develop (initial bulk develop runs once — expected).
2. Open the quality menu and switch **Performance → Quality**. Confirm: no full-folder progress overlay; the active image sharpens after a short re-decode; other thumbnails are untouched.
3. Arrow to another image. Confirm it re-decodes to full res on arrival (brief), and the previous image's buffer is unaffected.
4. Switch **Quality → Performance**. Confirm: instant, no decode, no progress overlay.
5. Rapidly arrow through several images in Quality mode. Confirm no stale/old-resolution frame sticks (stale guard working).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/workflow.ts
git commit -m "refactor(develop): drop unused markAllUndeveloped after lazy switch"
```

---

## Self-Review Notes

- **Spec coverage:** Backend `ensure_developed` + adequacy (Tasks 1-2); cheap quality switch (Task 4); develop-on-navigation + stale guard (Task 6); cache-key invalidation so upgrades render (Task 5, an implementation necessity the spec implied via "re-render the viewport"); bulk develop retained for first entry (untouched); progress overlay removed from switch path (Task 4 — no `developAll` call).
- **Type consistency:** `ensureDeveloped` returns `ImageEntry` (matches `develop_image`); `working_satisfies(working_edge, native_edge, cap)` argument order is identical in test and call site; `developRev` is a `writable<number>` passed as `developRev={$developRev}` and received as `export let developRev = 0`.
- **Native dims caveat:** the adequacy check reads `img.metadata.{width,height}`, which `develop_heavy` sets to real decoded dims. Any image reaching `ensure_developed` via the cache path has been through `develop_heavy` at least once, so these are reliable; never-developed images fall through to a full `develop_heavy`.
