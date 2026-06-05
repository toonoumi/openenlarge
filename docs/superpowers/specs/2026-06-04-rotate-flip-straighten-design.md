# Rotate / Flip / Straighten Design

**Date:** 2026-06-04
**Branch:** `feat/develop-redesign`
**Status:** Approved, ready for implementation planning

## Goal

Add image-geometry transforms to the crop tool: 90° rotation (CW/CCW, buttons +
⌘/Ctrl+] / [), horizontal/vertical flip (buttons), and Lightroom-style straighten
(a fine angle via a slider and rotate-on-hover-outside-corner). All persist
per-image and apply to the develop preview and export. The crop box follows each
transform.

## Scope

One combined plan (the user opted to build it all together). Orthogonal transforms
(90°/flips) are lossless exact remaps; straighten is a bilinear rotation with a
constrain-to-rotated-image step.

## Resolved decisions

- **Box follows the transform**: rotating/flipping transforms the crop rect so the
  same region stays cropped.
- **One plan** (orthogonal + straighten together).
- **Shortcut convention**: ⌘/Ctrl+] = rotate CW, ⌘/Ctrl+[ = rotate CCW.
- **Flip negates the straighten angle** (a mirrored image stays straight).
- Per-image, session-scoped (file persistence deferred project-wide).

## Current state (relevant facts)

- `app/src/lib/crop/types.ts`: `CropRect = { rect: Rect; aspect: string;
  orientation: "landscape"|"portrait" }`. `Rect = {x,y,w,h}` normalized.
- `cropById: Record<id, CropRect|null>` + `activeCrop` derived (`store.ts`).
- `commands.rs::render_view`: applies `view.image_crop` (normalized) then the view
  crop; `export_image(id, params, out_path, image_crop, session)`. `ViewSpec` has
  `crop, out_w, out_h, raw, finish, image_crop`.
- `convert.rs`: `crop`, `resize_to`, `proxy` exist. No `orient`/`rotate`.
- `Develop.svelte`: crop-mode swaps in `CropView` + `CropPanel`; manages the draft
  (`rect`, `aspect`, `orientation`), commit-on-leave/Enter, Esc-discard, `x` swap.
  Passes committed crop's effective dims + `imageCrop` to `Viewport`.
- `CropView.svelte`: fetches the finished full image at Fit, hosts `CropOverlay`.
- `CropOverlay.svelte`: box/brackets/thirds/scrim + drag/resize via `cropMath`.
- `CropPanel.svelte`: aspect dropdown, orientation/`x`, reset.
- `Viewport.svelte`: `imageCrop` prop → `ViewSpec.image_crop` + `srcKey`.

---

## Data model

Extend `CropRect`:
```ts
export interface CropRect {
  rect: Rect;
  aspect: string;
  orientation: "landscape" | "portrait";
  rot90: 0 | 1 | 2 | 3;   // 90° CW steps
  flipH: boolean;
  flipV: boolean;
  angle: number;          // straighten degrees, −45..45 (default 0)
}
```
All new fields default to a no-op (`rot90:0, flipH:false, flipV:false, angle:0`).
`rect` is always expressed in the **current oriented** frame (after rot90/flips).

## Geometry pipeline (original image → output)

Applied in this fixed order by the backend (`render_view`, `export_image`):

1. **orient**: flip-H, then flip-V, then `rot90` 90°-CW turns. 90° turns swap W/H.
2. **straighten**: rotate by `angle` (bilinear) about center, same canvas size;
   out-of-bounds → black.
3. **crop**: the normalized `rect` (in the oriented+straightened frame).
4. existing view/zoom crop → invert → finish.

The crop `rect` is constrained on the frontend so it never includes the blank
wedges produced by straighten; export is therefore clean.

## Backend (`convert.rs` + `commands.rs`)

### `convert.rs` (tested)
- `orient(img, rot90: u8, flip_h: bool, flip_v: bool) -> Image`: exact pixel remap.
  Order: flip-H, flip-V, then `rot90` clockwise quarter-turns. 90°/270° swap dims.
- `rotate(img, deg: f32) -> Image`: bilinear rotation about center into a same-size
  canvas; sample via inverse rotation; out-of-bounds → `[0,0,0]`. No-op when
  `deg.abs() < 1e-4`.

### `commands.rs`
- `ViewSpec` gains `#[serde(default)]` `rot90: u8`, `flip_h: bool`, `flip_v: bool`,
  `angle: f32`.
- `render_view`: `orient(working, …)` → `rotate(_, angle)` → `image_crop` →
  view crop → invert → finish. (`s_scale` recomputed from the oriented dims.)
- `export_image`: gains `rot90, flip_h, flip_v, angle` params; same orient→rotate→
  crop on the full image before inversion.
- A pure `orient_dims(w, h, rot90) -> (w, h)` helper (90°/270° swap) + test.

## Pure geometry (`crop/transforms.ts` — new — + `cropMath.ts`, tested)

Normalized-rect transforms keeping the same region under each action:
- `rotateRectCW(r)` → `{ x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w }`
- `rotateRectCCW(r)` → `{ x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w }`
- `flipRectH(r)` → `{ ...r, x: 1 - r.x - r.w }`
- `flipRectV(r)` → `{ ...r, y: 1 - r.y - r.h }`

Straighten constrain:
- `constrainToRotated(rect, deg, ow, oh)`: scale the rect about its center to the
  largest factor `s ≤ 1` where all four corners, inverse-rotated by `deg` about the
  oriented-image center, fall within `[0,ow]×[0,oh]`. Binary-search `s`. Identity
  when `deg ≈ 0`. Pure; takes oriented pixel dims so the rotation is computed in
  pixel space (normalized axes have unequal scale).

## Frontend

### `CropPanel.svelte`
Add, below the aspect controls:
- **Straighten** slider (−45..45, step 0.1, default 0) — reuses the develop
  `Slider` style; double-click resets to 0.
- A row of icon buttons: **Rotate CCW**, **Rotate CW**, **Flip H**, **Flip V**
  (new glyphs in `Icon.svelte`). Dispatches `rotate` (`-1`/`+1`), `flip` (`h`/`v`).

### `CropView.svelte`
- Fetches the **oriented** full image (backend applies `rot90`/flips; `angle=0`,
  `image_crop=null`), so the crop box maps to oriented dims. Re-fetch only when
  `rot90`/`flipH`/`flipV` change (discrete).
- **CSS-rotates** the displayed `<img>` by `angle` (`transform: rotate`) for a live
  straighten preview — no backend round-trip per slider tick.
- **Rotate-on-hover-outside-corner**: when the pointer is just outside a corner
  bracket, cursor = rotate icon; dragging changes `angle` (dispatched up to
  Develop). The crop box stays axis-aligned.
- After any straighten/edit, the draft rect is passed through `constrainToRotated`.

### `Develop.svelte`
- Draft state gains `rot90, flipH, flipV, angle`; `startCrop`/`commitCrop`/
  `discardCrop`/`onReset` include them. Committed `CropRect` carries them.
- **Box follows**: `onRotate(dir)` updates `rot90` and applies `rotateRectCW/CCW`
  to the draft rect (and swaps the oriented dims/nativeRatio used by the overlay);
  `onFlip(axis)` toggles the flag, mirrors the rect, and negates `angle`.
- **Effective dims** for the normal `Viewport` use `orient_dims(origW, origH,
  rot90)`; `Viewport` also receives `rot90/flipH/flipV/angle` (forwarded into the
  `ViewSpec` and `srcKey`).
- **Shortcuts** (`⌘/Ctrl+]` CW, `⌘/Ctrl+[` CCW) via the existing `svelte:window`
  keydown: in crop mode drive the draft; otherwise transform the **committed**
  crop (materializing a full-rect `CropRect` if none) and let the preview update.

### `Viewport.svelte`
Add `rot90`, `flipH`, `flipV`, `angle` props; include them in the `renderView`
`ViewSpec` and append to `srcKey` so a transform change re-fetches.

## Tests

- **Rust:** `orient` produces the expected pixel layout for each of the 8
  orientations on a known asymmetric 2×3 pattern; `orient_dims` swaps on 90°/270°;
  `rotate` is identity at 0° and a 90° angle matches `orient`’s single CW turn
  (within bilinear tolerance on interior pixels).
- **TS:** rect transforms — `rotateRectCW`×4 = identity, `flipRectH`×2 = identity,
  CW then CCW = identity; `constrainToRotated` — identity at 0°, all corners in
  bounds after constrain at a nonzero angle, centered shrink.
- **Manual smoke:** rotate CW/CCW (buttons + ⌘/Ctrl+]/[) turns the image and the
  crop follows; flips mirror; the straighten slider and hover-corner drag tilt the
  image live with the box constrained; commit → Edit view + export reflect every
  transform; per-image.

## Out of scope

- Auto-straighten (horizon detection).
- Perspective / lens corrections.
- GPU exposure/WB (deferred 2B).
