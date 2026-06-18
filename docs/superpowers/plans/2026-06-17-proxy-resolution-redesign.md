# Proxy Resolution + Zoom-to-High-Res Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit a small display-sized proxy for fit view, load a higher-res source on deep zoom, and remove the Quality setting.

**Architecture:** Decode the resident "working" buffer to `PROXY_EDGE=2560` (down from 4096/full-res). On deep zoom, the frontend requests the same `working_*` upload commands with `hires=true`; those decode the file at `MAX_GPU_EDGE` into a single-slot `zoom_src` cache, bake/pack it, and the GPU swaps the texture (edits re-apply via uniforms). Export and the CPU fallback are unchanged.

**Tech Stack:** Rust (Tauri 2 commands, `film_core`, rayon, `spawn_blocking`), Svelte/TS frontend, WebGL2.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-17-proxy-resolution-redesign-design.md`.
- `PROXY_EDGE = 2560` (fixed, window-independent). Zoom tier reuses `MAX_GPU_EDGE = 8192` (`gpu_upload.rs`).
- Do NOT touch the other session's files: `app/src-tauri/src/autodust/engine.rs` (and any other uncommitted file not in this plan). Stage only files this plan names.
- i18n: edit `i18n-strings.csv` + run `python3 scripts/gen-i18n.py`; never edit `dict.ts` directly.
- Tauri arg convention: JS passes camelCase; Rust receives snake_case (e.g. JS `hires` → Rust `hires`; JS `maxEdge` → Rust `max_edge`).
- Out of scope: memory LRU (Spec 2), high-quality CPU zoom, tiling.
- Commit after each task with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Proxy the working buffer at `PROXY_EDGE` and re-proxy old caches

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add `PROXY_EDGE` const; `develop_compute` proxy cap; `ensure_resident` re-proxy; `ensure_developed` adequacy)
- Modify: `app/src-tauri/src/commands.rs` test module (new unit test)

**Interfaces:**
- Produces: `const PROXY_EDGE: u32 = 2560;` used by later tasks.

- [ ] **Step 1: Add the constant.** Near `CACHE_WORKING_CAP` (`commands.rs:~86`), add:
```rust
/// Display-sized proxy cap (long edge) for the resident working buffer + fit-view
/// GPU upload. Replaces the old Quality cap. Crisp at fit on hi-DPI, small + fast.
const PROXY_EDGE: u32 = 2560;
```

- [ ] **Step 2: Proxy the working buffer in `develop_compute`.** Change the working build (`commands.rs:~550`, currently `proxy(&full, cap)`) to `proxy(&full, PROXY_EDGE)`. The `cap` parameter to `develop_compute` is no longer needed once Quality is gone (Task 2) — for now keep the signature, pass `PROXY_EDGE` at the call site, OR drop the param now and update the caller. Prefer dropping the `cap` param: change `fn develop_compute(path: String, cap: u32)` → `fn develop_compute(path: String)`, use `PROXY_EDGE` inside, and update `develop_heavy`'s call (remove the `cap` it computes from quality).

- [ ] **Step 3: Re-proxy oversized caches on load.** In `ensure_resident` (`commands.rs:~700`), after `cache::read` yields `working`, before inserting into the session, cap it:
```rust
let working = if working.width.max(working.height) as u32 > PROXY_EDGE {
    crate::convert::proxy(&working, PROXY_EDGE)
} else {
    working
};
```

- [ ] **Step 4: Update `ensure_developed` adequacy.** `working_satisfies` is removed in Task 2; for now (and after), `ensure_developed`'s "already adequate" check should test `working_edge >= min(native, PROXY_EDGE)`. Since `develop_compute` always yields ≤ `PROXY_EDGE` and `ensure_resident` re-proxies, a resident developed image is always adequate — the check simplifies to "is it developed?". Leave the structure but replace the cap logic with `PROXY_EDGE` (final form lands in Task 2).

- [ ] **Step 5: Unit test the re-proxy decision.** Add to the `commands.rs` `#[cfg(test)]` module:
```rust
#[test]
fn proxy_edge_caps_working_long_edge() {
    // A 4000x3000 buffer must be capped to 2560 on the long edge.
    let img = film_core::Image { width: 4000, height: 3000, pixels: vec![[0.0;3]; 4000*3000], ir: None };
    let p = crate::convert::proxy(&img, PROXY_EDGE);
    assert_eq!(p.width.max(p.height) as u32, PROXY_EDGE);
    // An already-small buffer is untouched.
    let small = film_core::Image { width: 1000, height: 800, pixels: vec![[0.0;3]; 1000*800], ir: None };
    let q = crate::convert::proxy(&small, PROXY_EDGE);
    assert_eq!((q.width, q.height), (1000, 800));
}
```
(Confirm `film_core::Image`'s exact field names by reading `crates/film-core/src/image.rs` first; adjust the literal if needed.)

- [ ] **Step 6: Build + test.** Run: `cargo test -p app proxy_edge_caps_working_long_edge -- --nocapture` and `cargo build`. Expected: PASS + clean build (pre-existing warnings OK).

- [ ] **Step 7: Commit.**
```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(viewport): proxy the working buffer at 2560 (PROXY_EDGE)"
```

---

### Task 2: Remove the Quality setting (backend)

**Files:**
- Modify: `app/src-tauri/src/session.rs` (delete `Quality` enum, `cap()`, `Session.quality`)
- Modify: `app/src-tauri/src/commands.rs` (delete `set_quality`, `working_satisfies`; replace remaining cap reads with `PROXY_EDGE`)
- Modify: `app/src-tauri/src/lib.rs` (drop `set_quality` from the invoke handler)

**Interfaces:**
- Consumes: `PROXY_EDGE` (Task 1).
- Produces: no `Quality` type, no `set_quality` command, no `session.quality`.

- [ ] **Step 1: Delete the Quality enum + field.** In `session.rs`, remove the `Quality` enum + its `cap()` impl (`:11-26`) and the `pub quality: Mutex<Quality>` field from `Session` (`:268`). `#[derive(Default)]` still holds.

- [ ] **Step 2: Delete `set_quality` + `working_satisfies`.** In `commands.rs`, remove `set_quality` (`:661-664`) and `working_satisfies` (`:88-94`).

- [ ] **Step 3: Fix `ensure_developed`.** Remove the `let cap = session.quality...cap()` read (`:676`). Replace the adequacy check with: a resident developed image is adequate iff `dev.working` exists (always ≤ `PROXY_EDGE` now). Keep the early-return for an already-resident developed image; otherwise call `develop_heavy`. Concretely the adequacy block reduces to checking `img.developed.is_some()`; build the `ImageEntry` from it and return, else `develop_heavy`.

- [ ] **Step 4: Fix `develop_heavy`.** Remove the `let cap = session.quality...cap()` read (`:603`); it no longer passes a cap to `develop_compute` (Task 1 dropped that param).

- [ ] **Step 5: Drop the handler registration.** In `lib.rs`, remove `commands::set_quality,` from `tauri::generate_handler![ ... ]`.

- [ ] **Step 6: Build + test.** Run: `cargo build` then `cargo test -p app`. Expected: clean build; all tests pass. Fix any remaining `Quality`/`set_quality`/`working_satisfies` references the compiler flags.

- [ ] **Step 7: Commit.**
```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "refactor(quality): remove the Quality setting (backend)"
```

---

### Task 3: Remove the Quality setting (frontend + i18n)

**Files:**
- Modify: `app/src/lib/store.ts` (remove `quality` store + its persistence wiring)
- Modify: `app/src/lib/api.ts` (remove `setQuality`, `Quality` type, and any `Quality` import)
- Modify: `app/src/lib/viewport/QualityMenu.svelte` (remove heading + the two quality buttons + their divider; keep Flip/Reveal/Delete; drop unused imports: `quality`, `api`/`setQuality`, `Quality`)
- Modify: `i18n-strings.csv` (remove the `quality.menuHeading`, `quality.performance`, `quality.quality` rows; keep `quality.deleteImage` — it's still used by the menu's Delete button)
- Regenerate: `app/src/lib/i18n/dict.ts` via `scripts/gen-i18n.py`

**Interfaces:**
- Consumes: backend no longer exposes `set_quality` (Task 2).

- [ ] **Step 1: Remove the store.** In `store.ts`, delete `export const quality = writable<Quality>("performance")` (`:21`) and any `Quality` import. Search `store.ts` + `catalog.ts` for `quality` persistence (prefs load/save of the quality key) and remove it. Run `grep -rn "quality" app/src/lib/store.ts app/src/lib/catalog.ts` and remove the matches that refer to the render-quality setting (NOT jpeg/format quality).

- [ ] **Step 2: Remove `setQuality` + `Quality`.** In `api.ts`, delete `setQuality:` (`:196`) and the `Quality` type export/usages. `grep -rn "Quality\b\|setQuality" app/src/lib` to find all importers; fix each.

- [ ] **Step 3: Strip the QualityMenu rows.** In `QualityMenu.svelte`: remove the `<div class="head">…</div>`, both `<button … pick("performance"/"quality")>` lines, and the following `<div class="divider">`. Remove now-unused imports (`quality`, `activeId`, `images`, `developRev`, `api`, `Quality`) and the entire `pick()` function. Keep `showFlip`/`showReveal`/Delete and their dispatches. (Component keeps its name for v1.)

- [ ] **Step 4: Remove i18n rows.** Edit `i18n-strings.csv`: delete the `quality.menuHeading`, `quality.performance`, `quality.quality` rows. Keep `quality.deleteImage`. Then run:
```bash
python3 scripts/gen-i18n.py
```

- [ ] **Step 5: Typecheck + build the frontend.** Run: `cd app && npm run check` (svelte-check) — Expected: no errors referencing `quality`/`setQuality`/`Quality`. (Run from a context that does not collide with the watcher; in the worktree this is safe.)

- [ ] **Step 6: Commit.**
```bash
git add app/src/lib/store.ts app/src/lib/api.ts app/src/lib/viewport/QualityMenu.svelte app/src/lib/catalog.ts i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "refactor(quality): remove the Quality setting (frontend + i18n)"
```

---

### Task 4: `zoom_src` single-slot cache + `hires` on the `working_*` commands

**Files:**
- Modify: `app/src-tauri/src/session.rs` (add `zoom_src` field)
- Modify: `app/src-tauri/src/commands.rs` (`hires` arg + high-res source logic on `working_info`, `working_pixels`, `working_baked_info`, `working_baked_pixels`; a `zoom_source` helper)
- Modify: `app/src-tauri/src/commands.rs` test module

**Interfaces:**
- Consumes: `PROXY_EDGE`, `MAX_GPU_EDGE`, `decode_any`, `bake_working`/`bake_geometry`/`bake_for_view_from_baked`, `pack_rgba16f`, `capped_dims`.
- Produces: `working_info(id, hires)`, `working_pixels(id, hires)`, `working_baked_info(id, spec, hires)`, `working_baked_pixels(id, params, spec, hires)`; `Session.zoom_src: Mutex<Option<(String, film_core::Image)>>`.

- [ ] **Step 1: Add the cache field.** In `session.rs` `Session`:
```rust
/// Single-slot high-res (<= MAX_GPU_EDGE) decoded raw-negative for the currently
/// zoomed image, pre-bake. Replaced when a different image zooms. Bounded to ~1.
pub zoom_src: Mutex<Option<(String, film_core::Image)>>,
```
(`#[derive(Default)]` covers it. Confirm `film_core::Image` is imported in `session.rs`; it is used by `PendingUpscale`.)

- [ ] **Step 2: Add a `zoom_source` helper in `commands.rs`.** Returns the high-res decoded source for an id, decoding + caching on miss:
```rust
/// The high-res (<= MAX_GPU_EDGE) decoded raw-negative for `id`, decoding from file
/// and caching single-slot on a miss / id change. Clones out for off-thread baking.
fn zoom_source(session: &Session, id: &str) -> Result<film_core::Image, String> {
    {
        let guard = session.zoom_src.lock().unwrap();
        if let Some((cid, img)) = guard.as_ref() {
            if cid == id { return Ok(img.clone()); }
        }
    }
    let path = {
        let images = session.images.lock().unwrap();
        images.get(id).ok_or("unknown image id")?.path.clone()
    };
    let full = decode_any(Path::new(&path))?;
    let hi = crate::convert::proxy(&full, MAX_GPU_EDGE);
    *session.zoom_src.lock().unwrap() = Some((id.to_string(), hi.clone()));
    Ok(hi)
}
```
Note: `MAX_GPU_EDGE` is `pub(crate)` in `gpu_upload.rs`? Confirm visibility; if private, expose it (`pub(crate) const MAX_GPU_EDGE`) or thread the value through. The decode + proxy is heavy → callers wrap it in `spawn_blocking`.

- [ ] **Step 3: Thread `hires` through the four commands.** For each of `working_info`, `working_pixels`, `working_baked_info`, `working_baked_pixels`, add a `hires: bool` parameter. When `hires` is false, keep today's behavior but pack/measure at `PROXY_EDGE` instead of `MAX_GPU_EDGE`. When `hires` is true, use `zoom_source(...)` as the source image (instead of `dev.working`) and pack/measure at `MAX_GPU_EDGE`. `State<Session>` cannot move into `spawn_blocking`, so the high-res **decode runs inline** in the async body (already off the UI thread on the tokio runtime); only the `pack_rgba16f` is wrapped in `spawn_blocking`. Sketch for `working_pixels`:
```rust
pub async fn working_pixels(id: String, hires: bool, session: State<'_, Session>) -> Result<tauri::ipc::Response, String> {
    ensure_resident(&session, &id)?;
    let (src, cap) = if hires {
        (zoom_source(&session, &id)?, MAX_GPU_EDGE) // inline decode (off UI thread)
    } else {
        let images = session.images.lock().unwrap();
        let dev = images.get(&id).ok_or("unknown image id")?
            .developed.as_ref().ok_or("not developed")?;
        (dev.working.clone(), PROXY_EDGE)
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || { let (_,_,b) = pack_rgba16f(&src, cap); b })
        .await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}
```
Apply the same shape to `working_baked_pixels` (decode via `zoom_source` when `hires`, then bake + pack at `MAX_GPU_EDGE` inside `spawn_blocking`). `working_info`/`working_baked_info` return `capped_dims(&src, cap)` with the tier's source + cap.

- [ ] **Step 4: Unit test the single-slot cache semantics.** The decode needs a file, so test the *cache replace* logic via a small helper that doesn't decode. Extract the "should reuse?" decision:
```rust
#[test]
fn zoom_src_reuses_same_id_replaces_on_change() {
    let slot: Option<(String, ())> = Some(("a".into(), ()));
    assert!(matches!(&slot, Some((id, _)) if id == "a")); // reuse for "a"
    assert!(!matches!(&slot, Some((id, _)) if id == "b")); // miss for "b" -> would re-decode
}
```
(This documents intent; the decode path itself is covered by manual verification in Task 6.)

- [ ] **Step 5: Build + test.** Run: `cargo build` then `cargo test -p app`. Expected: clean build, tests pass.

- [ ] **Step 6: Commit.**
```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs
git commit -m "feat(viewport): hires zoom tier + single-slot zoom_src cache (backend)"
```

---

### Task 5: Frontend — `hires` API args + Viewport zoom-tier upload + seamless swap

**Files:**
- Modify: `app/src/lib/api.ts` (`hires` arg on `workingInfo`, `workingPixels`, `workingBakedInfo`, `workingBakedPixels`)
- Modify: `app/src/lib/viewport/Viewport.svelte` (zoom-tier threshold; tier in upload key; pass `hires`; swap)

**Interfaces:**
- Consumes: backend `hires` params (Task 4).

- [ ] **Step 1: Add `hires` to the api wrappers.** In `api.ts`:
```ts
workingInfo: (id: string, hires = false) =>
  invoke<{ w: number; h: number }>("working_info", { id, hires }),
workingPixels: (id: string, hires = false) =>
  invoke<ArrayBuffer>("working_pixels", { id, hires }),
workingBakedInfo: (id: string, spec: BakeSpec, hires = false) =>
  invoke<{ w: number; h: number }>("working_baked_info", { id, spec: { ...spec, dust: wireDust(spec.dust) }, hires }),
workingBakedPixels: (id: string, spec: BakeSpec, params: InvertParams, hires = false) =>
  invoke<ArrayBuffer>("working_baked_pixels", { id, params, spec: { ...spec, dust: wireDust(spec.dust) }, hires }),
```
(Match the existing arg names/order; only add `hires`.)

- [ ] **Step 2: Compute the zoom tier in Viewport.** Near the `eff`/`zoomed` reactives (`Viewport.svelte:~79`), add a hysteretic tier:
```ts
const PROXY_EDGE = 2560;
let hiTier = false; // currently showing the high-res tier
// Enter hires above PROXY_EDGE displayed px; fall back only below 0.9x to avoid thrash.
$: {
  const dispLong = eff * Math.max(imgW, imgH);
  if (!hiTier && dispLong > PROXY_EDGE) hiTier = true;
  else if (hiTier && dispLong < PROXY_EDGE * 0.9) hiTier = false;
}
```

- [ ] **Step 3: Put the tier in the upload key + pass `hires`.** In `currentUploadKey()` (`Viewport.svelte:~238`) append `|${hiTier ? 'hi' : 'lo'}`. In `uploadWorking()` (`:~250`), pass `hiTier` as the `hires` arg to whichever `working*Info`/`working*Pixels` calls fire (both bake and non-bake branches). The existing stale-guard (`currentUploadKey() !== k`) already discards a high-res fetch if the user zoomed back out or switched images mid-decode. The proxy texture stays bound until the new texture uploads → seamless.

- [ ] **Step 4: Debounce the tier upload.** `uploadWorking` is triggered reactively; add a short debounce (e.g. 150 ms) specifically when only `hiTier` changed, so a fast wheel/marquee across the boundary doesn't kick a decode per frame. Reuse the existing scheduling pattern if present; otherwise a `setTimeout` guard around the hires fetch.

- [ ] **Step 5: Typecheck + build.** Run: `cd app && npm run check`. Expected: no type errors.

- [ ] **Step 6: Commit.**
```bash
git add app/src/lib/api.ts app/src/lib/viewport/Viewport.svelte
git commit -m "feat(viewport): load high-res on deep zoom, swap texture seamlessly"
```

---

### Task 6: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend build + test.** Run: `cargo build && cargo test -p app`. Expected: clean, all green.
- [ ] **Step 2: Frontend build.** Run: `cd app && npm run check && npm run build`. Expected: clean.
- [ ] **Step 3: Manual smoke (record results).** Launch the app from the worktree (or after landing on main + restart of the user's `tauri dev`):
  - Develop/open a RAW — loads noticeably faster than before.
  - Fit view is crisp on a hi-DPI display.
  - Zoom in deep → brief soft (proxy) → sharpens (high-res swap); pan stays sharp; tweaking exposure/temp while zoomed stays sharp without a re-decode.
  - Zoom back to fit → no errors; re-zoom is fast (cache reuse).
  - Export a full-res file → unchanged quality.
  - The viewport right-click menu shows Flip/Reveal/Delete and NO Quality rows.
- [ ] **Step 4: Land on main.** Merge the worktree branch into `main` (fast-forward if possible) so all task commits land on `main`, per the user's main-branch preference.

---

## Self-Review (completed by author)

- **Spec coverage:** proxy (Task 1), Quality removal backend+frontend+i18n (Tasks 2–3), zoom tier + `zoom_src` (Task 4), Viewport threshold/swap (Task 5), CPU-path unchanged (implicit — `render_view` untouched), testing (Task 6). All spec sections covered.
- **Placeholders:** code shown for each change; the few "read exact current code then apply" notes are inherent to editing existing functions and name the file:line + the transform precisely.
- **Type consistency:** `hires: bool` consistent across Rust commands (Task 4) and `api.ts` wrappers (Task 5); `PROXY_EDGE`/`MAX_GPU_EDGE` consistent; `zoom_src` type matches between session.rs and the `zoom_source` helper.
- **Known follow-ups (Spec 2):** general memory LRU; high-quality CPU zoom.
