# RedRoom — Viewport-Bounded Rendering + Zoom/Pan Design

**Date:** 2026-06-04
**Status:** Approved (design phase)
**Depends on:** RedRoom UI (`docs/superpowers/specs/2026-06-03-redroom-ui-design.md`)

## Problem

Live editing is slow: every param/slider change re-inverts the entire 2048px proxy — twice
when Auto-WB is on — then PNG-encodes and ships base64 over IPC. Cost scales with the proxy
size regardless of what's actually visible. There is also no way to inspect detail (no zoom).

## Goal

Make interactive editing fast and add Lightroom-style zoom/pan, via a single mechanism:
**always render at ~viewport resolution, never the full image.** Editing cost becomes bounded by
the viewport (constant), not the image size, at any zoom. Export stays full-res.

## Core mechanism: `render_view`

One command replaces `raw_preview` and `inverted_preview`:

```
render_view(id, params, view) -> String   // base64 PNG data URI
  view = ViewSpec {
    crop: [f64; 4],   // x, y, w, h in FULL-RES pixels (the visible region)
    out_w: u32,       // output pixel size ≈ the on-screen viewport
    out_h: u32,
    raw: bool,        // true = un-inverted scan (Library); false = inverted (Develop)
  }
```

Backend per call:
1. Pick **source**: if the crop's native resolution ≥ requested out-size (i.e. zoomed in enough
   that the proxy would be soft), use `full_res`; else use the cached `proxy`.
2. **Crop** the source to the region (mapping full-res crop coords into source coords by the
   source's scale).
3. **Resize** the crop to `out_w × out_h`.
4. If `raw`: encode directly (display gamma). Else: `sample_base` + `resolve_params` + invert
   **once**, encode.

Because step 3 downsizes to the viewport before the (expensive) invert in step 4, the invert
always processes ~`out_w × out_h` pixels — constant cost independent of zoom or image size.

- **Fit view:** `crop` = whole image, `out` = viewport → inverts a viewport-sized downscale
  (from the proxy). Faster than today's full-proxy invert.
- **100% / zoomed:** `crop` = the visible sub-region, `out` = viewport, source = `full_res` →
  sharp real detail, still viewport-bounded.

## Second perf fix: Auto-WB on the thumbnail

Gray-world WB is statistical and doesn't need full resolution. Compute `auto_wb_gains` once on
the cached **256px thumbnail** (store it on import, or compute per render from the thumbnail),
so the live render inverts the view **once** instead of twice. `resolve_params` takes a small
image for the auto-WB pass rather than re-inverting the render target.

## Zoom/pan interaction (Lightroom loupe)

State (frontend): `{ zoom: number, cx: number, cy: number }` where `zoom` is image-px per
screen-px scale and `(cx, cy)` is the image-space point centered in the viewport.

- **Fit** = the zoom that fits the whole image in the viewport (`zoom_fit`).
- Hover over the image → **loupe/magnifier cursor**.
- **Click** → toggle **Fit ↔ 100%** (`zoom = 1.0`, one image px per screen px), centering on the
  clicked image point. (This reproduces the user's resolution-scaled jump: 1:1 is a larger jump
  from fit for higher-res images.)
- **Pinch / scroll** → continuous zoom around the cursor, clamped to `[zoom_fit, 8.0]`.
- **Drag** → pan (adjust `cx, cy`), enabled **only when `zoom > zoom_fit`** (zoomed in). At fit,
  no panning.
- A corner **zoom indicator** shows `Fit` / `100%` / `230%` etc.

The frontend derives `crop` + `out_w/out_h` from `{zoom, cx, cy}` and the viewport size, then
calls `render_view` (debounced on slider drags; immediate on click/zoom/pan-end).

## Architecture / files

```
app/src-tauri/src/
├── convert.rs    ADD: crop(&Image, x,y,w,h) -> Image ; resize_to(&Image, w,h) -> Image
├── commands.rs   REPLACE raw_preview + inverted_preview WITH render_view; ViewSpec type;
│                 source-selection + crop+resize+invert. Auto-WB uses the thumbnail.
└── session.rs    CachedImage already holds full_res + proxy + thumbnail; no shape change
app/src/lib/
├── viewport/Viewport.svelte   NEW: image canvas — cursor, click-toggle, pinch/scroll, pan,
│                              crop math, calls render_view; emits nothing (self-contained)
├── api.ts        ADD ViewSpec type + renderView(); REMOVE rawPreview/invertedPreview
├── tabs/Develop.svelte   use <Viewport> for the center; keep Invert/Adjustments/Filmstrip
└── tabs/Library.svelte   use render_view(raw:true) at fit (no zoom UI in Library)
```

`Viewport.svelte` has one job: own the zoom/pan state + cursor, compute the view rectangle,
and render via `render_view`. Develop/Library pass it `{ id, params, raw }`.

## Data flow

```
{zoom, cx, cy} + viewport size
   └─► deriveView(): crop[full-res px], out_w, out_h
        └─► render_view(id, params, {crop, out_w, out_h, raw})
             backend: pick source(proxy|full_res) → crop → resize(out) → [invert once] → PNG
   (debounced on slider edits; eager on click/zoom/pan)
```

## Error handling

- `render_view` on an unknown id → `Err("unknown image id")` → frontend keeps prior frame.
- A crop fully outside the image → clamp to image bounds; if degenerate (zero area), return the
  fit view.
- Export path unchanged (full-res), still `Result<(), String>`.

## Testing

- **`convert.rs` (Rust unit):** `crop` returns the right sub-rectangle pixels and dimensions;
  `crop` clamps to image bounds without panicking; `resize_to` hits the requested dimensions and
  preserves a solid color.
- **`commands.rs` source selection (Rust unit):** a pure helper `choose_source(crop_w, out_w,
  proxy_scale) -> Source` returns `FullRes` when the crop is high-DPI vs out-size and `Proxy`
  otherwise — tested directly.
- **Frontend:** a unit test of `deriveView(zoom, cx, cy, imgW, imgH, vpW, vpH)` crop math —
  fit covers the whole image; 100% yields a crop of `out`-many image px centered on `(cx,cy)`;
  crop clamps at edges.
- **Manual E2E:** load V600 + GFX; confirm fit edit is fast, click toggles to 100% sharp,
  pinch/scroll zoom, pan only when zoomed, loupe cursor, export still full-res; record timing
  feel in `poc-findings.md`.

## Scope

**In:** `render_view` (viewport-bounded), Fit↔100% click toggle, pinch/scroll zoom, pan-when-
zoomed, loupe cursor, zoom indicator, Auto-WB-on-thumbnail perf fix, Develop tab zoom (Library
uses `render_view` at fit only).

**Out (later):** GPU/wgpu rendering; progressive low-res-during-drag then sharpen; tiled/region
caching; zoom in the Library tab; 100%+ sharpening; threaded/async render queue.

## Assumptions

1. base64-PNG of a viewport-sized region (~1200–1500px) over IPC is fast enough; if not, the
   Tauri asset protocol / shared memory is the later optimization.
2. Inverting a single viewport-sized image per change (with Auto-WB from the thumbnail) is the
   dominant cost removed; remaining latency is crop+resize of `full_res` on zoom/pan, acceptable
   and debounced.
3. `zoom_fit` and crop math live in the frontend; the backend is stateless w.r.t. view (takes an
   explicit crop), keeping it simple and testable.
