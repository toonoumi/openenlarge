# Local Upscaler — Design Spec

Date: 2026-06-16
Status: Approved (pending implementation plan)

## Summary

Add a **local, offline image super-resolution (upscaling)** feature to filmrev
(OpenEnlarge). It appears as a new standalone editor tool — `upscale` — placed
immediately after the AI Enhance tool. It runs a Real-ESRGAN model on-device via
the ONNX Runtime (`ort` Rust crate), upscales the current developed image, caps
output at **8K on the longest side**, shows a before/after preview, and saves a
full-resolution upscaled file.

The runtime + model are **downloaded on first use** (not bundled), gated behind a
download popup with a progress bar inside the tool.

## Decisions (from brainstorming)

- **Engine:** ONNX Runtime via the `ort` Rust crate. Chosen for guaranteed **CPU
  fallback on every platform** plus GPU acceleration without per-vendor binaries
  (CoreML on macOS, DirectML on Windows). Runs Real-ESRGAN ONNX in-process.
- **Model:** `realesr-general-x4v3` (~5 MB, BSD-3, general/photographic).
  Optionally offer the larger `RealESRGAN_x4plus` as a later download — out of
  scope for v1.
  - **Denoise note:** Real-ESRGAN's `-dn` denoise strength is NOT a free
    parameter on one model — it interpolates between the standard model and a
    `wdn` (weak-denoise) variant, i.e. it needs a second `.onnx` and weight
    blending. v1 ships a single model at fixed strength; an exposed denoise
    slider is an explicit **stretch goal** that requires bundling the `wdn`
    variant too. Do not assume a single model yields a denoise control.
- **Placement:** a standalone `upscale` tool (like AI Enhance), operating on the
  **full-resolution developed image**, producing a **saved file**.
- **Distribution:** **download on first use.** Entering the tool checks install
  status; if missing, a popup shows the download size, a Download button, a live
  progress bar, then a Next button once verified. The runtime lives in the
  app-data dir (outside the signed `.app` bundle).
- **8K policy:** model is fixed 4×; target longest side = `min(4 × inputLongest,
  8192)`; feed the model an input downscaled to `target / 4`.

## Reality / Constraints (read first)

- `ort` 2.x is still a **release candidate** (stable-ish API but not frozen) —
  pin the exact version (e.g. `ort = "=2.0.0-rc.12"`).
- Microsoft's official `libonnxruntime.dylib` ships **unsigned**. Because we
  download it into app-data (outside the bundle) and `dlopen` it, macOS Hardened
  Runtime library validation requires it to be signed by the **same team**. We
  therefore **re-sign the macOS dylib with the app's Developer ID once, when
  hosting it** as a release asset. This avoids both bundle re-notarization and
  the `disable-library-validation` entitlement.
- Real-ESRGAN adds resolution only for **small** sources. For sources already
  ≥8K on the longest side, upscaling cannot add real detail — the tool informs
  the user instead of degrading the image.
- 8K output requires **tiled inference** (split → infer → stitch with overlap)
  to bound memory, plus a progress indicator. On CPU it can be slow.

## Architecture

### Backend — `app/src-tauri/src/upscale/` (new module folder)

A self-contained module; the only place that knows about ONNX/`ort`, the model,
and the download assets. This is the clean seam (mirrors how `ai_enhance.rs`
isolates the cloud provider).

- **`assets.rs`** — asset management:
  - Resolve the upscaler dir under the Tauri `app_data_dir` (e.g.
    `<app_data>/upscaler/`).
  - A compile-time **manifest** mapping the current platform (target os/arch) to
    its required assets: the ONNX Runtime shared library and the model `.onnx`,
    each with a download URL, expected SHA-256, and byte size. Assets are hosted
    as GitHub release assets.
  - `status()` → whether all required assets are present and checksum-valid.
  - `download(progress)` → stream each asset via `reqwest` to a temp file,
    report cumulative progress, verify SHA-256, then atomically move into place.
    A mismatch is an error (no partial install left behind).
- **`engine.rs`** — inference:
  - Initialize `ort` via **`load-dynamic`** pointed at the downloaded runtime
    library (`ORT_DYLIB_PATH` / `ort` dynamic init).
  - Register execution providers per platform: CoreML (macOS), DirectML
    (Windows), with **CPU as the guaranteed fallback** if a GPU EP fails to
    register.
  - `upscale_rgb(input: &Image, tile, overlap) -> Image` — tiled 4× inference:
    split the input into tiles with `overlap` padding, run each through the
    session, crop the padding, and stitch into the 4× result. Pure given a
    session; tile/stitch coordinate math is unit-testable independently.
- **`mod.rs`** — orchestration:
  - `target_dims(in_w, in_h) -> (out_w, out_h)` — pure function implementing the
    8K cap policy: `outLong = min(4*inLong, 8192)`; preserve aspect.
  - Produce a finished proxy of the developed image at `target/4` longest side
    via the existing develop/finish pipeline (NOT the on-screen JPEG).
  - Run `engine::upscale_rgb`, then if the 4× result exceeds the 8K cap,
    Lanczos-downscale to the cap.
  - Stash the full-res result (for saving) and return a downscaled preview data
    URL for the panel.

