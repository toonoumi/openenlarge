# Batch Export — Design

**Date:** 2026-06-04
**Status:** Approved (design)

## Problem

Export today is a single "Export 16-bit TIFF" button in the Develop right panel
(`Develop.svelte` → `export_image` → `film_core::export::write_tiff16`). It exports
only the active image, only as 16-bit TIFF, with no format/quality choice. We want a
proper batch export: pick many images, choose a format, and write them all to a folder.

## Goals

- Move export out of the Develop panel into a top-nav **Export** button (right of Develop).
- The button opens a modal listing **all already-developed images**, all selected by default.
- Multi-select with single / Ctrl(⌘) / Shift-range click, plus a Select/Deselect-all toggle.
- Choose output format: **JPEG**, **TIFF**, **PNG**.
  - **JPEG:** quality slider (1–100) + independent max-file-size slider; size wins when
    they conflict (encoder drops quality to fit under the cap).
  - **TIFF / PNG:** 8-bit / 16-bit dropdown.
- Export button asks for a destination folder, then writes every selected image with **its
  own** per-image develop edits applied, named `<original-stem>.<ext>`.

## Non-Goals

- Exporting undeveloped images (they don't appear in the list; develop them first).
- Per-image format overrides (format/bit-depth/quality is one global setting for the batch).
- Filename-collision UX beyond silent overwrite.

## Architecture

**Approach A — frontend orchestrates the loop** (chosen over a backend batch command).
The frontend already owns all per-image edits in stores (`editsById`, `cropById`,
`dustById`), so it loops the selected ids and calls a generalized export command once per
file. This reuses the exact wiring `Develop.svelte` uses today, makes progress a trivial
`done/total` counter, and avoids re-plumbing every per-image edit + Tauri progress events
across the IPC boundary. One IPC call per image is negligible for a folder of scans.

The real new backend work (format encoders) is identical regardless of where the loop lives.

### Components

**1. Nav + entry point — `app/src/routes/+page.svelte`**
- Add an **Export** nav button right of Develop, enabled only when ≥1 image is developed
  (new `developedCount` derived store, or reuse `images` filtered by `.developed`).
- Clicking sets a local `exporting=true` that mounts `<ExportModal>` (overlay sibling of
  `ProgressOverlay` / `ConfirmDevelop`).
- Remove the old `.export` button + `exportTiff()` + `save` import from `Develop.svelte`.

**2. `app/src/lib/export/ExportModal.svelte`** — overlay with two regions:
- *Image picker:* grid of developed images (thumbnail + filename). All selected initially.
  - Select/Deselect-all toggle.
  - Selection model (`app/src/lib/export/selection.ts`, unit-tested):
    - plain click → select only that image (anchor = it)
    - ⌘/Ctrl-click → toggle that image (anchor = it)
    - Shift-click → select contiguous range from anchor to clicked (over the displayed order)
  - Selected items show a highlight ring + check.
- *Format panel:*
  - Format dropdown: JPEG / TIFF / PNG.
  - TIFF or PNG → Bit-depth dropdown (8 / 16). Hidden for JPEG.
  - JPEG → Quality slider (1–100) + Max-size slider (e.g. 0.5–20 MB plus an "off"/unlimited
    end). Bit-depth dropdown hidden.
  - **Export** button (disabled when selection is empty) → native directory picker
    (`open({ directory: true })`).

**3. Export flow (frontend, in ExportModal)**
For each selected id, gather the same inputs `Develop.svelte` passes:
- params: `editsById[id]` (fallback default)
- crop + geom: `cropById[id]` → `imageCrop` + `{ rot90, flip_h, flip_v, angle }`
- dust: `dustById[id]` → `strokes` + `irRemoval`

Build `outPath = <folder>/<stem>.<ext>` (stem from the original filename; ext per format).
Call `api.exportImage(...)` with a new trailing `format` arg:
```
format: { kind: "jpeg" | "tiff" | "png",
          bitDepth?: 8 | 16,        // tiff/png only
          quality?: number,         // jpeg only, 1–100
          maxBytes?: number | null } // jpeg only
```
Track `done/total`; show a summary at the end (`N exported`, plus any per-image failures).
A failed image is caught and reported, never aborts the batch. Collisions overwrite.

Filename helper `app/src/lib/export/naming.ts` (unit-tested): map original name → `<stem>.<ext>`.

**4. Backend — `app/src-tauri/src/commands.rs` + `crates/film-core/src/export.rs`**
- Extend `export_image` to accept the `format` spec (serde struct mirroring the JS arg)
  instead of always writing 16-bit TIFF. After producing the finished full-res `Image`,
  dispatch on `format.kind`:
  - TIFF → `write_tiff16` (exists) or new `write_tiff8`
  - PNG → new `write_png8` / `write_png16` (via the `image` crate, already a dependency)
  - JPEG → new `write_jpeg(img, path, quality, max_bytes)`:
    encode at `quality`; if `max_bytes` is `Some` and the encoded size exceeds it,
    binary-search quality downward to the largest value that fits (floor at quality 1).

## Data flow

```
ExportModal (selected ids, global format)
  └─ for each id:
       editsById[id], cropById[id], dustById[id]  ──► api.exportImage(id, params, outPath,
                                                          imageCrop, geom, dust, irRemoval, format)
                                                      └─ export_image (Rust): decode full-res →
                                                         orient → rotate → crop → invert → dust →
                                                         ir → finish → encode(format) → write file
```

## Error handling

- Export button disabled when selection empty.
- Per-image errors caught in the loop, collected, shown in the final summary; batch continues.
- JPEG never offers a bit-depth (8-bit only) — enforced by the UI gating.
- 16-bit JPEG is impossible and unreachable (dropdown only renders for TIFF/PNG).
- Filename collisions overwrite silently (predictable; documented).

## Testing

**film-core (`export.rs`):**
- Round-trip / smoke tests: `write_tiff8`, `write_png8`, `write_png16` produce decodable files
  of correct dimensions and approximate pixel values.
- `write_jpeg`: higher quality ⇒ ≥ file size (monotonic); with `max_bytes` set, output is
  ≤ cap and uses the largest fitting quality; impossible cap falls back to quality 1.

**Frontend (vitest):**
- `selection.ts`: single / ctrl-toggle / shift-range / select-all / deselect-all behaviors.
- `naming.ts`: `photo.dng` + jpeg → `photo.jpg`; tiff → `.tiff`; png → `.png`; preserves stem.
- Format→options gating: bit-depth shown for tiff/png, hidden for jpeg; quality+size shown
  only for jpeg.

## Build / run notes

- `source "$HOME/.cargo/env"` before any cargo command in this environment.
- Test commands: `cargo test -p film-core`, `cargo test` (src-tauri), `npm run test` /
  `svelte-check` in `app/`.
