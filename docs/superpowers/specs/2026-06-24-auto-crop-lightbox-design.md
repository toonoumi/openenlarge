# Auto-crop on import — design

**Date:** 2026-06-24
**Status:** Implemented. **Pivoted** from lightbox-border trimming to film-strip
frame detection (see "Revision" below).

## Revision (2026-06-24): film-strip frame detection

The original design (below) assumed scans are a frame floating in a blown-white
lightbox/scanner border. GUI testing on the user's real scans (`~/Desktop/kevin`,
Sony ARW) showed they are **full-strip 35mm scans**: sprocket holes + dark film
rebate top/bottom, dark scan margins on the sides, and no blown-white border at
all (0% of pixels reached the white threshold). Per user decision, the
white-border detector was **replaced** (not augmented) with a film-strip frame
detector. Everything else (per-image, on-import, toast, `cropById` wiring,
Roll/Frame semantics) is unchanged from the original design.

**Signal (measured on the real files):** on a strip scan the sprocket rebate
bands read as rows/cols with a high **bright fraction** (clear holes punch bright
lightbox through), while the dark scan border beside the film reads as near-black
rows/cols. The photographic frame is the central region between them.

**Algorithm (`detect_film_frame_crop`, `crates/film-core/src/autocrop.rs`):**
- Per-row and per-col bright-fraction (luma > 0.5) and mean luma.
- Sprocket band per side = sprocket lines (bright-fraction ≥ 0.45) within the
  outer 35% of the axis; crop to the band's inner edge.
- Dark margin per side = contiguous near-black (mean ≤ 0.06) from the edge.
- Each side trims the deeper of its dark margin and — **only on an axis whose
  both ends carry a sprocket band** — its sprocket band. Gating sprocket-trim to
  the confirmed strip axis prevents bright FRAME content near a cross-axis edge
  (e.g. a blown sky on one side) from being mistaken for a rebate and
  over-cropping the width.
- **Strip fingerprint guard:** fire only when one axis has a sprocket band (each
  ≥ 3% thick) on BOTH ends — the unmistakable film-strip signature. Plus per-side
  trim < 40% and kept area ≥ 25%. Otherwise `None` (leave full-frame, no toast).
- Returns `Option<[f32; 4]>` (`[x,y,w,h]` normalized 0..1). Unchanged wiring:
  computed on the thumbnail proxy in `import_compute`, returned via
  `ImageEntry.auto_crop`, applied to `cropById` on the frontend with the
  `toast.frameTrimmed` toast.

**Validated** against all four `kevin` ARWs by rendering the detected crop: 776
tight/accurate, 799 & 811 full frame with sprockets+margins excluded, 774 (an odd
half-blank between-frames exposure) correctly excludes the sprocket bands. Tuning
knobs if it misfires on other rolls: `BF_SPROCKET`, `DARK_T`, `REBATE_ZONE`,
`MAX_TRIM`.

---

_Original design (white-border approach — superseded by the revision above):_

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
