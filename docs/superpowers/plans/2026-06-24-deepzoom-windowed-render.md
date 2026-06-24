# Deep-zoom windowed render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the develop preview's visible window into a viewport-sized GL canvas instead of CSS-upscaling the whole canvas, eliminating the WebKit compositor ceiling that corrupts the image past ~211% zoom.

**Architecture:** Today the GL canvas is sized to the source (≤4608px) and CSS-stretched to `imgW×eff` (→32794px at 712%, past the ~16384px compositor limit → flashing). We make the canvas track the on-screen image rect (bounded by the viewport) and have the invert shader render only the visible source window via two new identity-safe uniforms (`u_view_off`/`u_view_scale`) — a pre-scale of the output UV before the existing crop→straighten→orient chain. Zoom/pan stop being a CSS transform of the canvas; the vector overlays keep their current model and stay aligned because the canvas renders exactly the window those coordinates point at.

**Tech Stack:** Svelte 4, TypeScript, WebGL2 (GLSL ES 3.00), Vitest.

## Global Constraints

- The change MUST be a no-op at fit and 100% zoom (identity window `off=[0,0]`, `scale=[1,1]`) — fit/100% render byte-for-byte as before.
- Do NOT change the inversion/finish/tone math, the CPU-fallback `<img>` path, or the vector overlays (dust SVG, spots, brush, HDR) in this plan.
- Follow existing patterns in `app/src/lib/viewport/`: pure helpers live in `view.ts` with co-located `*.test.ts`; run tests with `npx vitest run <path>` from `app/`.
- Shader uniforms are registered by name in `renderer.ts`'s invert-program loop and set in `drawInvertPass`.

---

## File Structure

- `app/src/lib/viewport/view.ts` — add pure `viewWindow()` (the window math). Modify.
- `app/src/lib/viewport/view.test.ts` — add `viewWindow` tests. Modify.
- `app/src/lib/viewport/gl/shaders.ts` — `INVERT_FRAG`: two uniforms + one pre-scale line. Modify.
- `app/src/lib/viewport/gl/renderer.ts` — register uniforms; extend `setGeometry`; set uniforms in `drawInvertPass`. Modify.
- `app/src/lib/viewport/Viewport.svelte` — `applyGeometryAndDraw` uses `viewWindow`; canvas CSS = window rect; picking composes the window. Modify.

---

### Task 1: Pure `viewWindow` helper + tests

**Files:**
- Modify: `app/src/lib/viewport/view.ts`
- Test: `app/src/lib/viewport/view.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  ```ts
  export interface ViewWindow {
    off: [number, number];    // window origin in displayed-image UV (y-down, top=0)
    scale: [number, number];  // window size in displayed-image UV
    backing: { w: number; h: number };          // canvas backing px (device)
    css: { left: number; top: number; width: number; height: number }; // on-screen rect (CSS px)
  }
  export function viewWindow(
    scale: number, cx: number, cy: number,
    imgW: number, imgH: number, vpW: number, vpH: number,
    dpr: number, maxBacking: number,
  ): ViewWindow
  ```

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/viewport/view.test.ts`:

