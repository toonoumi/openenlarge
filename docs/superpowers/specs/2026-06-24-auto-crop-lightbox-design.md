# Auto-trim lightbox border on import — design

**Date:** 2026-06-24
**Status:** Approved, ready for implementation plan

## Problem

When users import film scans, the frame is often surrounded by bright,
blown-out backlight: a lightbox border (DSLR/lightbox scans) or a white
scanner background (flatbed scans). That white surround is not part of the
image and should be trimmed away so the frame fills the crop.

We want this to happen automatically on import, with zero clicks, while never
misfiring on images that legitimately have no lightbox border.

## Scope

In scope:
- DSLR/lightbox scans (RAW; the camera's embedded preview shows the negative on
  a blown-white lightbox).
- Flatbed scans on a white background (TIFF/JPEG/PNG).

Out of scope (must not misfire):
- Already-inverted / positive images, or any image whose bright edge is real
  content (e.g. a white sky touching the frame edge). These must be left
  full-frame with no toast.

Non-goals:
- No manual "Auto" re-trigger button. If detection is wrong, the user adjusts
  the crop by hand: in **Frame** for one image, in **Roll** for the whole roll
  (existing Roll-vs-Frame editing semantics, untouched).

## Behavior

- Auto-crop is computed **per-image** on import — each scan's border is detected
  independently, since lightbox borders sit differently per frame.
- When detection succeeds, the image's initial `CropRect` is set to the detected
  rectangle and a toast shows: **"Lightbox detected, automatically trimming"**.
- The crop is fully editable afterward — auto-crop only sets the initial rect; it
  is not destructive.
- When detection fails the guards, the image stays full-frame and no toast shows.

## Architecture

### 1. Detection — `crates/film-core/src/autocrop.rs` (new, pure)

```
fn detect_lightbox_crop(img: &Image) -> Option<Rect>
```

`Rect` is the normalized `{ x, y, w, h }` in 0..1 (matches the frontend crop
model). Operates on the thumbnail-resolution RGB image that import already
decodes, so it is cheap and resolution-independent.

Algorithm:
1. A pixel is "white" when all three channels are near-max (≈ > 0.92 of full
   scale).
2. Scan inward from each of the four edges. A border row/column counts as a
   white margin when its white-pixel fraction is very high (≈ > 0.95). The first
   non-margin row/column from each side defines the content bounding box.
3. Emit the bounding box as a normalized `Rect`.

Guards — **all** must hold, otherwise return `None`:
- White margin present on **all four** sides (a closing frame, not a single
  bright edge).
- The border is **near-pure-white and low-variance** (rejects gradient skies and
  textured bright content).
- Each side trims **< 25%** and the kept area stays **> ~50%** (rejects runaway
  crops; if it wants to eat half the image, bail).

Design principle: **when in doubt, do not crop.**

Pure function → unit-tested with synthetic images:
- gray box inside a white border → detects the box.
- gradient "sky" bright at one edge → bails (not a 4-sided flat border).
- full-frame image with no border → bails.
- border that would trim > 25% per side → bails.

### 2. Wiring — `app/src-tauri/src/commands.rs`

- `import_compute` already decodes `preview: film_core::Image` for the relevant
  formats. After decoding, call `detect_lightbox_crop(&preview)` and thread the
  resulting `Option<Rect>` back out through `import_image`.
- Add an optional field `auto_crop: Option<Rect>` to the `ImageEntry` returned by
  `import_image` (serialized to the frontend).

### 3. Frontend — import flow + i18n

- Where `api.importImage` resolves, if `entry.auto_crop` is set:
  - Build a default `CropRect`: `{ rect: auto_crop, aspect: <full/default>,
    orientation: <from rect>, rot90: 0, flipH: false, flipV: false, angle: 0 }`.
  - Set `cropById[id]` and persist via the existing `saveCrop` path.
  - Show the toast.
- Add a new i18n string "Lightbox detected, automatically trimming" by editing
  `i18n-strings.csv` and running `scripts/gen-i18n.py` (never edit `dict.ts`
  directly — regeneration wipes hand-added keys).

## Data flow

```
import_image (Rust)
  └─ import_compute: decode preview thumbnail
       └─ detect_lightbox_crop(&preview) -> Option<Rect>
  └─ ImageEntry { ..., auto_crop: Option<Rect> }  ──► frontend import flow
       └─ if Some: wrap into CropRect, set cropById, saveCrop, toast
```

## Testing

- Unit tests for `detect_lightbox_crop` (synthetic images, above).
- Manual GUI smoke: import a lightbox scan (crop trims to frame + toast), a
  flatbed-on-white scan (same), and an already-positive image with a bright sky
  (no crop, no toast).

## Edge cases

- RAW embedded preview is the camera's render of the negative — the lightbox is
  still blown white there, so detection works on it.
- Formats that fall back to the 1×1 placeholder (undecodable) yield no `preview`
  → no detection, no crop.
- Degenerate detected rects (zero/near-zero area) are rejected by the guards.
