# Eraser Marquee Zoom — Design

**Date:** 2026-06-17
**Status:** Approved (pending spec review)

## Problem

In eraser mode the viewport deliberately repurposes the usual zoom/pan gestures:
the mouse wheel resizes the brush and a drag paints a heal stroke. As a result the
user cannot zoom into a region to erase dust precisely. We want a way to zoom into
an arbitrary rectangle and a way to get back out, without disturbing the brush
gestures.

## Interaction

A single button in the EraserPanel toolbar swaps identity based on zoom state:

- **At fit (not zoomed):** button reads **"Zoom to area"**. Tapping it *arms*
  marquee mode (button shows an active/highlighted state).
- **Armed:** the next press-drag on the image draws a rectangle (painting is
  blocked while armed). On release the viewport animates to fit that rectangle and
  the tool auto-returns to painting (`marquee` disarmed).
- **A too-small drag** (below a pixel threshold) cancels without zooming and stays
  armed, so an accidental click does not zoom to a sliver.
- **Once zoomed:** the same button slot reads **"Reset view"**. Tapping it animates
  back to fit; the button reverts to "Zoom to area".

The user's loop is therefore: *zoom → erase → reset → zoom another area*.

## Components

### `Viewport.svelte` (owns zoom state)

`scale`, `cx`, `cy` already live here, so the actual zoom math stays here.

- **New prop:** `export let marquee = false;` — armed flag, parent-controlled.
- **New state:** marquee rectangle start + current point, in image coords (captured
  via the existing `imgPoint(e)` helper).
- **Pointer handling** when `eraser && marquee` (takes precedence over painting):
  - `onDown`: record rect start, begin marquee drag, `setPointerCapture`.
  - `onMove`: update current point; render a marquee rectangle overlay.
  - `onUp`: if the rect is larger than the threshold, compute and apply the zoom;
    otherwise cancel. Either way end the marquee drag.
- **Zoom math:** with the rect in image-space width `rw`/height `rh` and center
  `(rcx, rcy)`:
  - `scale = clamp(min(avW / rw, avH / rh), fit, 8)`
  - `cx = rcx; cy = rcy; clampCenter(); startAnim();`
- **Overlay:** a positioned `<div class="marquee">` (or SVG rect) in screen coords,
  reusing the brush-overlay positioning pattern. Shown only while dragging the rect.
- **Events dispatched:**
  - `zoomchange` (boolean `zoomed`) — fired whenever the `zoomed` derived value
    flips, so the parent can swap the button label.
  - `marqueedone` — fired after a successful marquee zoom so the parent disarms.
- **Exported function:** `export function resetZoom()` — animates back to fit
  (`scale = fit; cx = imgW/2; cy = imgH/2; startAnim()`) and clears any armed
  marquee. Called by the parent via `bind:this`.
- **Untouched:** non-eraser tap-to-zoom, wheel-zoom, wheel-brush-resize, and stroke
  painting when not armed.

### `Develop.svelte` (coordinator)

- New state: `let zoomMarquee = false;` (armed) and `let viewZoomed = false;`.
- `bind:this={vp}` on the Viewport.
- Pass `marquee={zoomMarquee}`; wire `on:zoomchange={(e) => (viewZoomed = e.detail)}`
  and `on:marqueedone={() => (zoomMarquee = false)}`.
- Pass `zoomed={viewZoomed}` and `marqueeArmed={zoomMarquee}` to `EraserPanel`.
- EraserPanel events: `on:zoomArea={() => (zoomMarquee = true)}` and
  `on:resetView={() => { vp.resetZoom(); zoomMarquee = false; }}`.

### `EraserPanel.svelte` (UI)

- New props: `export let zoomed = false;` and `export let marqueeArmed = false;`.
- New dispatch events: `zoomArea` and `resetView`.
- A single button rendered below the brush-size controls:
  - When `!zoomed`: label `eraser.zoomArea`, `class:active={marqueeArmed}`,
    `on:click` dispatches `zoomArea`.
  - When `zoomed`: label `eraser.resetView`, `on:click` dispatches `resetView`.
- A short hint line (`eraser.marqueeHint`) explaining the draw-a-rectangle action,
  shown while armed.

## i18n

New keys added to `/i18n-strings.csv` (file column `src/lib/develop/EraserPanel.svelte`),
then regenerated with `python3 scripts/gen-i18n.py`. `dict.ts` is never edited by hand.

- `eraser.zoomArea` — "Zoom to area"
- `eraser.resetView` — "Reset view"
- `eraser.marqueeHint` — "Drag a rectangle on the image to zoom in."

(Chinese translations supplied in the CSV.)

## Out of scope

- No backend changes. Strokes remain normalized to image space, so they stay
  correct at any zoom.
- No pan affordance inside the zoomed view (the marquee + reset loop replaces it).
- Non-eraser tools are unaffected.

## Testing

- Manual: arm → drag a rect → confirm zoom fits the rect and painting resumes;
  confirm button swaps to "Reset view"; reset returns to fit and button swaps back.
- Confirm a tiny click while armed does not zoom.
- Confirm existing brush-resize (wheel) and stroke painting still work when not armed.
- Confirm the marquee rectangle maps correctly under crop/rotation (uses the same
  `imgPoint` mapping as painting).