```ts
import { viewWindow } from "./view";

describe("viewWindow", () => {
  // 1000x500 image, 250x250 viewport, dpr 1, generous backing cap.
  it("fit/zoomed-out: identity window, canvas = letterboxed image rect", () => {
    const s = fitScale(1000, 500, 250, 250); // 0.25
    const w = viewWindow(s, 500, 250, 1000, 500, 250, 250, 1, 8192);
    expect(w.off).toEqual([0, 0]);
    expect(w.scale).toEqual([1, 1]);
    // dispW=250, dispH=125 → centered vertically in the 250 tall viewport.
    expect(w.css).toEqual({ left: 0, top: 62.5, width: 250, height: 125 });
    expect(w.backing).toEqual({ w: 250, h: 125 });
  });

  it("100% centered: full viewport canvas, centered half-ish window", () => {
    const w = viewWindow(1, 500, 250, 1000, 500, 250, 250, 1, 8192);
    // visW=250 of 1000 → scale .25, centered at x=375 → off .375; visH=250 of 500 → scale .5, off 0 (clamped)
    expect(w.off[0]).toBeCloseTo(0.375, 6);
    expect(w.scale[0]).toBeCloseTo(0.25, 6);
    expect(w.off[1]).toBeCloseTo(0, 6);
    expect(w.scale[1]).toBeCloseTo(0.5, 6);
    expect(w.css).toEqual({ left: 0, top: 0, width: 250, height: 250 });
    expect(w.backing).toEqual({ w: 250, h: 250 });
  });

  it("high zoom: backing stays bounded, window is a thin slice", () => {
    // 8x zoom on a 1000px image → dispW 8000; viewport 250 → window 250/8000.
    const w = viewWindow(8, 500, 250, 1000, 500, 250, 250, 2, 8192);
    expect(w.scale[0]).toBeCloseTo(250 / 8000, 6);
    expect(w.css.width).toBe(250);
    expect(w.backing.w).toBe(500); // 250 css * dpr 2, under the 8192 cap
  });

  it("backing is capped at maxBacking", () => {
    const w = viewWindow(8, 500, 250, 1000, 500, 250, 250, 2, 300);
    expect(w.backing.w).toBe(300); // 500 would exceed the 300 cap
  });

  it("pan clamps the window inside the image", () => {
    // 2x zoom, panned hard left/up past the edge.
    const w = viewWindow(2, 0, 0, 1000, 500, 250, 250, 1, 8192);
    expect(w.off[0]).toBe(0); // clamped to the left edge
    expect(w.off[1]).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run (from `app/`): `npx vitest run src/lib/viewport/view.test.ts`
Expected: FAIL — `viewWindow is not a function` / import error.

- [ ] **Step 3: Implement `viewWindow`**

Append to `app/src/lib/viewport/view.ts`:

```ts
export interface ViewWindow {
  off: [number, number];
  scale: [number, number];
  backing: { w: number; h: number };
  css: { left: number; top: number; width: number; height: number };
}

/**
 * The visible window for the GL preview at a given zoom/pan, in the displayed
 * (oriented+cropped) image of `imgW×imgH`. Mirrors `deriveView`'s visible-region
 * math but returns the shader UV window, the bounded canvas backing size, and the
 * on-screen CSS rect the canvas should occupy (the image's viewport-clipped box).
 * Identity (`off=[0,0], scale=[1,1]`) at fit/100%-fitting zoom.
 */
