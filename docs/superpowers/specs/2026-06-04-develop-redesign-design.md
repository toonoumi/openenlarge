# Develop Tab Redesign — Design

**Date:** 2026-06-04
**Branch:** `feat/develop-redesign`
**Status:** Approved, ready for implementation planning

## Goal

Redesign the Develop tab's UI and feature set toward a Lightroom-like editing
experience: a color histogram, a tool toolbar, a refactored compact Basic edit
panel with a full Tone/Presence control set wired into the engine, real
Kelvin-based white balance, and a full interactive crop tool.

Two implementation plans:

- **Plan 1 — Panels & Basic edit** (sections A–F): layout, histogram, toolbar,
  Basic panel, full engine expansion, Kelvin WB. A complete verifiable checkpoint.
- **Plan 2 — Crop tool** (section G): the interactive crop overlay + backend
  geometry. Gets its own detailed plan when we start it; captured here at
  requirements/architecture level.

## Resolved decisions

- Tone/Presence controls are **wired to real image processing now** (full engine
  expansion), not UI-only placeholders.
- Temp/Tint use a **real Kelvin mapping** (CCT → RGB gains), not a relabel.
- Histogram is computed **on the frontend** from the rendered preview.
- **Exposure becomes EV stops** (−5..+5, default 0), converted to a multiplier
  (`2^ev`) in the backend.
- **Mode and Film stock move into the Edit → White Balance group.**
- Eraser and Brush tools appear in the toolbar but are non-functional (no-op)
  for now.

## Current state (what exists today)

- `app/src/lib/tabs/Develop.svelte`: grid `220px 1fr 260px` with an **empty**
  `left` aside, center `Viewport`, right `Adjustments`, bottom `Filmstrip`.
- `app/src/lib/panels/Adjustments.svelte`: Mode (B/C), Film stock, Auto-WB
  checkbox, Temp/Tint/Exposure/Black/Gamma sliders, Export button.
- `app/src/lib/api.ts` `InvertParams`: `mode, stock, base_rect, exposure, black,
  gamma, auto_wb, temp, tint`. Mirrored in `app/src-tauri/src/session.rs`.
- Engine `film-core/src/engine.rs`: `invert_b/invert_c` per pixel →
  `tone(v, gain, p)` = `(v*exposure*gain − black)^gamma`. `wb` is a per-channel
  gain. `params_for_stock` fits `m_post` for Mode B.
- `app/src-tauri/src/commands.rs`: `wb_from_temp_tint(temp,tint)` (−1..1 → gains);
  `resolve_params` multiplies manual WB by gray-world `auto_wb_gains` when
  `auto_wb` is on. `render_view` does a view-crop (zoom/pan visible region) +
  `resize_to` + invert. `export_image` re-decodes full-res + invert.
- `app/src/lib/icons/Icon.svelte`: inline SVG path registry (Lucide-style).
- 27 film-core tests, 13 app-backend tests, 8 vitest — all green; must stay green.

---

## A. Layout — `Develop.svelte`

Remove the empty `left` aside. Grid becomes:

```
grid-template-columns: 1fr 300px;
grid-template-rows: 1fr 88px;
grid-template-areas: "center right" "bottom bottom";
```

Right panel (`Adjustments` is replaced by a new container) stacks top→bottom:
**Histogram → Toolbar → Tool content (Edit panel or Crop panel) → Export footer.**
The center `Viewport` and bottom `Filmstrip` are unchanged (except Viewport gains
a `previewSrc` publish and a crop-mode flag in Plan 2).

## B. Histogram — `viewport/Histogram.svelte` (frontend)

- Viewport renders the **whole image** to a data-URL JPEG each render. Add a
  `previewSrc` writable store (in `store.ts`); Viewport sets it after each
  successful `render()`.
- Histogram subscribes to `previewSrc`. On change (debounced ~120 ms): load the
  data URL into an `Image`, draw to a 256-wide offscreen `<canvas>` (height scaled
  to aspect), `getImageData`, bin R/G/B into 256 buckets each.
- Paint three screen-blended (`mix-blend-mode: screen` or additive) filled curves
  on a ~80 px-tall canvas. Data URLs don't taint the canvas, so `getImageData`
  works.
