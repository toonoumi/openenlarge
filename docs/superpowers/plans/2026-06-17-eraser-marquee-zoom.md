# Eraser Marquee Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user zoom into a drawn rectangle while in eraser mode (where wheel/drag are taken by brush/paint), with a single toolbar button that swaps between "Zoom to area" and "Reset view".

**Architecture:** A pure module computes the target zoom (scale + center) from a marquee rectangle. `Viewport.svelte` owns zoom state, so it captures the rectangle when armed, applies the computed zoom, and exposes `resetZoom()` + `zoomchange`/`marqueedone` events. `Develop.svelte` coordinates the armed flag and zoom state between the Viewport and a new swapping button in `EraserPanel.svelte`. UI strings flow through the CSV → `gen-i18n.py` pipeline.

**Tech Stack:** Svelte 5 (Tauri 2 app under `app/`), TypeScript, Vitest for pure-logic tests, Python i18n generator.

## Global Constraints

- Work directly on `main` (no feature branch).
- Never edit `app/src/lib/i18n/dict.ts` by hand — edit `/i18n-strings.csv` (columns `key,en,zh,file,note`) and run `python3 scripts/gen-i18n.py` from the repo root.
- All commands below run from the repo root `/Users/mohaelder/Repos/filmrev` unless noted; frontend npm scripts run from `app/`.
- No backend (Rust) changes. Strokes stay normalized to image space.
- Follow existing Viewport coordinate conventions: `imgPoint(e)` maps a pointer event to image-space pixels; `eff` is display-px-per-image-px; `avW`/`avH` are the padded available viewport size; `fit` is the fit-to-view scale; max zoom is `8`.

---

### Task 1: Pure marquee→zoom math module

**Files:**
- Create: `app/src/lib/viewport/marquee.ts`
- Test: `app/src/lib/viewport/marquee.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `marqueeZoom(ax: number, ay: number, bx: number, by: number, avW: number, avH: number, fit: number, max?: number): { scale: number; cx: number; cy: number }` — given two image-space corner points and the padded viewport size, returns the zoom scale (clamped to `[fit, max]`, default `max=8`) and the image-space center of the rectangle.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/viewport/marquee.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { marqueeZoom } from "./marquee";

describe("marqueeZoom", () => {
  it("centers on the rectangle midpoint regardless of corner order", () => {
    const a = marqueeZoom(100, 200, 300, 400, 1000, 1000, 0.5);
    expect(a.cx).toBe(200);
    expect(a.cy).toBe(300);
    const b = marqueeZoom(300, 400, 100, 200, 1000, 1000, 0.5);
    expect(b.cx).toBe(200);
    expect(b.cy).toBe(300);
  });

  it("scales so the limiting rectangle dimension fills the viewport", () => {
    // rect 200 wide x 100 tall, viewport 1000x1000 → width is limiting: 1000/200 = 5
    const z = marqueeZoom(0, 0, 200, 100, 1000, 1000, 0.5);
    expect(z.scale).toBeCloseTo(5);
  });

  it("never zooms below fit", () => {
    // huge rect would imply scale < fit; clamp up to fit
    const z = marqueeZoom(0, 0, 5000, 5000, 1000, 1000, 0.5);
    expect(z.scale).toBeCloseTo(0.5);
  });

  it("never zooms beyond max", () => {
    // tiny rect would imply enormous scale; clamp to max
    const z = marqueeZoom(0, 0, 2, 2, 1000, 1000, 0.5, 8);
    expect(z.scale).toBe(8);
  });

  it("treats a zero-area rectangle as max zoom without dividing by zero", () => {
    const z = marqueeZoom(50, 50, 50, 50, 1000, 1000, 0.5, 8);
    expect(z.scale).toBe(8);
    expect(z.cx).toBe(50);
    expect(z.cy).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/viewport/marquee.test.ts`
