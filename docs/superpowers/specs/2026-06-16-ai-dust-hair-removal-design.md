# One-Click AI Dust & Hair Removal — Design

**Date:** 2026-06-16
**Status:** Approved (brainstorm), pending spec review
**Area:** Develop → Eraser panel; new `autodust` backend module

## Summary

Add a one-click feature to the Eraser section that uses local neural models to
automatically detect every dust speck and hair across the whole frame and fill
them — no manual brushing. Two stages, both running locally via the existing
ONNX Runtime (`ort`) path that already powers Upscale:

1. **Detect** — a learned segmentation net (U-Net) runs on the positive image
   and outputs a defect probability map → thresholded into a `Mask`.
2. **Fill** — a learned inpainting net (MI-GAN) reconstructs the masked regions.

This is the IR dust-removal pattern (`dust::apply_ir`: detect → inpaint) but
driven by the visible image and neural models instead of an infrared plane.

## Decisions (locked during brainstorm)

- **Use case:** whole-frame auto removal of dust + hairs (not a smarter brush).
- **Control:** one button + a Sensitivity slider with instant re-apply, plus an
  On/Off toggle. Mirrors the existing IR sensitivity control.
- **Detection:** a learned detector net (ONNX), not classical CV — chosen with
  the domain-mismatch risk understood (see Risks). Model is swappable.
- **Fill:** a learned inpainter (MI-GAN ONNX), not Telea.

## User Experience

A new block in `EraserPanel.svelte`: **"Auto Remove Dust & Hair · AI"** with the
`Local` badge used by Upscale.

- **First use** shows a download gate (`~NN MB`), reusing Upscale's gate flow.
  The ONNX runtime dylib is already shared with Upscale, so only the two model
  files download.
- **Detect & Remove** button: runs detection once, fills all defects, viewport
  updates. Shows a count ("142 spots removed") for confidence.
- After detection: a **Sensitivity** slider (0–100) and an **On/Off** toggle.
  Moving the slider re-applies instantly (re-threshold + re-fill from cache; see
  Performance). **Reset** clears the result.

## Architecture

New backend module `app/src-tauri/src/autodust/`, mirroring `upscale/`:

- `assets.rs` — download/verify the two model files (detector + inpainter) with
  the same SHA-256 + gate pattern. Runtime dylib reused from Upscale.
- `engine.rs` — tiled inference for both nets (reuse the `plan_tiles` tiling
  from the upscaler). Detector → single-channel probability map at image res.
  Inpainter → RGB fill, run only on tiles that contain masked pixels.
- `mod.rs` — orchestration plus the threshold/dilate/size-gate step that turns
  the probability map into a `film_core::dust::Mask`.

All ONNX/model logic stays inside this module; the rest of the app only sees new
commands in `commands.rs`. Swapping a model later = change `assets.rs`/`engine.rs`.

## Detection → Mask → Fill pipeline

1. **Detect** on the **positive (finished/inverted) image** — the model expects
   photo-like input, not a negative. No geometry changes between positive and
   the working buffer, so the mask maps 1:1 onto the working buffer coords.
2. **Threshold** the probability map (driven by Sensitivity), **dilate** slightly
   to cover defect edges, and **size-gate** to drop implausibly large regions so
   it cannot eat a whole sky/face. Result: a `Mask`.
3. **Fill** with the MI-GAN inpainter: feed image + mask, tile over regions that
   contain masked pixels (skip clean tiles for speed), paste results back.
4. Hooks into the same bake/preview/export points as `apply_ir`, as a third heal
   source alongside manual stamps and IR removal.

## Performance model

The nets are expensive and must NOT run on every bake or slider tick.

- **Detect & Remove** runs the detector once and caches the **probability map**
  in the session (like `pending_upscale` is stashed).
- The **Sensitivity** slider re-thresholds the cached map and re-runs only the
  fill — no detector re-inference. (If fill latency is noticeable, debounce the
  slider; fill is restricted to masked tiles so it stays bounded.)
- **Export** re-runs the full pipeline once (user-initiated heavy op) or reuses
  the cached map if present.

## Asset download gate

Reuse Upscale's gate verbatim in style:

- Commands: `autodust_status` (installed? + download bytes) and
  `download_autodust`.
- Event: `autodust://download-progress`.
- A small Svelte gate identical to `UpscalePanel`'s download section.
- Two model assets (detector + inpainter), runtime dylib shared with Upscale.

## State, i18n, persistence

- `store.ts`: per-image `autoDust: { enabled: boolean; sensitivity: number }`,
  plus an `autodustInstalled` store mirroring `upscalerInstalled`.
- i18n: new `eraser.auto*` keys added via `i18n-strings.csv` +
  `scripts/gen-i18n.py`. Never hand-edit `dict.ts`.
- Persistence v1: the `enabled` flag + `sensitivity` persist with the edit. The
  detected mask/probability map is derived data cached in-session and recomputed
  on demand (re-open / export). Persisting the map is a future optimization.

## Risks & required validation spike

The chosen learned-detector route carries a **domain-mismatch risk**: candidate
detectors (e.g. the scratch/dust U-Net from Microsoft's *Bringing Old Photos
Back to Life*, ONNX-exportable) were trained on damaged old photos, not clean
film grain — they may miss fine dust or over-flag grain. MI-GAN as inpainter is
well-proven for small/medium masks.

Therefore implementation **starts with Phase 0, a model-validation spike**:

1. Export candidate detector + MI-GAN to ONNX.
2. Run them on a handful of real scans via the `ort` path (no UI yet).
3. Eyeball masks and fills. If the detector underperforms, swap the asset or
   fall back to classical CV detection — no architecture change required.

Only after the spike passes do we build the asset gate, commands, and UI.

**Model licenses must be verified before shipping** (a release task), same as
the upscaler model.

## Scope / non-goals (v1)

In scope:
- One-click whole-frame auto detect (learned net) + AI inpaint fill (MI-GAN).
- Sensitivity slider, On/Off toggle, Reset, download gate, removed-count readout.

Out of scope (future):
- Reviewable/editable mask overlay (toggle individual false hits).
- Persisting the computed mask across sessions.
- A classical-CV detector mode (kept as a fallback option only).
- Changes to the existing manual brush or IR removal paths.

## Testing

- `film-core`/`autodust` unit tests: threshold + dilate + size-gate produce the
  expected `Mask` from a synthetic probability map; tile selection skips clean
  tiles; mask→working-buffer coordinate mapping is 1:1.
- Reuse `plan_tiles` tests already covering tiling correctness.
- Manual validation per the Phase 0 spike on real scans before UI work.
