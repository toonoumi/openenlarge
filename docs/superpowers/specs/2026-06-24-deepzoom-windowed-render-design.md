# Deep-zoom windowed render — design

**Date:** 2026-06-24
**Status:** Approved (design), pending implementation plan
**Area:** `app/src/lib/viewport/` (WebGL2 develop preview)

## Problem

The develop Viewport renders the GL canvas at the source/proxy resolution
(`texW×texH`, e.g. 4608×3456 for a 16MP frame) and then **CSS-stretches that
canvas** to `dispW = imgW × eff`, panning it with `left/top`. At high zoom
`dispW` grows without bound: at 712% zoom on a 4608px image, `dispW = 32794`
CSS px (≈65 000 device px at `dpr 2`). That exceeds WebKit's compositor
max layer size (~16384 device px), so WKWebView tiles/clamps the oversized
layer — producing "super-magnified regions switching / flashing / out of
proportion." Onset is ~211% zoom (`4608 × eff × dpr ≈ 16384 → eff ≈ 1.8–2.1`).

This is a pre-existing limit of the CSS-upscale-the-whole-canvas approach, not
specific to any one file. It was surfaced while fixing an unrelated Olympus
high-res decode bug (committed separately, `3a3f97e`); that decode fix is done.

Evidence (captured live via temporary `[zoomdbg]` logging, since removed):

| zoom | hiTier | texW (backing) | dispW (CSS) |
|------|--------|----------------|-------------|
| 9% (fit) | false | 2560 | 432 |
| 100% | true | 4608 | 4608 |
| 712% | true | 4608 | **32794** |

Geometry was perfectly consistent (`imgW = texW = outW`, aspect correct) — the
sole failure is the oversized CSS-composited canvas.

## Goal

Eliminate the compositor ceiling so the preview stays correct and crisp at any
zoom, without capping max zoom. Keep the persistent image crop, straightening
(`angle`), orientation (`rot90`/flip), pan, picking, and the vector overlays
working.

Non-goals: changing the inversion/finish math; reworking the CPU-fallback
(`<img>`) path; reworking the vector overlays (verified separately — see Risks).

## Approach: viewport-windowed GL canvas

Stop treating the canvas as "the whole image, scaled." Instead:

1. **Canvas backing = viewport size × dpr**, capped at `MAX_GPU_EDGE` and at the
   available source resolution. It never approaches the compositor limit.
2. **Canvas CSS = fills the viewport** (`left:0; top:0; width:vpW; height:vpH`),
   not `dispW/left/top`.
3. **The shader renders only the visible source window.** Zoom/pan select a
   sub-window of the displayed image; the invert/finish passes run at viewport
   resolution over just that window (cheaper than full-frame at high zoom).

### Shader change (minimal)

`INVERT_FRAG`'s `sourceUV(uv)` already maps output-UV `[0,1]` → displayed image
(crop → straighten → orient → source). Zooming the *displayed* image is a
pre-scale of the output UV, applied before that chain:

```glsl
uniform vec2 u_view_off;    // visible-window origin in displayed-image UV
uniform vec2 u_view_scale;  // visible-window size in displayed-image UV
...
vec2 sourceUV(vec2 uv) {
  uv = u_view_off + uv * u_view_scale;   // NEW: window the displayed image
  uv.y = 1.0 - uv.y;
  ... // existing crop / straighten / orient unchanged
}
```

Identity (`off=[0,0]`, `scale=[1,1]`) reproduces today's full-frame render, so
fit/100% behave exactly as now. Out-of-window/out-of-source UV stays black
(existing guard). The `u_raw`/`u_positive` branches share `sourceUV`, so they
window for free.

### Window math (JS, pure + unit-tested)

Derive the window from existing pan/zoom state (`cx, cy` image-pixel center;
`eff` scale; `vpW, vpH` viewport device-independent px; `imgW, imgH` displayed
dims). The displayed image spans `dispW = imgW × eff` at `left = vpW/2 − cx×eff`
(today's values, used only as the math source — not as a DOM size):

```
win_scale_x = min(1, vpW / dispW)
win_off_x   = clamp(-left / dispW, 0, 1 - win_scale_x)   // pan, clamped to image
```

…and likewise for y. Account for the y-up/y-down convention so it matches
`v_uv`. Extract as a pure function `viewWindow({cx,cy,eff,vpW,vpH,imgW,imgH})
→ {off:[x,y], scale:[x,y]}` with unit tests (fit → full window; centered 2×
zoom → centered half window; pan clamps at edges).

### Canvas sizing

- Backing: `outW = min(round(vpW×dpr), MAX_GPU_EDGE, sourceWindowPixels)`,
  same for height. `setSourceFloat`/`allocInter` already size the invert/finish
  FBOs to the output dims — they follow `outW/outH`.
- Past 100% the window is smaller than the viewport in source px, so backing is
  capped by viewport (crisp at device resolution); the shader's existing LINEAR
  magnifies within the window exactly as today, just bounded.

### Picking

`pickPixel` currently reads the canvas (full-image backing) at screen
coordinates. With a viewport-sized canvas, screen→canvas is now direct
(canvas fills the viewport), and the *source* pixel is recovered via the same
`viewWindow` mapping. Update the screen→source UV path
(`displayToSourceUV`/`pickPixel`) to compose the window.

### Overlays (unchanged this pass)

Vector overlays (dust-mask SVG, spot markers, brush, HDR `<img>`, switch
preview) stay in the `dispW/left/top` model. They visually coincide with the
canvas because the canvas renders exactly the window those coordinates point
at. Verify alignment at 300%/700% during GUI testing; if any overlay also
breaks at extreme zoom (large-SVG limits), that is a scoped follow-up, not part
of this change.

## Touch points

- `app/src/lib/viewport/gl/shaders.ts` — `u_view_off`/`u_view_scale` + pre-scale.
- `app/src/lib/viewport/gl/renderer.ts` — register uniforms; `setGeometry`
  accepts the view window; `setSourceFloat`/`allocInter`/canvas sizing to
  viewport dims.
- `app/src/lib/viewport/Viewport.svelte` — `applyGeometryAndDraw` (window math),
  canvas CSS (fill viewport), `pickPixel`/`displayToSourceUV`, pan-clamp,
  `drawGL`. New pure `viewWindow` helper (+ its module/test).
- The CPU-fallback `<img>` path and overlays remain in the current model.

## Testing

- **Unit:** `viewWindow` mapping — fit, centered zoom, edge-clamped pan, with a
  persistent crop and odd `rot90`.
- **GUI (`tauri dev`):** at fit / 100% / 300% / 700% on the E-M5 II high-res ORF
  and a normal RAW — image is crisp and stable (no flashing), pans correctly,
  hover-pick RGB is accurate, overlays align. Confirm fit/100% are visually
  identical to pre-change (identity-window regression).

## Risks

- **Angle composition:** the view window is axis-aligned in displayed space and
  injected before straighten — correct because `sourceUV` already produces the
  displayed (post-straighten) image from output UV. Verify with a straightened
  frame at high zoom.
- **Overlay alignment / large-SVG limits:** verified separately; possible
  follow-up.
- **dpr / fractional pixels:** round backing dims; clamp window to `[0,1]`.