Expected: FAIL — cannot resolve `./marquee` / `marqueeZoom is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/viewport/marquee.ts`:

```ts
/**
 * Compute the zoom needed to fit a marquee rectangle (two image-space corner
 * points) into the padded viewport.
 *
 * @param ax,ay  first corner, image-space px
 * @param bx,by  second corner, image-space px (any order vs the first)
 * @param avW,avH  padded available viewport size, display px
 * @param fit  fit-to-view scale (lower clamp)
 * @param max  maximum zoom scale (upper clamp), default 8
 * @returns scale (display px per image px) and the rectangle's image-space center
 */
export function marqueeZoom(
  ax: number, ay: number, bx: number, by: number,
  avW: number, avH: number, fit: number, max = 8,
): { scale: number; cx: number; cy: number } {
  const rw = Math.max(1e-6, Math.abs(bx - ax));
  const rh = Math.max(1e-6, Math.abs(by - ay));
  const want = Math.min(avW / rw, avH / rh);
  const scale = Math.min(max, Math.max(fit, want));
  return { scale, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/viewport/marquee.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/marquee.ts app/src/lib/viewport/marquee.test.ts
git commit -m "feat(viewport): pure marquee-zoom math + tests"
```

---

### Task 2: Viewport marquee capture, overlay, and zoom controls

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte`

**Interfaces:**
- Consumes: `marqueeZoom` from `./marquee` (Task 1).
- Produces (for `Develop.svelte` in Task 3):
  - New prop `export let marquee = false;` — armed flag.
  - Dispatched event `zoomchange` with `detail: boolean` (current `zoomed` state).
  - Dispatched event `marqueedone` with no detail (fired after a marquee zoom is applied).
  - Exported function `resetZoom(): void` — callable via `bind:this`.

- [ ] **Step 1: Import the math helper**

In `app/src/lib/viewport/Viewport.svelte`, find the existing dust import (line ~10):

```ts
  import { screenRadius, type DustStroke } from "../develop/dust";
```

Add immediately below it:

```ts
  import { marqueeZoom } from "./marquee";
```

- [ ] **Step 2: Add the `marquee` prop**

Find the existing `eraser` prop (line ~26):

```ts
  export let eraser = false;
```

Add directly below it:

```ts
  /** Marquee-zoom armed: the next drag draws a zoom rectangle instead of painting. */
  export let marquee = false;
```

- [ ] **Step 3: Extend the dispatcher type**

Find the dispatcher declaration (line ~44):

```ts
  const dispatch = createEventDispatcher<{ stroke: DustStroke; brush: number; pointpick: { r: number; g: number; b: number; u: number; v: number }; aierased: void; autodusted: void }>();
```

Replace it with (adds `zoomchange` and `marqueedone`):

```ts
  const dispatch = createEventDispatcher<{ stroke: DustStroke; brush: number; pointpick: { r: number; g: number; b: number; u: number; v: number }; aierased: void; autodusted: void; zoomchange: boolean; marqueedone: void }>();
```

- [ ] **Step 4: Add marquee drag state**

Find the eraser cursor state (line ~398-401):

```ts
  // Eraser: live cursor position (element coords) + the in-progress stroke (normalized).
  let curX = -100, curY = -100, hovering = false;
  let painting = false;
  let pending: { x: number; y: number }[] = [];
```

Add directly below the `pending` line:

```ts
  // Marquee zoom: drag-in-progress flag, start corner in element coords (for drawing)
  // and image coords (for the zoom math), and the live corner in element coords.
  let mqActive = false;
  let mqSX = 0, mqSY = 0;
  let mqStartImg: [number, number] = [0, 0];
  let mqCX = 0, mqCY = 0;
