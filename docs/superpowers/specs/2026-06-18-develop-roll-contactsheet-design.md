# Develop section — roll contact-sheet workflow

**Date:** 2026-06-18
**Status:** Approved design, pending implementation plan

## Summary

The new **Develop** section (the button added left of **Tune**) is a roll-level
workflow. It shows every developed frame in the current folder as a **contact
sheet** and lets the user dial in a single roll-wide look — most of Tune's
controls except AI and eraser — then **bulk-write** that look into every frame.
After Develop, the user switches to **Tune** to fine-tune individual frames.

Tune is unchanged: it remains the per-image editor (internal `module` value
`"develop"`). "Develop" and "Tune" are sibling sections; Develop writes the roll
baseline, Tune refines each frame on top.

## Core data model: bulk-write

Develop maintains a **roll draft** — one in-memory set of edit params + crop
geometry + film base + white point (D_max). It is *not* persisted per image
while editing; it only drives the live contact-sheet preview.

- **Live preview**: the contact sheet renders every thumbnail against the roll
  draft. Moving a slider re-renders all thumbnails. Nothing is written yet.
- **Apply to roll** (explicit action): bulk-writes the relevant part of the roll
  draft into every frame's persisted state (`editsById` for tone/color,
  `cropById` for geometry, base/D_max overrides for base/wp).
- **Overwrite confirm**: when an Apply-to-roll would clobber frames that already
  carry non-default edits (e.g. the user came back to Develop after tuning some
  frames in Tune), show a confirm popup first: **Overwrite** / **Cancel**. If the
  user overwrites, all frames take the roll draft; cancel aborts the write.

This is a deliberate one-shot stamp, **not** live inheritance. There is no
roll-level source of truth retained after Apply — each frame ends up with its own
copy of the values, which Tune is then free to override per frame.

### Roll draft seeding

The roll draft seeds from **default params** (a fresh roll look) on entering
Develop, not from any single frame's existing edits.

## Surfaces

### 1. Contact sheet (the Develop view)

- **Grid** of all *developed* frames in the current folder scope. Source:
  developed images within `folderImages` (reuse the existing
  `developedFolderImages`-style derivation). Undeveloped frames are not shown.
- **Slider panels** docked beside the grid, reused from Tune:
  - Basic tone: exposure, black, gamma, contrast, highlights, shadows, whites,
    blacks, texture, vibrance, saturation
  - White balance: temp, tint
  - Tonal Curve (master + R/G/B + region sliders)
  - Color Grading (all regions)
  - Color Mixer — **HSL mixer bands only**; the point-color eyedropper is
    excluded (per-pixel sampling, not roll-wide)
  - White point: a **D_max slider** (live-to-all) plus an optional "pick on
    reference frame" button (see frame view)
  Any slider change updates the roll draft and re-renders all thumbnails live.
- **Apply to roll** button → bulk-write + overwrite-confirm (above).
- **Tap a frame** → opens the full-screen frame view for that frame.

### 2. Full-screen frame view (reference frame)

Opened by tapping a frame. Reuses the existing `Viewport`. Two jobs:

- **Preview**: see one frame large.
- **Reference-based ops** — the operations that need a real image to act on,
  each with its own **Apply to roll** that propagates the *same* result to every
  frame:
  - **Crop / rotation / flips** (reuse `CropView` + `CropPanel`): the user sets
    geometry on this frame; Apply writes the **identical** `CropRect`
    (rect/aspect/orientation/rot90/flipH/flipV/angle) into every frame's
    `cropById`.
  - **Film base** pick (reuse the base sampler): sample base RGB on this frame;
    Apply writes it as the base for every frame.
  - **White point** pick: sample D_max region on this frame; Apply writes that
    D_max to every frame. (Mirrors the contact-sheet D_max slider.)

## Excluded controls

Per "most of Tune except AI and eraser", Develop omits:

- AI Enhance panel (upscale / color-match)
- Eraser panel (brush / IR / AI erase)
- Auto-Dust panel
- Color Mixer point-color eyedropper

These are per-pixel / mask / AI tools that don't make sense applied roll-wide.
They remain available in Tune.

## Contact-sheet export

- A **Export contact sheet** action renders the grid of developed frames into a
  **single image** file (PNG/JPEG via the save dialog).
- Approach: frontend canvas compositor — render each developed frame to a tile
  (reuse the existing `render_view`/thumbnail rendering at a chosen tile size),
  draw the tiles into a grid on a canvas, encode the canvas, and write it out.
- The "append film strip" cosmetic addition is **deferred** — not in this scope.

## Reuse vs. new

**Reused as-is:** all slider panels (Basic, TonalCurve, ColorGrading, ColorMixer
mixer tab), `CropView` / `CropPanel`, `Viewport`, thumbnail / `render_view`
rendering, the existing per-tile export pipeline.

**New:**
- Contact-sheet grid component (the Develop view).
- Roll-draft store + Apply-to-roll logic, including the overwrite-confirm dialog.
- Full-screen frame view wiring (preview + reference ops → apply-to-all).
- Contact-sheet export compositor.
- Develop tab wiring in `+page.svelte` (the button added earlier becomes a real
  section: `module` gains a `"contactsheet"`/roll value, or an equivalent
  routing flag, alongside `"library"` and `"develop"`).

## Design decisions (locked)

- Roll draft seeds from **defaults**, not from a frame's existing edits.
- Crop applies **identical geometry** to all frames.
- **Apply-to-roll is explicit** (a button); live preview stays a non-destructive
  draft until committed.
- Overwrite-confirm fires only when Apply would clobber **non-default** edits on
  one or more frames.

## Out of scope / deferred

- "Append film strip" cosmetic strip on the contact-sheet export.
- Any roll-level live inheritance (we use one-shot bulk-write instead).
- Per-frame crop nudging within Develop (crop is roll-uniform here; per-frame
  crop adjustment stays in Tune).