- Reflects the developed positive exactly (it *is* the preview). Approximate
  (preview-resolution, JPEG-quantized) — acceptable for a histogram.

## C. Toolbar — `develop/Toolbar.svelte`

- Horizontal icon row: **Edit** (sliders glyph), **Crop**, **Eraser**, **Brush**.
  New glyphs added to `Icon.svelte`: `sliders`, `crop`, `eraser`, `brush`, plus
  `rotate-cw` (for crop cursor) and reuse existing `chevron-down/right`.
- A `tool` store: `"edit" | "crop" | "eraser" | "brush"`, default `"edit"`.
- Active tool is highlighted. Edit & Crop switch the tool content below.
  **Eraser & Brush are rendered but disabled** (no-op, "coming soon" title).

## D. Basic panel (Edit tool) — `develop/Basic.svelte` + `develop/Slider.svelte`

### Reusable `Slider.svelte`
Props: `label`, `min`, `max`, `step`, `value` (bind), `default`, `format?`
(value → string), `gradient?` (CSS background string for the track).
- Thin track, small handle, label left, right-aligned numeric value.
- **Double-click resets to `default`.**
- Compact vertical rhythm — replaces the current bulky `input[type=range]` rows.

### "Basic" collapsible section
Header "Basic" with a chevron; collapses the body. (Other sections will be added
later — leave the structure extensible.) Three subsections:

1. **White Balance**
   - Mode (B · density / C · per-channel) segmented control + Film stock `<select>`
     (moved here from the old panel).
   - **Temp** slider, track gradient **blue → yellow**, value shown as Kelvin
     (e.g. `8400`).
   - **Tint** slider, track gradient **green → magenta**, value shown signed
     (e.g. `-61`).
   - **Auto / As-Shot** button (replaces the bare checkbox): re-seeds Temp/Tint
     from the estimated as-shot white point (see F).
2. **Tone:** Exposure (EV), Contrast, Highlights, Shadows, Whites, Blacks.
3. **Presence:** Texture, Vibrance, Saturation. Vibrance & Saturation tracks get a
   **gray → spectrum** gradient.

### Slider ranges / defaults (UI units)
- Exposure: −5..+5 EV, step 0.05, default 0.
- Contrast, Highlights, Shadows, Whites, Blacks: −100..+100, step 1, default 0.
- Texture, Vibrance, Saturation: −100..+100, step 1, default 0.
- Temp: 2000..50000 K, step 50, default = as-shot estimate.
- Tint: −150..+150, step 1, default = as-shot estimate.

## E. Engine expansion — `film-core`

Keep the inversion core intact (preserves the 27 tests). The internal `black`
stays 0 and `gamma` stays the sRGB-ish encoding exponent; they are no longer
exposed in the UI. Creative controls become a **new finishing layer**.

### New `film-core/src/finish.rs`
```rust
pub struct FinishParams {
    pub contrast: f32,    // −1..1 (UI −100..100 / 100)
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub texture: f32,
    pub vibrance: f32,
    pub saturation: f32,
}
// Default = all 0.0 → identity.

pub fn finish_image(img: &Image, p: &FinishParams) -> Image;
```

`finish_image` operates on the display-gamma-encoded positive produced by
inversion:
1. **Per-pixel tone curve** (per channel, in [0,1] perceptual space), composed in
   order: whites/blacks (endpoint slide) → highlights/shadows (smooth
   region-weighted lift/pull) → contrast (S-curve about mid-gray 0.5).
2. **Per-pixel vibrance/saturation:** compute luma `Y`; push each channel away
   from `Y`. Saturation scales chroma uniformly; vibrance scales chroma weighted
   by `(1 − currentSat)` so already-saturated pixels move less.
3. **Texture** (only when `texture ≠ 0`): a Gaussian-blur high-pass
   (unsharp-mask) pass over the whole image — `out = v + amount·(v − blur(v))`.
   This is the one spatial operation; implemented as a separable Gaussian.

### Wiring (`commands.rs`)
- Build `FinishParams` from the (extended) `InvertParams` and call `finish_image`
  immediately after `invert_image` in `render_view`, `thumbnail`, and
  `export_image`.
- Exposure: UI sends **EV**; `build_params` converts `exposure: 2f32.powf(ev)`.
  Update `default_invert_params` (exposure 1.0 → 0.0) and TS `defaultParams`.