```

- [ ] **Step 5: Add the `zoomchange` notifier and `resetZoom` export**

Find `startAnim` (line ~368). Directly above it, insert:

```ts
  // Notify the parent whenever the zoom state flips so it can swap the toolbar button.
  let prevZoomed = false;
  $: if (zoomed !== prevZoomed) { prevZoomed = zoomed; dispatch("zoomchange", zoomed); }

  /** Animate back to fit-to-view. Called by the parent via bind:this. */
  export function resetZoom() {
    startAnim();
    scale = fit; cx = imgW / 2; cy = imgH / 2;
  }
```

- [ ] **Step 6: Branch the pointer handlers for marquee mode**

In `onDown` (line ~447), find the eraser branch:

```ts
    if (eraser) {
      painting = true;
      pending = [normPoint(e)];
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
```

Replace it with (marquee branch takes precedence, blocking painting while armed):

```ts
    if (eraser && marquee) {
      const rect = el.getBoundingClientRect();
      mqActive = true;
      mqSX = mqCX = e.clientX - rect.left;
      mqSY = mqCY = e.clientY - rect.top;
      mqStartImg = imgPoint(e);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (eraser) {
      painting = true;
      pending = [normPoint(e)];
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
```

In `onMove` (line ~458), find:

```ts
    if (!interactive) return;
    if (eraser) { onEraserMove(e); return; }
```

Replace with:

```ts
    if (!interactive) return;
    if (eraser && marquee) {
      if (mqActive) {
        const rect = el.getBoundingClientRect();
        mqCX = e.clientX - rect.left;
        mqCY = e.clientY - rect.top;
      }
      return;
    }
    if (eraser) { onEraserMove(e); return; }
```

In `onUp` (line ~470), find:

```ts
    if (eraser) {
      if (painting && pending.length > 0) dispatch("stroke", { points: pending, r: brush });
      painting = false; pending = [];
      return;
    }
```

Replace with (marquee branch first; <8px drag cancels without zooming):

```ts
    if (eraser && marquee) {
      if (mqActive) {
        const dist = Math.hypot(mqCX - mqSX, mqCY - mqSY);
        if (dist >= 8) {
          const [bx, by] = imgPoint(e);
          const z = marqueeZoom(mqStartImg[0], mqStartImg[1], bx, by, avW, avH, fit, 8);
          startAnim();
          scale = z.scale; cx = z.cx; cy = z.cy;
          clampCenter();
          dispatch("marqueedone");
        }
        mqActive = false;
      }
      return;
    }
    if (eraser) {
      if (painting && pending.length > 0) dispatch("stroke", { points: pending, r: brush });
      painting = false; pending = [];
      return;
    }
```

- [ ] **Step 7: Cancel marquee on leave/cancel**

Find `onLeave` and `onCancel` (lines ~426 and ~486):

```ts
  function onLeave() { hovering = false; painting = false; pending = []; }
```

Replace with:

```ts
  function onLeave() { hovering = false; painting = false; pending = []; mqActive = false; }
```

And:

```ts
  function onCancel() { painting = false; pending = []; panning = false; moved = false; }
```

Replace with:

```ts
  function onCancel() { painting = false; pending = []; panning = false; moved = false; mqActive = false; }
```

- [ ] **Step 8: Render the marquee rectangle and a crosshair cursor; hide the brush ring while armed**

Find the root element opening tag (line ~489-490):

```svelte
<div
  class="vp" class:interactive class:zoomed class:erasing={eraser} class:picking={pointPick}
```

Replace with (adds `marqueearm` class):

```svelte
<div
  class="vp" class:interactive class:zoomed class:erasing={eraser} class:picking={pointPick} class:marqueearm={eraser && marquee}
```

Find the brush cursor block (line ~528-530):

```svelte
  {#if eraser && hovering}
    <div class="brush" style="left:{curX}px; top:{curY}px; width:{cursorR * 2}px; height:{cursorR * 2}px;"></div>
  {/if}
```

Replace with (hide ring while armed, add marquee rect):

```svelte
  {#if eraser && hovering && !marquee}
    <div class="brush" style="left:{curX}px; top:{curY}px; width:{cursorR * 2}px; height:{cursorR * 2}px;"></div>
  {/if}
  {#if eraser && marquee && mqActive}
    <div class="marquee" style="left:{Math.min(mqSX, mqCX)}px; top:{Math.min(mqSY, mqCY)}px; width:{Math.abs(mqCX - mqSX)}px; height:{Math.abs(mqCY - mqSY)}px;"></div>
  {/if}
```

- [ ] **Step 9: Add the marquee CSS**

Find the `.brush` style rule in the `<style>` block (search for `.brush {`). Immediately after that rule, add:

```css
  .vp.marqueearm { cursor: crosshair; }
  .marquee { position: absolute; z-index: 5; pointer-events: none;
    border: 1px solid #fff; background: rgba(244,157,78,0.15);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.4); }
```

- [ ] **Step 10: Type-check the Viewport changes**

Run: `cd app && npm run check`
Expected: completes with no new errors referencing `Viewport.svelte`, `marquee`, `resetZoom`, `zoomchange`, or `marqueedone`. (Pre-existing warnings elsewhere are acceptable; verify none are newly introduced by this file.)

- [ ] **Step 11: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(viewport): marquee-zoom capture, overlay, reset, and zoom events"
```

---

### Task 3: i18n strings, EraserPanel button, and Develop wiring (end-to-end)

**Files:**
- Modify: `i18n-strings.csv`
- Generated: `app/src/lib/i18n/dict.ts` (via `scripts/gen-i18n.py` — do not hand-edit)
- Modify: `app/src/lib/develop/EraserPanel.svelte`
- Modify: `app/src/lib/tabs/Develop.svelte`

**Interfaces:**
- Consumes (from Task 2): Viewport prop `marquee`, events `zoomchange`/`marqueedone`, exported `resetZoom()`.
- Produces: new i18n keys `eraser.zoomArea`, `eraser.resetView`, `eraser.marqueeHint`; `EraserPanel` props `zoomed` and `marqueeArmed`; `EraserPanel` events `zoomArea` and `resetView`.

- [ ] **Step 1: Add the i18n rows**

Append these three lines to the end of `/i18n-strings.csv` (after the last row):

```csv
eraser.zoomArea,"Zoom to area","缩放到区域","src/lib/develop/EraserPanel.svelte","button"
eraser.resetView,"Reset view","重置视图","src/lib/develop/EraserPanel.svelte","button"
eraser.marqueeHint,"Drag a rectangle on the image to zoom in.","在图像上拖动矩形以放大。","src/lib/develop/EraserPanel.svelte","hint"
```

- [ ] **Step 2: Regenerate the dictionary**

Run: `python3 scripts/gen-i18n.py`
Expected: rewrites `app/src/lib/i18n/dict.ts`. Verify the keys landed:

Run: `grep -n "eraser.zoomArea\|eraser.resetView\|eraser.marqueeHint" app/src/lib/i18n/dict.ts`
Expected: 6 matches (en + zh for each of the 3 keys).

- [ ] **Step 3: Add props and events to EraserPanel**

In `app/src/lib/develop/EraserPanel.svelte`, find the `aiBusy` prop (line ~22):

```ts
  export let aiBusy = false;
```

Add directly below it:

```ts
  /** Whether the viewport is currently magnified (drives the button label). */
  export let zoomed = false;
  /** Whether marquee-zoom is armed (highlights the button). */
  export let marqueeArmed = false;
```

Find the dispatcher declaration (line ~24-26):

```ts
  const dispatch = createEventDispatcher<{
    reset: void; irEnabled: boolean; irSensitivity: number; brushMigan: boolean; aiErase: void;
  }>();
```

Replace with:

```ts
  const dispatch = createEventDispatcher<{
    reset: void; irEnabled: boolean; irSensitivity: number; brushMigan: boolean; aiErase: void;
    zoomArea: void; resetView: void;
  }>();
```

- [ ] **Step 4: Add the swapping button to the EraserPanel markup**

In `app/src/lib/develop/EraserPanel.svelte`, find the brush-size slider block (line ~53-57):

```svelte
  <div class="sub">{$t('eraser.brushSize')}</div>
  <div class="slrow">
    <input type="range" min="0.005" max="0.2" step="0.001" bind:value={brush} bind:this={brushEl} />
    <span class="val" use:scrubValue={{ input: brushEl }}>{(brush * 100).toFixed(1)}%</span>
  </div>
```

Directly below that block, insert:

```svelte
  {#if zoomed}
    <button class="row" on:click={() => dispatch("resetView")}>{$t('eraser.resetView')}</button>
  {:else}
    <button class="row zoombtn" class:active={marqueeArmed} aria-pressed={marqueeArmed}
            on:click={() => dispatch("zoomArea")}>{$t('eraser.zoomArea')}</button>
    {#if marqueeArmed}<div class="hint">{$t('eraser.marqueeHint')}</div>{/if}
  {/if}
```

- [ ] **Step 5: Add the active-state style for the zoom button**

In `app/src/lib/develop/EraserPanel.svelte`, find the `.row` style rule (line ~106-108):

```css
  .row { width: 100%; display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; margin: 6px 0; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
```

Directly after it, add:

```css
  .zoombtn { justify-content: center; }
  .zoombtn.active { background: rgba(244,157,78,0.18); border-color: rgba(244,157,78,0.5); }
```

- [ ] **Step 6: Wire Develop state and the Viewport binding**

In `app/src/lib/tabs/Develop.svelte`, locate the `<script>` block where local develop UI state is declared (near the existing `let brush`, `let aiBusy`, `let autoBusy` declarations — search for `let brush`). Add these two state variables alongside them:

```ts
  let zoomMarquee = false; // eraser marquee-zoom armed
  let viewZoomed = false;  // eraser viewport currently magnified
  let vp: import("$lib/viewport/Viewport.svelte").default; // Viewport instance for resetZoom()
```

- [ ] **Step 7: Pass the new prop, bind the instance, and wire the Viewport events**

In `app/src/lib/tabs/Develop.svelte`, find the Viewport tag (lines ~351-360). Update its opening line (line ~351) from:

```svelte
        <Viewport id={$activeId} params={effParams} imgW={effW} imgH={effH} imageCrop={imageCrop}
```

to (add `bind:this`):

```svelte
        <Viewport bind:this={vp} id={$activeId} params={effParams} imgW={effW} imgH={effH} imageCrop={imageCrop}
```

Find the `eraser={$tool === "eraser"} {brush}` line (line ~353):

```svelte
                  eraser={$tool === "eraser"} {brush} dust={dust.strokes} irRemoval={dust.irRemoval} dustRev={$dustRev} developRev={$developRev}
```

Replace with (adds `marquee`):

```svelte
                  eraser={$tool === "eraser"} marquee={zoomMarquee} {brush} dust={dust.strokes} irRemoval={dust.irRemoval} dustRev={$dustRev} developRev={$developRev}
```

Find the event handlers block (lines ~357-360):

```svelte
                  on:stroke={(e) => commitStroke(e.detail)} on:brush={(e) => (brush = e.detail)}
                  on:aierased={() => (aiBusy = false)}
                  on:autodusted={() => (autoBusy = false)}
                  on:pointpick={onPointPick} />
```

Replace with (adds `zoomchange`/`marqueedone`):

```svelte
                  on:stroke={(e) => commitStroke(e.detail)} on:brush={(e) => (brush = e.detail)}
                  on:aierased={() => (aiBusy = false)}
                  on:autodusted={() => (autoBusy = false)}
                  on:zoomchange={(e) => (viewZoomed = e.detail)}
                  on:marqueedone={() => (zoomMarquee = false)}
                  on:pointpick={onPointPick} />
```

- [ ] **Step 8: Pass state to EraserPanel and handle its new events**

In `app/src/lib/tabs/Develop.svelte`, find the `<EraserPanel ...>` tag (lines ~387-395). Update the props line (line ~387) from:

```svelte
            <EraserPanel bind:brush {hasIr}
```

to (adds the two new props):

```svelte
            <EraserPanel bind:brush {hasIr} zoomed={viewZoomed} marqueeArmed={zoomMarquee}
```

Then find the closing handler `on:aiErase={aiErase} />` (line ~395):

```svelte
                         on:aiErase={aiErase} />
```

Replace with (adds the two new event handlers):

```svelte
                         on:aiErase={aiErase}
                         on:zoomArea={() => (zoomMarquee = true)}
                         on:resetView={() => { vp?.resetZoom(); zoomMarquee = false; }} />
```

- [ ] **Step 9: Type-check the wiring**

Run: `cd app && npm run check`
Expected: no new errors referencing `EraserPanel.svelte`, `Develop.svelte`, `zoomMarquee`, `viewZoomed`, `vp`, `zoomArea`, `resetView`, or the new i18n keys.

- [ ] **Step 10: Manual end-to-end verification**

Run: `cd app && npm run tauri dev`
Then in the app, open an image into Develop and switch to the Eraser tool. Verify each:
1. The toolbar shows a **"Zoom to area"** button below the brush size.
2. Click it → button highlights (active), hint appears, cursor over the image is a crosshair, the brush ring is hidden.
3. Drag a rectangle on the image → on release the view animates to fit that rectangle, the button is now **"Reset view"**, and the brush ring/painting are back (drawing a stroke erases as before).
4. Click **"Reset view"** → view animates back to fit; button returns to **"Zoom to area"**.
5. Arm again and do a tiny click (no drag) → no zoom happens; the button stays armed.
6. With marquee NOT armed: the mouse wheel still resizes the brush, Ctrl/pinch still zooms, and dragging paints a stroke (unchanged behavior).

- [ ] **Step 11: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts app/src/lib/develop/EraserPanel.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(eraser): marquee zoom + reset-view button wired through Develop"
```

---

## Self-Review

**Spec coverage:**
- Single swapping button in EraserPanel, "Zoom to area" ↔ "Reset view" → Task 3 Steps 3–5, 8.
- Arm → draw rect → zoom → auto-return to paint → Task 2 Steps 6 (onUp `marqueedone`) + Task 3 Step 7 (`on:marqueedone` clears `zoomMarquee`).
- Too-small drag cancels, stays armed → Task 2 Step 6 (`dist >= 8` guard; `marqueedone` not fired so armed flag stays).
- Painting blocked while armed → Task 2 Step 6 (marquee branch precedes painting branch in onDown/onMove/onUp).
- Reset view returns to fit → Task 2 Step 5 (`resetZoom`) + Task 3 Step 8 (`on:resetView`).
- Button label driven by zoom state → Task 2 Step 5 (`zoomchange`) + Task 3 Steps 3, 7, 8.
- Zoom math clamped `[fit, 8]`, centered on rect → Task 1.
- i18n via CSV + generator, no hand-edit of dict.ts → Task 3 Steps 1–2.
- No backend changes; strokes stay normalized → no Rust task; reuses `imgPoint`/`normPoint`.
- Crop/rotation correctness → reuses existing `imgPoint` mapping (same as painting).

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code.

**Type consistency:** `marquee`, `resetZoom`, `zoomchange`, `marqueedone` defined in Task 2 and consumed with identical names in Task 3. `zoomArea`/`resetView` events and `zoomed`/`marqueeArmed` props defined in EraserPanel (Task 3 Steps 3–5) match Develop's usage (Steps 7–8). i18n keys `eraser.zoomArea`/`eraser.resetView`/`eraser.marqueeHint` consistent across CSV and markup.
