# WB gray-point picker — drift fix + resizable sampling ring

Date: 2026-06-25

## Problem (reported, roll "060a")

The white-balance gray-point picker "malfunctions": repeatedly clicking a gray
point makes Temp/Tint **drift continuously in one direction** instead of
converging. User suggested an adjustable-size averaging picker (like the
film-base / 取片机 tool) for stability.

## Root cause (fixed)

The drift was **not** a sampling problem. It was a unit bug in
`gray_point_wb` (`app/src-tauri/src/commands.rs`):

1. **Tint scale mismatch** — `gray_point_temp_tint` returns tint in the −1..1
   convention, but the value was passed straight to `wb_from_params`, which
   divides tint by 150 again. The green/magenta correction therefore landed at
   ~1/150 of its needed strength, so the clicked point never reached neutral and
   each pick nudged tint a sliver further.
2. **Slider double-count** — the function already divides the current WB back
   out (its result is *absolute*), yet it multiplied the current slider back in.

Fix: return the absolute white point directly, matching the sibling
`as_shot_wb`. Covered by `gray_point_wb_converges_no_drift` (pick-and-apply loop:
pre-fix stays tinted forever; post-fix neutralises in one pick and re-picking is
a fixpoint). **Shipped on main.**

## Enhancement — resizable sampling ring (this spec)

The picker already medians a fixed `win`×`win` window of GL-canvas pixels
(`sampleRobust`, ~4% of the canvas short edge). Make that window **user-sizable
and visible**, so the user can enlarge it for more samples = more stability.

### Scope

Frontend only. No backend changes — `sampleRobust` already takes a `win` param.

### Interaction (`app/src/lib/viewport/Viewport.svelte`)

- Picking stays on the **live developed preview** (the GL canvas), armed via the
  existing `pointPick` flag. No full-image overlay.
- While `pointPick` is on, draw a **circular sampling ring** centered on the
  cursor, sized in **canvas/screen pixels** (a visible version of today's `win`).
  It is a consistent on-screen aiming target; zooming in naturally averages
  fewer real pixels.
- **Scroll-wheel** grows/shrinks the ring around the cursor (multiplicative,
  ~1.12×/notch). **Trackpad pinch** (WebKit non-standard `gesturestart`/
  `gesturechange`) maps to the same resize. Both copy BaseView's
  `resizePatch`/`onWheel`/`onGesture*` so it feels identical to the film-base
  tool. The picker owns the gesture (`preventDefault`/`stopPropagation`) so the
  webview doesn't page-zoom.
- Clamp the diameter to `[WB_WIN_MIN, WB_WIN_MAX]` (≈15px → ~25% of canvas short
  edge). Persist the chosen size **within the session** (a module-level value),
  so it does not reset on every pick.
- Click samples exactly as today, but passes the **current ring diameter** as
  `win` to `sampleRobust`; the per-channel median feeds `grayPointWb`.

### Out of scope (YAGNI)

- No magnifier/pixel-zoom loupe (ring only).
- No backend sample-on-positive command.
- No persistence across sessions (in-session only).
- The averaging method stays a per-channel **median** (already grain/dust
  robust); resizing is what buys extra stability.

### Testing

- Unit-test the resize-clamp helper (mirrors BaseView's `resizePatch`): scroll
  up grows, down shrinks, clamped to min/max.
- Ring rendering + gesture wiring verified by GUI smoke test (how BaseView
  shipped).
