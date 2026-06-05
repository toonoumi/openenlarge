# Tone Curve & Color Grading panels

**Date:** 2026-06-04
**Status:** Approved

## Problem

The Develop edit panel only exposes the `Basic` section. We want two new Lightroom-style
sections — **Tone Curve** and **Color Grading** — at full feature parity:

- **Tone Curve:** parametric region sliders (Highlights / Lights / Darks / Shadows), an
  interactive master point curve with a histogram behind it, and separate draggable
  Red / Green / Blue channel curves.
- **Color Grading:** three color wheels (Shadows / Midtones / Highlights) each with
  hue + saturation + a luminance slider, plus global Blending and Balance sliders, and a
  global wheel (the 5-button Adjust row: 3-way / shadows / midtones / highlights / global).

Both ship together in one design.

## Architecture constraints

Finishing runs in **two places that must stay identical**:

1. **GLSL shader** (`app/src/lib/viewport/gl/shaders.ts`) — live viewport preview.
2. **CPU `finish.rs`** (`crates/film-core/src/finish.rs`) — thumbnails + export.

Both consume `FinishParams` (Rust) / finish uniforms (TS) derived from `InvertParams`.
Any new control is added in **both** paths.

## Pipeline order

Matches Lightroom:

```
invert → Basic tone/sat (existing) → Tone Curve → Color Grading → Texture (existing)
```

## Key decision: curves as a baked LUT

Point curves are arbitrary, so we **bake them to a 256-entry LUT** rather than evaluate
splines per pixel. The three tone-curve stages compose into one LUT per channel:

```
lut_c(x) = channelCurve_c( masterCurve( parametric(x) ) )      for c in R, G, B
```

- **JS** builds a `256×1 RGBA` texture and uploads it; the shader does 3 texture lookups.
- **`finish.rs`** builds the identical `[[f32;3]; 256]` table and interpolates linearly.

This keeps GPU/CPU close, keeps the fragment shader cheap, and centralizes curve
interpolation in one shared spot (`curve.ts` + `curve.rs`).

**Interpolation:** monotone cubic (Fritsch–Carlson) so dragging control points never
causes overshoot wiggles. Identity curve = `[[0,0],[1,1]]`.

(Alternative considered: evaluate splines in-shader — rejected; bloats the shader and
risks GPU/CPU drift.)

## Tone Curve

### New params (`InvertParams`, TS + Rust)

- Region (parametric): `tc_highlights`, `tc_lights`, `tc_darks`, `tc_shadows` — each
  −100..100, default 0. Distinct from Basic's Highlights/Shadows.
- Point curves: `tc_curve`, `tc_red`, `tc_green`, `tc_blue` — each `Vec<[f32;2]>` of
  control points in 0..1. Default identity `[[0,0],[1,1]]`.

### Region math

Folded into the master LUT as a smooth parametric adjustment, reusing the region-weight
shape already proven in `finish.rs::tone_curve`, retuned for the four LR zones
(Shadows/Darks lift low end, Lights/Highlights lift high end, each zero at both extremes).

### UI — `TonalCurve.svelte`

Collapsible section (matches `Basic.svelte`), stacked below Basic. Contains:

- "Adjust:" row: Parametric / Master point / R / G / B mode buttons (colored dots).
- `CurveEditor.svelte` square widget: histogram behind (reuse `Histogram` logic),
  the curve line (color follows active channel), draggable control points (click to add,
  drag to move, drag off-canvas to delete).
- Four region sliders (Highlights/Lights/Darks/Shadows), shown in Parametric mode.

## Color Grading

### New params

- Per region (shadows / midtones / highlights / global):
  `cg_{region}_hue` (0..360), `cg_{region}_sat` (0..100), `cg_{region}_lum` (−100..100).
  Defaults 0.
- `cg_blending` (0..100, default 50), `cg_balance` (−100..100, default 0).

### Math (shader + `finish.rs`, per pixel)

1. Compute luma `L`.
2. Derive shadow / mid / highlight tonal weights from `L`; crossover shifted by
   **balance**, overlap width set by **blending**.
3. Each wheel contributes an additive color offset (hue+sat → RGB direction, scaled)
   plus a luminance lift, weighted by its mask. Global applies across all tones.
4. Clamp to [0,1].

### UI — `ColorGrading.svelte`

Collapsible section with an Adjust mode row (3-way / shadows / midtones / highlights /
global) and a reusable `ColorWheel.svelte` (hue-sat disc with draggable thumb +
luminance slider beneath). 3-way layout: midtones on top, shadows + highlights below,
then Blending and Balance sliders.

## Plumbing checklist (per feature)

- `app/src/lib/api.ts` — params + `defaultParams`
- Rust `session.rs` — `InvertParams`
- `commands.rs` — `default_invert_params` + finish mapping
- `finish.rs` — math + tests
- `shaders.ts` GLSL + `uniforms.ts` + `renderer.ts` (LUT texture upload)
- new Svelte components
- wire into `Develop.svelte`

## Testing

- `curve.ts` / `curve.rs`: monotone-cubic unit tests (identity, monotonicity, endpoints).
- `finish.rs`: region / curve / color-grade identity + direction tests (existing style).
- `uniforms.test.ts`: param → uniform / LUT mapping.
- GPU/CPU parity kept tight by shared LUT + shared math constants.

## Out of scope

- Curve presets, eyedropper point-targeting, range-mask color grading.
