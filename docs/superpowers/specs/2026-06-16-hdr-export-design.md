# HDR Export — Design Spec

**Date:** 2026-06-16
**Status:** agreed design, ready for implementation plan
**Sub-project:** 2 of the HDR feature (sub-project 1 = HDR preview toggle, shipped; sub-project 3 = HDR-aware editing, later).
**Parent spec:** `docs/superpowers/specs/2026-06-16-hdr-design.md` (§8 scoped this).

---

## 1. Goal

When exporting, an image whose HDR toggle is on produces a **gain-map HDR JPEG** — the same look the in-app HDR preview shows — while every other image and every TIFF/PNG export is unchanged SDR.

## 2. Trigger / scope

- Export **honors the existing per-image `params.hdr` field**. There is **no new export UI** (decided with the user — the per-image preview toggle is the single source of truth).
- Gain-map HDR is **JPEG-only**. Rule: gain-map output happens **only when `format.kind === "jpeg"` AND that image's resolved `params.hdr === true`**. For TIFF/PNG, or any HDR-off image, export is exactly as today.
- A mixed batch yields a mix of gain-map `.jpg` and plain `.jpg`/`.tiff`/`.png` files. Filenames and extensions are unchanged — a gain-map file is still a `.jpg` (`outName(file, "jpeg")`).

## 3. Architecture / data flow

- HDR export uses a **CPU dual-render** path. The GPU export route (`export_begin`/`export_pixels`/`export_finish`) returns a single SDR readback; producing the second HDR rendition through it would need major plumbing for no quality gain. Export is not real-time, so a full-res CPU invert is acceptable — and the CPU path (`export_image`) already exists as the GPU fallback.
- New backend command **`export_image_hdr`** mirroring `export_image`'s signature. It:
  1. `ensure_resident`, read `path`, `dev.base`, `dev.thumb`, `dev.d_max`, `metadata` (same as `export_image`).
  2. `decode_any` full-res → `orient(rot90, flip_h, flip_v)` → `rotate(angle)` → optional `crop` (identical to `export_image`).
  3. Build `ip = resolve_params(&params, &thumb, effective_base(&params, base))`; `ip.d_max = effective_dmax(&params, dev_dmax)`.
  4. Render **twice** via a shared closure that does `invert_image` → `dust::apply(export_stamps)` → optional `dust::apply_ir` → `finish_image(&finish_from(&params))`:
     - `sdr = render(&ip)` (`ip.hdr == false`)
     - `let mut ip_hdr = ip.clone(); ip_hdr.hdr = true; hdr = render(&ip_hdr)`
     This mirrors `encode_hdr` (commands.rs:850-866) exactly, but on the full-res export image and using `export_stamps` (full-res dust mapping) instead of `view_stamps`.
  5. `let bytes = crate::hdr::encode_gain_map_jpeg(&sdr, &hdr, format.quality.unwrap_or(90))?;`
  6. Write `bytes` to `out_path`.
  7. Best-effort EXIF: `effective_metadata(&metadata, meta_override.as_ref())` → `crate::exif_write::write_exif(out, &eff)`; a failure is logged, never fails the export (same as `export_image`).
  Register the command in `lib.rs`.
- **Reuse:** the identical `invert_d` HDR expansion (`HDR_KNEE` 0.8 / `HDR_HEADROOM` 2.5) the preview uses, so the exported file matches what the user previewed. `encode_gain_map_jpeg` already exists and is unit-tested.
- **Frontend (`ExportModal.runExport`):** per image, compute the resolved params `p` (already done: `withEffectiveBase($editsById[img.id] ?? defaultParams(), …)`). If `kind === "jpeg" && p.hdr` → call `api.exportImageHdr(img.id, p, outPath, imageCrop, geom, d.strokes, d.irRemoval, format, metaOverride)` and skip the GPU branch entirely for that image. Otherwise the existing GPU-then-CPU logic is untouched.
- **API binding (`api.ts`):** add `exportImageHdr(...)` with the same argument shape as `exportImage`.

## 4. EXIF / metadata

Embed via the existing best-effort `write_exif` after encoding, exactly as SDR export does. Risk: a naive JPEG EXIF writer can corrupt the MPF / gain-map structure (gain-map JPEGs are multi-picture). Mitigation: a test asserting the gain map **survives** EXIF embedding (re-read the written file, assert the gain-map marker/metadata still present). If that test fails, the fallback is to embed EXIF into the SDR base *before* gain-map encoding instead of after; the plan includes this contingency.

## 5. Edge cases / errors

- **HDR-on + TIFF/PNG** → silently exports SDR. The HDR toggle simply has no effect on non-JPEG formats (decided with the user — no warning/flag needed).
- **Encoder failure** → propagates as a per-image failure, caught by the existing `try/catch` in `runExport` and counted in the modal's `failedCount`, like any other export error.
- **`max_bytes` (JPEG size cap)** is **not** applied to HDR exports — the gain-map encoder does not expose size targeting. Documented here so it is not mistaken for an honored setting.

## 6. Testing

- **Backend unit:** `export_image_hdr` writes a file whose bytes contain a gain map (assert the gain-map marker/metadata, like the existing `encode_gain_map_jpeg` test); a small synthetic developed image is sufficient.
- **EXIF-survives-gain-map:** write an HDR export with a `meta_override`, re-read the file, assert both the gain-map marker AND the embedded EXIF field are present.
- **Regression:** the HDR-off / non-JPEG export path is byte-unchanged (existing `export_image` tests stay green).
- **Frontend:** unit-test the branch selector — jpeg + hdr → HDR command; jpeg + no-hdr, tiff, png → existing path. (If the branch is a small extracted helper, test it directly; otherwise assert via the call shape.)

## 7. Out of scope (later / not needed)

- GPU HDR export path (CPU is sufficient and correct for export).
- HDR embedded in TIFF/PNG (gain-map is a JPEG construct).
- Gain-map size budgeting (`max_bytes` for HDR).
- Sub-project 3 — HDR-aware editing (exposure/whites/highlights/tone-curve operating into the headroom).

## 8. Key code references (verify before editing)

- `app/src-tauri/src/commands.rs` — `export_image` (950-1020) to mirror; `encode_hdr` (≈850-869) for the dual-render closure pattern; `effective_base`/`effective_dmax`/`resolve_params`/`finish_from`/`mode_from`/`export_stamps`/`effective_metadata`. Register `export_image_hdr` in `lib.rs`.
- `app/src-tauri/src/hdr.rs` — `encode_gain_map_jpeg(sdr, hdr, quality) -> Result<Vec<u8>, String>`.
- `app/src-tauri/src/exif_write.rs` — `write_exif`.
- `app/src/lib/export/ExportModal.svelte` — `runExport` per-image loop (185-240); the `kind`/`format` state.
- `app/src/lib/api.ts` — `exportImage` binding to mirror as `exportImageHdr`; `InvertParams` already has `hdr`.