### Params plumbing
Extend the UI contract in three places (keep names aligned):
- `app/src/lib/api.ts` `InvertParams` + `defaultParams`.
- `app/src-tauri/src/session.rs` `InvertParams`.
- `app/src-tauri/src/commands.rs` build/resolve.
New fields: `contrast, highlights, shadows, whites, blacks, texture, vibrance,
saturation` (all default 0); `exposure` reinterpreted as EV.

### New tests
- Each finishing control is **identity at 0** (output == input image).
- Direction checks: +contrast widens histogram spread; +saturation increases mean
  chroma; +whites raises the brightest pixels; +blacks lowers the darkest;
  +texture raises local variance on a test pattern; vibrance < saturation effect
  on an already-saturated pixel.

## F. Real Kelvin WB — `film-core` + `commands.rs`

- Replace `wb_from_temp_tint` with `wb_from_kelvin(temp_k, tint)`:
  CCT → Planckian-locus xy (approx) → XYZ → linear sRGB → per-channel gains,
  normalized so a neutral reference (~5500 K, tint 0) yields ≈ `[1,1,1]`. `tint`
  offsets along the green↔magenta axis.
- Auto-WB **seeds** the sliders instead of multiplying into the result:
  - New command `as_shot_wb(id) -> { temp_k, tint }`: compute gray-world
    `auto_wb_gains` on the developed image, convert gains → CCT/tint via a
    `gains_to_cct` approximation.
  - The UI loads these into Temp/Tint when an image becomes active (and on the
    **Auto/As-Shot** button). After seeding, Temp/Tint are **absolute** and drive
    gains directly — no manual×auto stacking.
- Tests: `wb_from_kelvin(5500, 0) ≈ [1,1,1]`; lower K → warmer (R↑/B↓), higher K →
  cooler; `gains_to_cct(wb_from_kelvin(k,0)) ≈ k` round-trip within tolerance.

## G. Crop tool — **Plan 2** (architecture / requirements)

Detailed interaction design is finalized when Plan 2 starts; requirements captured
here.

### Components
- `crop/CropOverlay.svelte`: drawn over the Viewport when `tool === "crop"`. Forces
  Fit, disables Viewport zoom/pan, shows the **full uncropped image**, dims the
  area outside the crop rect, draws rule-of-thirds guides and brackets at the 4
  corners + 4 edge midpoints.
- `crop/CropPanel.svelte`: aspect dropdown, orientation toggle, rotate slider,
  reset, done.

### State
`{ rect (normalized x,y,w,h in the rotated frame), angle (deg), aspect (ratio | null
for Original/freeform), orientation (portrait | landscape) }`. Default rect = 80%
of the image, centered; aspect = Original.

### Interactions
- Hover **inside** box → hand cursor → drag moves the rect (clamped to image).
- Hover on a **bracket** → resize cursor → drag resizes. **Shift** locks aspect.
- Hover just **outside a corner** → rotate cursor → drag rotates (straighten).
- **Rotate slider** −45..+45 in the panel.
- **Aspect dropdown:** Original (default), 1×1, 4×5/8×10, 8.5×11, 5×7, 2×3/4×6,
  4×4, 16×9, 16×10. The active ratio name is shown.
- **Orientation:** toggle button + the **`x`** key swaps the ratio (portrait ↔
  landscape).
- **Commit:** leaving crop mode (selecting another tool) **or** pressing **Enter**.
- **Discard:** **Esc** reverts to the last committed crop.

### Persistence / backend
- Crop `rect` + `angle` are added to the params contract (TS + Rust). Backend
  `render_view`/`export_image` **rotate-then-crop** the working/full image before
  inversion (geometry is color-independent; base was sampled at develop time).
- The committed cropped dimensions become Viewport's `imgW/imgH` so zoom/pan
  operate within the cropped frame. Angle/crop geometry math lives in a shared
  helper (frontend computes cropped dims; backend resamples).

---

## Out of scope (this redesign)

- Eraser/Brush behavior (icons only).
- Eyedropper white-balance picker (button may be stubbed; not implemented).
- File/edit persistence (already deferred project-wide).
- Additional Edit sections beyond "Basic" (structure left extensible).
