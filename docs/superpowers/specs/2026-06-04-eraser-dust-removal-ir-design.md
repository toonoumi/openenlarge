# Global IR Smart Dust Removal (Plan B) — Design

**Date:** 2026-06-04
**Branch:** `feat/develop-redesign`
**Status:** Design approved, ready for implementation plan
**Builds on:** Plan A (manual eraser brush) — `2026-06-04-eraser-dust-removal-design.md` /
`2026-06-04-eraser-dust-removal-manual-brush.md`. Reuses the `film_core::dust` inpaint engine and
the per-image `dustById` edit-state store.

## Scope

A one-toggle, automatic dust/scratch removal driven by the scan's **infrared (IR) plane** — the
"Digital ICE / iSRD" approach. Dust, hair, and scratches are opaque to infrared while film dyes are
transparent to it, so the IR channel yields a near-perfect defect mask "for free."

**Strictly IR-only.** For images **without** an IR plane (camera-scans, RAF, plain RGB TIFFs) we
provide **no** automatic removal — the "Remove dust (IR)" toggle stays disabled with the tooltip
*"Requires an infrared scan channel"* (already shipped in `EraserPanel.svelte` from Plan A). Those
users rely on the Plan A manual brush. Content-based (non-IR) auto-detection was considered and
**explicitly rejected** (false-positive-prone without the IR signal; not worth the precision cost).

## Data reality (verified)

`film_core::decode` only populates `Image.ir` when the source is a **4-channel image**:
`decode.rs:46` fills `ir` for `RGBA(8)`/`RGBA(16)` TIFFs (the 4th sample). `decode_raw` and 3-channel
TIFFs leave `ir: None`. So IR removal is available only for **SilverFast RGBI / 16-bit 4-channel
TIFF** exports. A real such file is required for final calibration; a CLI `--check-ir` command
(below) lets the user confirm a file carries IR.

## Architecture: carry IR through geometry, detect late

The IR-derived defect mask must align pixel-for-pixel with the image at the moment of inpainting.
The geometry functions (`proxy`, `orient`, `rotate`, `crop`, `resize_to`) currently **drop** `ir`
(set `ir: None`). The approach:

1. **Carry IR as a 4th channel through the geometry pipeline.** Each geometry function transforms
   `ir` alongside `pixels`:
   - `crop`, `orient` (flip_h / flip_v / rot90) — index remap (same mapping as pixels).
   - `rotate` (straighten), `resize_to`, `proxy` — scalar bilinear/area interpolation of the IR
     plane (mirrors the RGB resampling).
   Out-of-bounds IR (straighten corners) → `0.0` (treated as "defect"? no — see §Detection: we use
   a high baseline, and 0.0 corners would be flagged; mitigate by masking only within the image and
   ignoring straighten's black corners, which are already out-of-frame).
2. **Keep IR on the cached working buffer.** `develop_image` builds `working = proxy(&full, cap)`;
   with IR-aware `proxy`, `working.ir` survives, so the live preview has IR. `export_image`
   re-decodes full-res (IR native), so no caching needed there.
3. **Detect defects late, on the geometry-aligned IR.** In `render_view`/`export_image`, after
   `invert_image` produces `inv`, the transformed source IR (`scaled.ir` for preview, the oriented+
   cropped `full.ir` for export) is the **same dimensions as `inv`**. If IR-removal is enabled,
   build the defect mask from that IR, dilate, and **Telea-inpaint `inv` before finishing** — right
   beside the Plan A manual-stroke `dust::apply` call.

This keeps the geometry as the single source of truth for alignment; detection never has to
re-derive transforms.

## Detection algorithm

IR is ~uniformly **high where the film is clean** (dyes transparent to IR) and **low where a defect
blocks IR**. Detection (`film_core::dust::ir_defect_mask`):

- `clean = percentile(ir, 0.95)` over in-frame pixels — a robust "clean IR level" (defects are the
  minority, so a high percentile reflects clean film).
- `defect[i] = ir[i] < clean * t`, where `t ∈ [0.5, 0.95]` is derived from the UI **Sensitivity**
  slider (`sensitivity ∈ [0,100]`, default 50): higher sensitivity → higher `t` → flags fainter
  defects. Exact mapping: `t = 0.5 + 0.45 * (sensitivity / 100)`.
- Ignore straighten's out-of-frame black IR corners (IR exactly 0 at a pixel that is also RGB-black
  out-of-bounds): a pixel is only a candidate if it is within the rendered frame. In practice the
  view/export crop already excludes most; additionally skip pixels where `ir == 0.0 && rgb == 0`.
