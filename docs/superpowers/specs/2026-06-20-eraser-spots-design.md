# Eraser improvements: fast fine-tune + per-spot icons & delete

**Date:** 2026-06-20
**Status:** Approved, ready for implementation plan

## Summary

Three related improvements to the develop-tab eraser/heal feature:

1. **Bug fix** — after running global AI dust removal, the AI-fill eraser becomes
   very slow because every fine-tune stroke re-inpaints the *entire* global dust
   mask. Fix with a two-stage heal that caches the auto-dust-healed buffer.
2. **Spot icons** — overlay a small eraser-glyph marker on every heal spot (manual
   brush strokes, AI-fill strokes, and global auto-detected dust), toggled by a new
   "Show heal spots" checkbox in the eraser panel.
3. **Per-spot delete** — select a spot (tap near its marker) and remove it via
   double-tap or the rebindable delete hotkey (Cmd/Ctrl+Backspace). Deleting a
   manual spot removes the stroke; deleting a global spot keeps that dust (adds it
   to a per-image exclusion list).

## Background / current architecture

- **Three heal modes** (all converge in `working_baked_pixels`, commands.rs:2110):
  - *Manual erase* — brush strokes → `dust::rasterize` → Telea inpaint (`dust::apply`).
  - *AI-fill eraser* — brush strokes with `brushMigan=true`; strokes shown as a red
    overlay until the user clicks "AI Erase", then MI-GAN inpaints the stroke mask.
  - *Global AI dust removal* — a persistent toggle; `auto_dust_mask` runs a U-Net
    detector (prob map cached in `session.autodust_prob`), thresholds at the
    sensitivity slider, and MI-GAN inpaints the detected mask.
- **Bake flow:** every bake starts from the clean `working` buffer →
  `bake_geometry` (geometry only; inversion is GPU-side) →
  `bake_for_view_from_baked` applies dust/IR heal pre-invert → RGBA16F upload.
- **Data model** (`app/src/lib/develop/dust.ts`): `DustEdits { strokes, irRemoval,
  autoDust, brushMigan, aiApplied }`. `DustStroke { points: {x,y}[], r }` with
  normalized coords/radius. Persisted via `save_dust` (commands.rs:1843).
- **Overlay rendering:** `Viewport.svelte` renders strokes as red SVG paths only in
  AI-mask-preview mode (lines ~774–786).
- **Delete hotkey:** `nav.delete` combo (`hotkeys.ts:56`), default Cmd/Ctrl+Backspace,
  rebindable. Currently deletes the active *image* (via `deleteTarget` store), not strokes.

## Part 1 — Bug fix: fast AI-fill after global dust removal

### Root cause

While global dust is enabled, `bake_for_view_from_baked` (commands.rs:2088–2094)
unions the user's stroke mask with the **entire** global dust mask and re-runs MI-GAN
over the union on every bake. A single fine-tune stroke therefore re-inpaints every
detected global spot (potentially hundreds), which is what "takes forever."

### Fix: two-stage heal with cached intermediate

Split the MI-GAN heal into two stages:

- **Stage A (auto-dust heal):** inpaint *only* the auto-dust mask onto the
  geometry-baked buffer, producing an **auto-dust-healed buffer**. Cache it in the
  session keyed by `(geometry signature, sensitivity, exclusions hash)`. Because the
  baked buffer depends only on geometry (not exposure/WB), the cache survives slider
  tweaks. Reuse on cache hit.
- **Stage B (stroke heal):** start from the Stage-A buffer (or the plain baked buffer
  when global dust is off) and inpaint *only the stroke mask* — **no union** with the
  auto-dust mask. A fine-tune stroke inpaints only its own small region.

Stage B inpainting on top of an already-healed buffer is correct: MI-GAN sees healed
neighbors.

### Caching details

- Cache lives in `Session` (alongside `autodust_prob`), e.g.
  `autodust_healed: HashMap<id, (key, film_core::Image)>` where `key` captures geometry
  signature + sensitivity + exclusions hash.
- Cache **only the fit/proxy path** (`hires == false`). For deep-zoom (`hires == true`),
  recompute Stage A fresh (deep-zoom buffers are large and short-lived; avoid bloating
  the cache).