export function viewWindow(
  scale: number, cx: number, cy: number,
  imgW: number, imgH: number, vpW: number, vpH: number,
  dpr: number, maxBacking: number,
): ViewWindow {
  const visW = Math.min(vpW / scale, imgW);
  const visH = Math.min(vpH / scale, imgH);
  const x = clamp(cx - visW / 2, 0, Math.max(0, imgW - visW));
  const y = clamp(cy - visH / 2, 0, Math.max(0, imgH - visH));
  // On-screen position of the visible region: image origin is at vpW/2 - cx*scale.
  const left = vpW / 2 + (x - cx) * scale;
  const top = vpH / 2 + (y - cy) * scale;
  const width = visW * scale;
  const height = visH * scale;
  return {
    off: [x / imgW, y / imgH],
    scale: [visW / imgW, visH / imgH],
    backing: {
      w: Math.min(Math.max(1, Math.round(width * dpr)), maxBacking),
      h: Math.min(Math.max(1, Math.round(height * dpr)), maxBacking),
    },
    css: { left, top, width, height },
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run (from `app/`): `npx vitest run src/lib/viewport/view.test.ts`
Expected: PASS (all `viewWindow` + existing `deriveView` tests green).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/view.ts app/src/lib/viewport/view.test.ts
git commit -m "feat(viewport): viewWindow helper for windowed GL deep-zoom"
```

---

### Task 2: Shader view-window uniforms (identity-safe)

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (`INVERT_FRAG`)

**Interfaces:**
- Consumes: nothing.
- Produces: `INVERT_FRAG` now declares `uniform vec2 u_view_off;` and `uniform vec2 u_view_scale;` and applies them as the first transform in `sourceUV`. Renderer (Task 3) must set both; unset defaults to `(0,0)`/`(0,0)` in GL, which would zero the image — so the renderer MUST always set them (`[0,0]`/`[1,1]` for identity).

- [ ] **Step 1: Add the uniform declarations**

In `app/src/lib/viewport/gl/shaders.ts`, in `INVERT_FRAG`, immediately after the existing geometry uniform block (the line `uniform mat2 u_orient;      // oriented-UV → source-UV (undoes rot90/flip)`), add:

```glsl
uniform vec2 u_view_off;      // deep-zoom visible-window origin (displayed-image UV, y-down)
uniform vec2 u_view_scale;    // deep-zoom visible-window size (displayed-image UV)
```

- [ ] **Step 2: Apply the window as the first transform in `sourceUV`**

In `sourceUV(vec2 uv)`, change the opening so the window is applied right after the y-flip (which puts `uv` in image-space y-down, matching `viewWindow`'s `off`/`scale`):

```glsl
vec2 sourceUV(vec2 uv) {
  uv.y = 1.0 - uv.y;
  uv = u_view_off + uv * u_view_scale;   // deep-zoom window (identity = off 0, scale 1)
  // 1. map the output UV into the (straightened) oriented-image frame, centred.
  vec2 c = u_crop_off + uv * u_crop_scale - 0.5;
  // ...rest unchanged...
```

(The original `uv.y = 1.0 - uv.y;` line that was at the top of the body is now replaced by these two lines — do not leave a duplicate flip.)

- [ ] **Step 3: Verify it compiles (build)**

Run (from `app/`): `npx vitest run src/lib/viewport/histogram.test.ts`
Expected: PASS (sanity that the TS module still imports; the shader is a string, so this just confirms no syntax break in `shaders.ts`).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts
git commit -m "feat(viewport): INVERT_FRAG view-window pre-scale uniforms"
```

---

### Task 3: Renderer — register + set the view-window uniforms; extend `setGeometry`

**Files:**
- Modify: `app/src/lib/viewport/gl/renderer.ts`

**Interfaces:**
- Consumes: `INVERT_FRAG` uniforms `u_view_off`, `u_view_scale` (Task 2).
- Produces: `setGeometry` accepts two new fields and stores them; `drawInvertPass` sets the uniforms each draw. New `setGeometry` signature:
  ```ts
  setGeometry(g: {
    crop_off: [number, number]; crop_scale: [number, number];
    angle: number; aspect: number; orient: [number, number, number, number];
    raw: boolean; outW: number; outH: number;
    view_off: [number, number]; view_scale: [number, number];
  }): void
  ```
  Every caller of `setGeometry` (in `Viewport.svelte`) MUST pass `view_off`/`view_scale` (Task 4).

- [ ] **Step 1: Register the uniform locations**

In `renderer.ts`, in the invert-program uniform-name array (the `for (const n of [ ... ]) this.invLoc[n] = ...` block), add `"u_view_off","u_view_scale"` to the list (e.g. at the end of the geometry group alongside `"u_orient"`).

- [ ] **Step 2: Add window fields to the `geom` store with identity defaults**

In the `private geom = { ... }` initializer, add:

```ts
    view_off: new Float32Array([0, 0]),
    view_scale: new Float32Array([1, 1]),
```

- [ ] **Step 3: Accept and store the window in `setGeometry`**

Update `setGeometry`'s parameter type to include `view_off: [number, number]; view_scale: [number, number];`, and in the body add:

```ts
    this.geom.view_off = new Float32Array(g.view_off);
    this.geom.view_scale = new Float32Array(g.view_scale);
```

- [ ] **Step 4: Set the uniforms in `drawInvertPass`**

In `drawInvertPass`, after the existing `gl.uniformMatrix2fv(L.u_orient, false, this.geom.orient);` line, add:

```ts
    gl.uniform2fv(L.u_view_off, this.geom.view_off);
    gl.uniform2fv(L.u_view_scale, this.geom.view_scale);
```

- [ ] **Step 5: Verify TS compiles**

Run (from `app/`): `npx vitest run src/lib/viewport/hiTier.test.ts`
Expected: PASS (module imports cleanly; this is a compile sanity check — `renderer.ts` must have no type errors).

> Note: this task leaves `setGeometry` callers in `Viewport.svelte` missing the new required fields — TypeScript will flag them. That is fixed in Task 4; commit Tasks 3+4 together if the type error blocks the test run, otherwise commit now.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/viewport/gl/renderer.ts
git commit -m "feat(viewport): renderer plumbs view-window uniforms"
```

---

### Task 4: Viewport — drive the window (canvas rect + backing + uniforms)

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte`

**Interfaces:**
- Consumes: `viewWindow` (Task 1); `setGeometry` with `view_off`/`view_scale` (Task 3).
- Produces: a reactive `vw0: ViewWindow` and a `MAX_BACKING` constant used by the canvas markup and `applyGeometryAndDraw`. The canvas `<canvas>` element style and backing now come from `vw0`, not `dispW/left/top`.

- [ ] **Step 1: Import the helper and add a backing cap + reactive window**

At the top `<script>` imports, add `viewWindow` to the existing `view` import (or a new import):

```ts
import { viewWindow, type ViewWindow } from "./view";
```

Near the other constants (`const PROXY_EDGE = 2560;`), add:

```ts
// Canvas backing never exceeds this — keeps the composited layer well under the
// WebKit/WebGL limits regardless of zoom. The visible window is rendered into it.
const MAX_BACKING = 4096;
```

Near the `dispW`/`left` reactive block (lines ~183-186), add:

```ts
  $: dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
  $: vw0 = (gpuEligible && imgW > 0 && imgH > 0 && vpW > 0 && vpH > 0)
    ? viewWindow(eff, cx, cy, imgW, imgH, vpW, vpH, dpr, MAX_BACKING)
    : null;
```

(Keep the existing `dispW`/`dispH`/`left`/`top` reactives — the overlays still use them.)

- [ ] **Step 2: Point the canvas element at the window rect**

Replace the canvas element's style (the `<canvas ... style="position:absolute; width:{dispW}px; height:{dispH}px; left:{left}px; top:{top}px;">`) with the window CSS rect, falling back to the old full-image rect when `vw0` is null:

```svelte
    <canvas
      bind:this={canvas} class:anim={animating}
      style="position:absolute; left:{vw0 ? vw0.css.left : left}px; top:{vw0 ? vw0.css.top : top}px; width:{vw0 ? vw0.css.width : dispW}px; height:{vw0 ? vw0.css.height : dispH}px;"
    ></canvas>
```

Leave the `switchPreview`, HDR `<img>`, mask SVG, spots, and brush markup unchanged (they keep `dispW/left/top`).

- [ ] **Step 3: Feed the window into `applyGeometryAndDraw`**

In `applyGeometryAndDraw`, the non-bake branch currently computes `outW`/`outH` from `oW*cropW`. Replace the `renderer.setGeometry({...})` call (non-bake branch) so output dims come from the window backing and the window is passed through:

```ts
    const win = vw0 ?? { off: [0, 0] as [number, number], scale: [1, 1] as [number, number],
      backing: { w: outW, h: outH }, css: { left, top, width: dispW, height: dispH } };
    renderer.setGeometry({
      crop_off: [cropX, cropY], crop_scale: [cropW, cropH],
      angle: (angle * Math.PI) / 180, aspect: oH / oW, orient: o,
      raw, outW: win.backing.w, outH: win.backing.h,
      view_off: win.off, view_scale: win.scale,
    });
```

For the **bake-mode** branch (the early `renderer.setGeometry({ ... outW: texW, outH: texH })` call), add identity window fields so it still type-checks and behaves as today:

```ts
      renderer.setGeometry({
        crop_off: [0, 0], crop_scale: [1, 1], angle: 0, aspect: 1,
        orient: [1, 0, 0, 1], raw, outW: texW, outH: texH,
        view_off: [0, 0], view_scale: [1, 1],
      });
```

- [ ] **Step 4: Redraw when the window changes (pan/zoom)**

The existing `geomKey` reactive (`$: geomKey = ...`) only re-draws on crop/orient changes, not pan/zoom (those were pure CSS before). Add the window to the redraw trigger. Change the `geomKey` line to include pan/zoom:

```ts
  $: geomKey = `${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}|${eff}|${cx}|${cy}|${vpW}|${vpH}`;
```

(The existing `$: if (gpuEligible && !bakeMode) { geomKey; applyGeometryAndDraw(); }` then re-runs on pan/zoom.)

- [ ] **Step 5: Build and smoke-run the app**

Run (from `app/`): `npx vitest run src/lib/viewport/view.test.ts src/lib/viewport/hiTier.test.ts`
Expected: PASS (no type errors across the touched modules).

Then in `tauri dev` (already running for the user): open a developed image. Expected: fit and 100% look identical to before; **zoom past 300%/700% — no flashing, image stays crisp and correctly proportioned**; pan moves the image smoothly.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(viewport): render visible window into a viewport-sized canvas"
```

---

### Task 5: Picking — compose the window into screen→source mapping

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte`

**Interfaces:**
- Consumes: `vw0` (Task 4); `displayToSourceUV` (existing import from `../crop/transforms`).
- Produces: point-pick (`onDown` `pointPick` branch) maps the click through the active window before `displayToSourceUV`, so gray-point picks land on the right source pixel at any zoom.

- [ ] **Step 1: Map the click through the window before `displayToSourceUV`**

In the `pointPick` branch of `onDown` (around lines 691-707), the canvas now covers only the visible window, so `px/rect.width` is normalized *within the window*. Convert to displayed-image UV first. Replace:

```ts
        const [u, v] = displayToSourceUV(px / rect.width, py / rect.height, imageCrop, rot90, flipH, flipV);
```

with:

```ts
        // Canvas covers only the visible window; map the in-canvas fraction to the
        // displayed-image UV (window off + frac*scale) before crop/orient inversion.
        const du = vw0 ? vw0.off[0] + (px / rect.width) * vw0.scale[0] : px / rect.width;
        const dv = vw0 ? vw0.off[1] + (py / rect.height) * vw0.scale[1] : py / rect.height;
        const [u, v] = displayToSourceUV(du, dv, imageCrop, rot90, flipH, flipV);
```

(`pickPixel`/`sampleRobust` read GL pixels at canvas-local `px,py`, which remain valid — the canvas is the window — so they are unchanged.)

- [ ] **Step 2: Build and verify picking in the app**

Run (from `app/`): `npx vitest run src/lib/viewport/view.test.ts`
Expected: PASS.

Then in `tauri dev`: zoom to ~300%, use the gray-point/WB picker on a known-neutral spot. Expected: the picked Temp/Tint shift matches the spot under the cursor (not an offset pixel).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "fix(viewport): map point-pick through the deep-zoom window"
```

---

### Task 6: GUI verification matrix + overlay check

**Files:** none (verification only; fixes, if any, fold back into Tasks 4–5).

- [ ] **Step 1: Run the full viewport unit suite**

Run (from `app/`): `npx vitest run src/lib/viewport/`
Expected: PASS (all existing + new tests).

- [ ] **Step 2: GUI matrix in `tauri dev`**

For BOTH the Olympus E-M5 II high-res ORF (`/Users/mohaelder/Desktop/P6240318.orf`) and a normal RAW, at zoom = fit / 100% / 300% / 700%:
- Image is crisp and correctly proportioned; **no flashing / region-switching** at any zoom (the original bug).
- fit and 100% are visually identical to the pre-change build (identity-window regression).
- Pan (drag) moves the image smoothly with no jumps.
- Hover-readout RGB and the gray-point picker land on the pixel under the cursor.
- With a slight straightening `angle` applied, high-zoom view is still correctly aligned (no skew) — confirms the window/straighten composition.

- [ ] **Step 3: Overlay alignment check (scopes any follow-up)**

At ~300% with the eraser/dust tool active: confirm dust-mask strokes, spot markers, and the brush cursor sit where expected over the image. If an overlay is mis-aligned ONLY because it relies on `dispW` exceeding a browser limit at extreme zoom, note it as a separate follow-up (out of scope here); if it is mis-aligned at moderate zoom, fix the overlay's coordinate mapping in `Viewport.svelte` and re-commit under Task 4.

- [ ] **Step 4: Final commit (if any verification fixes were made)**

```bash
git add -A
git commit -m "fix(viewport): deep-zoom verification follow-ups"
```

---

## Self-Review notes

- **Spec coverage:** viewport-sized canvas (Tasks 3–4), shader window pre-scale (Task 2), window math as a unit-tested pure fn (Task 1), picking (Task 5), overlays-unchanged + GUI verify (Tasks 4,6), identity-at-fit/100% constraint (Tasks 1,2,4 + verify Task 6). CPU `<img>` path explicitly out of scope (Global Constraints).
- **Identity safety:** `u_view_off`/`u_view_scale` default to `[0,0]`/`[1,1]` everywhere they're set (geom init, bake branch, null-`vw0` fallback); a forgotten set would zero the image, so both are always written.
- **Type consistency:** `viewWindow` signature and `ViewWindow` shape match between Task 1 (definition) and Tasks 4–5 (use); `setGeometry`'s new `view_off`/`view_scale` fields match between Task 3 (definition) and Task 4 (both call sites).