- **Dilate** the mask by 1px (cover defect edges), then a **single whole-frame Telea inpaint** over
  the full mask (`inpaint::telea_inpaint` handles arbitrary sparse masks). Returns a full-frame
  `Mask` (or applies in place).

**Calibration caveat:** the percentile and `t` range are first estimates; they will be tuned against
a real RGBI scan during implementation (the synthetic unit tests pin the *mechanism*, not the exact
constants).

**Performance:** whole-frame Telea runs at preview resolution live (cheap) and full-res once on
export. If full-res export proves slow, the optimization (deferred) is per-defect bounding-box
inpaint instead of whole-frame.

## State & UI

- **Edit state (per image, in `dustById`):** add `irRemoval: { enabled: boolean; sensitivity: number }`
  to `DustEdits` (alongside `strokes`). Default `{ enabled: false, sensitivity: 50 }`.
- **`has_ir` exposure:** the backend reports whether a developed image carries IR
  (`working.ir.is_some()`), surfaced on the image entry / via the develop result, stored client-side
  and passed to `EraserPanel`'s existing `hasIr` prop. The "Remove dust (IR)" toggle becomes enabled
  only when `hasIr` is true; otherwise it stays disabled with the existing tooltip.
- **EraserPanel:** the toggle drives `irRemoval.enabled`; a **Sensitivity** slider (0–100) drives
  `irRemoval.sensitivity`, both live — changing them re-runs detection via the same `dustRev`
  re-render trigger from Plan A (no re-develop).
- **Wire-through:** `irRemoval` flows to `render_view` (`ViewSpec`) and `export_image` like the
  strokes do.

## Pipeline order

In `render_view`/`export_image`, after `invert_image` → `inv`:
1. Plan A: `dust::apply(&mut inv, &manual_stamps)` (manual strokes).
2. Plan B: if `ir_removal.enabled` and source IR present → `dust::apply_ir(&mut inv, source_ir,
   sensitivity)` (detect + dilate + whole-frame inpaint).
3. Then `finish_image` (or return pre-finish for the GPU path).

Both dust passes operate on the linear inverted signal before finishing, so tone/finish apply
uniformly to healed and surrounding pixels.

## Testing

**Rust (`film-core`):**
- Geometry preserves/transforms IR: `crop`/`orient` index-remap the IR plane correctly; `rotate`/
  `resize_to`/`proxy` interpolate it (value range preserved, dims match pixels).
- `ir_defect_mask`: a planted low-IR speck on a high-IR field is flagged at a given sensitivity;
  clean field is not; higher sensitivity flags fainter defects.
- End-to-end: an `Image` with a synthetic IR plane + an RGB speck co-located with the low-IR pixel
  is healed by `apply_ir`.

**Rust (`src-tauri`):** `ViewSpec`/export deserialize `ir_removal`; `has_ir` reported correctly.

**TS (`app`):** `irRemoval` reducers (toggle enabled, set sensitivity); `hasIr` gates the toggle.

**CLI (`film-cli`):** `--check-ir <file>` prints the decoded channel count and whether an IR plane is
present, for real-file validation.

## Out of scope (Plan B)

- Content-based (non-IR) auto-detection — explicitly rejected.
- Mask-preview overlay ("show what IR flagged") — deferred; apply-and-see only.
- Per-defect bounding-box inpaint optimization — deferred unless full-res export is too slow.
- IR for RAW/raw-decoded files — IR only exists for 4-channel TIFFs.