- Invalidate naturally via the key: any change to geometry, sensitivity, or exclusions
  produces a new key and recomputes Stage A.
- Existing `autodust_prob` cache is unchanged (detector output reuse).

### Edge cases

- Global dust off → Stage A skipped; Stage B starts from the plain baked buffer
  (unchanged behavior, still fast).
- MI-GAN assets not installed → existing Telea fallback path unchanged.
- Sensitivity change → new key → Stage A recomputes once, then fine-tune strokes are
  fast again.

## Part 2 — Spot icons + per-spot delete

### Data model changes

Add to `DustEdits` (TS `dust.ts` and the Rust deserialization struct):

- `autoDustExclusions: {x,y}[]` — normalized seed points for global dust spots the user
  chose to **keep** (exclude from removal). Persisted.
- `showSpots: boolean` — overlay visibility toggle. Default `true`. Persisted.

`strokes[]` is unchanged; each stroke already carries enough to compute a centroid
(use the polyline midpoint / average of points).

### Backend changes

- **Exclusions in mask build:** `auto_dust_mask` drops any connected blob that contains
  an excluded seed point. Plumb `autoDustExclusions` into the bake spec and into
  `auto_dust_mask`; include the exclusions hash in the Stage-A cache key.
- **Surface global spots:** extend the `autodust://result` event payload to include the
  **active** (non-excluded) global spot centroids as normalized `{x,y}[]` (reuse the
  connected-component pass already in `count_blobs`, extended to emit centroids). The
  frontend renders exactly what it receives — no client-side exclusion logic.

### Frontend changes

**EraserPanel.svelte:** add a "Show heal spots" checkbox bound to `showSpots`
(dispatches an update like the other controls).

**Viewport.svelte:**

- When `showSpots` is true, render a small eraser-glyph marker at:
  - each manual/AI-fill stroke centroid (from `dust.strokes`), and
  - each global centroid (from the latest `autodust://result` payload, held in a store).
- Markers are small to tolerate dense global detections; the checkbox is the escape
  hatch when there are hundreds.
- **Interaction (hit-test-first):**
  - Tap *near* an existing marker (within a hit radius) → **select** that spot (highlight
    it); do not paint.
  - Tap empty space → paint a new stroke (unchanged behavior).
  - **Double-tap** a marker → remove it immediately.
  - Selected spot + **delete hotkey** → remove it.
- Removal semantics:
  - Manual/AI-fill spot → remove that stroke from `strokes[]`.
  - Global spot → push its centroid into `autoDustExclusions[]`, then re-bake; the spot
    reappears un-healed.
- Track the current selection (e.g. `{ kind: "stroke" | "auto", index/seed }`) in
  component state or a small store; clear on tool change or bake.

**Develop.svelte (delete hotkey):** guard the `nav.delete` handler so that when the
eraser tool is active *and* a spot is selected, it removes the selected spot instead of
deleting the active image. Otherwise the existing image-delete behavior is unchanged.

### Persistence

`save_dust` already serializes `DustEdits`; the two new fields (`autoDustExclusions`,
`showSpots`) ride along. Reopening an image restores kept-dust choices and the toggle.

## Out of scope

- No change to the detector model, MI-GAN model, or Telea algorithm.
- No undo/redo system for individual spot deletes beyond the existing edit flow.
- No per-spot adjustment (radius/strength) — delete only.

## Affected files (reference)

- `app/src-tauri/src/commands.rs` — `working_baked_pixels`, `bake_for_view_from_baked`,
  `auto_dust_mask`, `count_blobs` (→ centroids), `save_dust`, bake-spec struct.
- `app/src-tauri/src/session.rs` — new `autodust_healed` cache.
- `app/src/lib/develop/dust.ts` — `DustEdits` fields, centroid + remove helpers.
- `app/src/lib/develop/EraserPanel.svelte` — "Show heal spots" checkbox.
- `app/src/lib/viewport/Viewport.svelte` — marker rendering, hit-test, select/delete.
- `app/src/lib/tabs/Develop.svelte` — delete-hotkey guard for selected spot.
- `app/src/lib/store.ts` — store for latest global spot centroids + current selection.