- **Commands** (registered in `lib.rs`):
  - `upscaler_status() -> { installed: bool, download_bytes: u64 }`
  - `download_upscaler(on_progress: Channel<DownloadProgress>) -> Result<(),String>`
    where `DownloadProgress = { received: u64, total: u64 }`.
  - `upscale_image(id, params, geom, denoise, on_progress: Channel<UpscaleProgress>)
    -> Result<UpscaleResult, String>` where `UpscaleResult = { preview_data_url,
    out_w, out_h }`; the full-res result is stashed in session state.
  - `save_upscaled(out_path: String, format: ExportFormat) -> Result<(), String>`
    — encodes the stashed full-res result to the chosen path (reusing the
    existing encoders), embedding EXIF as the export path does.

### Frontend — Svelte 5 + TS

- **`app/src/lib/develop/UpscalePanel.svelte`** — the tool panel:
  - On display, calls `api.upscalerStatus()`. If not installed, renders the
    download gate; otherwise the main upscale UI.
  - **Download gate** (inline sub-view or small component
    `UpscalerDownload.svelte`): shows size, a Download button, a progress bar fed
    by the `download_upscaler` channel, and a **Next** button on completion that
    flips to the main UI and sets `upscalerInstalled = true`.
  - **Main UI:** computed target output size (from current image dims, capped
    8K); a denoise slider; an **Upscale** button → inference progress bar →
    result preview (before/after hold-toggle + click-to-enlarge, mirroring
    AiEnhancePanel) → a **Save…** button that opens the native save dialog and
    calls `api.saveUpscaled(path, format)`.
  - If the source is already ≥8K on the longest side, show an informational note
    and disable (or warn before) upscaling.
- **`app/src/lib/develop/Toolbar.svelte`** — add the `upscale` tool after
  `enhance`. Add a suitable icon to `Icon.svelte` (e.g. a "scale/expand" glyph).
- **`app/src/lib/tabs/Develop.svelte`** — import + render `UpscalePanel` under
  `$tool === "upscale"`.
- **`app/src/lib/store.ts`** — add `"upscale"` to the `Tool` union and an
  `upscalerInstalled` writable (session-scoped; re-checked from `status()`).
- **`app/src/lib/api.ts`** — bindings for the four commands, using a Tauri
  `Channel` for the two progress-reporting calls.
- **i18n** — new strings added to `/i18n-strings.csv` and regenerated via
  `scripts/gen-i18n.py` (never hand-edit `dict.ts`).

### Release / distribution

- Host four assets per release (or a pinned shared release): macOS arm64
  **re-signed** ONNX Runtime dylib, Windows runtime DLL (+ `DirectML.dll`), Linux
  `.so`, and the `realesr-general-x4v3.onnx` model — with a checksum manifest the
  app's compile-time manifest references.
- The `cut-release` skill/flow gains a documented step to publish/refresh these
  assets and the re-signed macOS dylib. Installer size is unchanged (assets are
  downloaded, not bundled).
- `Cargo.toml`: add `ort` (pinned, `load-dynamic`) and a resampling crate if
  needed for high-quality downscale (the project already uses `image` with
  Triangle; Lanczos via `image` or `fast_image_resize` is acceptable).

## Data flow

1. User selects the `upscale` tool.
2. `upscaler_status()` → if not installed, download gate; user downloads
   (progress via channel), assets verified, Next → main UI.
3. Main UI computes target size from current image dims (capped 8K).
4. User clicks Upscale → `upscale_image(...)`: backend renders a finished proxy
   at `target/4`, runs tiled 4× inference (GPU EP or CPU), caps to 8K, stashes
   full-res, returns a preview data URL (progress via channel).
5. Panel shows before/after preview.
6. User clicks Save… → native dialog → `save_upscaled(path, format)` encodes the
   stashed full-res result to disk with EXIF.

## Error handling

- GPU/EP registration failure → automatic CPU fallback (no user-visible failure).
- Download failure / SHA-256 mismatch → readable error in the gate; no partial
  install; user can retry.
- Source already ≥8K longest side → informational note; upscaling offers no gain.
- Inference out-of-memory → reduce tile size and/or surface a readable message.
- Missing/corrupt model at upscale time → re-trigger the download gate.

## Testing

- **Rust unit tests** (no runtime, no network):
  - `target_dims` 8K-cap / scale math across representative input sizes.
  - Per-platform asset selection from the manifest.
  - SHA-256 verification (match + mismatch).
  - Tile/stitch coordinate geometry (coverage, overlap cropping, edge tiles).
- **Manual verification:** real download, real inference on GPU and forced-CPU,
  the 8K cap on a small vs. large source, and the saved-file output.
- **Frontend:** thin glue (status check, channel-driven progress, save dialog) —
  verified manually.

## Out of scope (YAGNI)

- Bundling the runtime/model in the installer.
- The larger `x4plus` model and a model picker (possible later download).
- Batch upscaling across multiple images.
- CUDA/TensorRT execution providers.
- Upscaling as an inline Export option (this is a standalone tool that saves a
  file; Export integration can come later if desired).
- An in-app uninstall/cleanup UI for the downloaded assets.

## i18n note

Per project convention, user-facing strings are generated from
`/i18n-strings.csv` via `scripts/gen-i18n.py` — never edit `dict.ts` directly.
New strings for this feature follow that workflow.
