# Local Upscaler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone, offline "Upscale" editor tool that super-resolves the current developed image with a local Real-ESRGAN model (via the `ort` ONNX Runtime crate), capped at 8K on the longest side, with a download-on-first-use gate and a save-to-file action.

**Architecture:** A self-contained Rust module `app/src-tauri/src/upscale/` owns all ONNX/model/download logic (the seam). It reuses a `finish_full_res` helper extracted from `export_image` to get finished pixels, downscales to `target/4`, runs tiled 4× inference, caps to 8K, stashes the full-res result in `Session`, and returns a preview. Backend→frontend progress uses Tauri **events** (the existing `tether.rs` pattern). The frontend adds an `upscale` tool whose panel shows a download gate then the upscale UI. Runtime + model are downloaded into app-data on first use (not bundled), so the signed `.app` bundle is unaffected.

**Tech Stack:** Tauri 2, Rust (`ort` 2.x ONNX Runtime, `reqwest` streaming, `sha2`, `ndarray`, `image`), Svelte 5 + TS, Real-ESRGAN `realesr-general-x4v3` ONNX.

---

## File Structure

**Rust (backend)**
- Create: `app/src-tauri/src/upscale/mod.rs` — orchestration + `target_dims` pure fn + `pending_upscale` result type. Public entry the commands call.
- Create: `app/src-tauri/src/upscale/assets.rs` — asset dir, per-platform manifest, `status()`, SHA-256 verify, streaming download with progress events.
- Create: `app/src-tauri/src/upscale/engine.rs` — `ort` session init (load-dynamic, EP selection) + tiled inference + tile-geometry pure fns.
- Modify: `app/src-tauri/src/commands.rs` — extract `finish_full_res` helper from `export_image`; add 4 upscale commands.
- Modify: `app/src-tauri/src/session.rs` — add `pending_upscale` field + result struct.
- Modify: `app/src-tauri/src/lib.rs` — `mod upscale;` + register commands.
- Modify: `app/src-tauri/Cargo.toml` — add `ort`, `sha2`, `ndarray`.

**Frontend**
- Modify: `app/src/lib/api.ts` — 4 bindings + an event-subscribe helper.
- Modify: `app/src/lib/store.ts` — `"upscale"` in `Tool` union + `upscalerInstalled` store.
- Create: `app/src/lib/develop/UpscalePanel.svelte` — download gate + upscale UI + preview + save.
- Modify: `app/src/lib/develop/Toolbar.svelte` — `upscale` tool after `enhance`.
- Modify: `app/src/lib/icons/Icon.svelte` — a `maximize` (expand) icon.
- Modify: `app/src/lib/tabs/Develop.svelte` — import + render `UpscalePanel`.
- Modify: `i18n-strings.csv` — new strings (regenerated to `dict.ts`).

**Release**
- Modify: `docs/superpowers/` release notes / `cut-release` doc — host assets + re-sign macOS dylib + fill manifest constants.

---

## Task 1: Upscale module skeleton + `target_dims` 8K-cap math (TDD)

**Files:**
- Create: `app/src-tauri/src/upscale/mod.rs`
- Modify: `app/src-tauri/src/lib.rs:1-11`
- Modify: `app/src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies**

In `app/src-tauri/Cargo.toml` `[dependencies]` (after `ultrahdr = "0.1"`), add:

```toml
ort = { version = "=2.0.0-rc.12", default-features = false, features = ["load-dynamic", "ndarray"] }
ndarray = "0.16"
sha2 = "0.10"
```

(`load-dynamic` means the ONNX Runtime native lib is `dlopen`ed at runtime from a path we set — nothing is linked or bundled at build time, so the signed bundle and notarization are unaffected. `ndarray` 0.16 already matches `film-core`. Pin `ort` exactly — 2.x is RC. Execution-provider features like `coreml`/`directml` are added per-platform in Task 3.)

- [ ] **Step 2: Write the failing test for `target_dims`**

Create `app/src-tauri/src/upscale/mod.rs`:

```rust
//! Local image upscaling (Real-ESRGAN via ONNX Runtime). ALL ONNX/model/download
//! logic lives under this module — the rest of the app only sees the commands in
//! `commands.rs`. To swap the model or engine later, change `engine.rs`/`assets.rs`.

pub mod assets;
pub mod engine;

/// Longest-side cap for upscaled output.
pub const MAX_OUTPUT_EDGE: u32 = 8192;
/// Fixed scale factor of the bundled Real-ESRGAN model.
pub const MODEL_SCALE: u32 = 4;

/// Decide the upscale target for a source of `in_w` x `in_h`.
///
/// Returns `Some((feed_w, feed_h, out_w, out_h))` when upscaling is beneficial:
/// `out` longest = min(MODEL_SCALE * in_long, MAX_OUTPUT_EDGE), and `feed` is the
/// input downscaled to `out/MODEL_SCALE` so the fixed-4x model lands on `out`.
/// Returns `None` when the source is already at/over the cap (nothing to gain).
pub fn target_dims(in_w: u32, in_h: u32) -> Option<(u32, u32, u32, u32)> {
    let in_long = in_w.max(in_h);
    if in_long == 0 || in_long >= MAX_OUTPUT_EDGE {
        return None;
    }
    let out_long = (MODEL_SCALE * in_long).min(MAX_OUTPUT_EDGE);
    let feed_long = out_long / MODEL_SCALE; // <= 2048
    let scale = |v: u32| -> u32 { ((v as u64 * feed_long as u64) / in_long as u64).max(1) as u32 };
    let feed_w = scale(in_w);
    let feed_h = scale(in_h);
    let out_w = feed_w * MODEL_SCALE;
    let out_h = feed_h * MODEL_SCALE;
    Some((feed_w, feed_h, out_w, out_h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_source_upscales_4x() {
        // 1000x667 -> feed unchanged (1000<=2048) -> out 4000x2668
        assert_eq!(target_dims(1000, 667), Some((1000, 667, 4000, 2668)));
    }

    #[test]
    fn caps_output_at_8k_longest() {
        // 3000 long -> out capped 8192 -> feed 2048 long
        let (fw, fh, ow, oh) = target_dims(3000, 2000).unwrap();
        assert!(ow.max(oh) <= MAX_OUTPUT_EDGE);
        assert_eq!(fw.max(fh), 2048);
        assert_eq!(ow, fw * 4);
        assert_eq!(oh, fh * 4);
    }

    #[test]
    fn source_at_or_over_cap_is_noop() {
        assert_eq!(target_dims(8192, 5000), None);
        assert_eq!(target_dims(9000, 9000), None);
        assert_eq!(target_dims(0, 0), None);
    }

    #[test]
    fn preserves_aspect_within_one_px() {
        let (fw, fh, _, _) = target_dims(6000, 4000).unwrap();
        let in_ar = 6000.0_f64 / 4000.0;
        let feed_ar = fw as f64 / fh as f64;
        assert!((in_ar - feed_ar).abs() < 0.02, "feed {fw}x{fh}");
    }
}
```

NOTE: `pub mod assets;` and `pub mod engine;` reference files created in Tasks 2 and 3. To let Task 1 compile and test on its own, create **stub files** now: `app/src-tauri/src/upscale/assets.rs` containing only `// implemented in Task 2` and `app/src-tauri/src/upscale/engine.rs` containing only `// implemented in Task 3`. Empty modules compile fine.

- [ ] **Step 3: Register the module**

In `app/src-tauri/src/lib.rs`, add after `mod tether;` (keep list grouped):

```rust
mod upscale;
```

- [ ] **Step 4: Run the tests**

Run: `cd app/src-tauri && cargo test --lib upscale::tests`
Expected: PASS — all four `target_dims` tests pass. (First build compiles `ort`/`ndarray`/`sha2`; may take a few minutes.)

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/upscale/ app/src-tauri/src/lib.rs
git commit -m "feat(upscale): module skeleton + 8K-cap target math"
```
End every commit body in this plan with (after a blank line):
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 2: Asset manifest, status, SHA-256 verify, download (TDD for pure parts)

**Files:**
- Modify (replace stub): `app/src-tauri/src/upscale/assets.rs`

- [ ] **Step 1: Write the asset module with a SHA-256-verify test first**

Replace `app/src-tauri/src/upscale/assets.rs` with:

```rust
//! Download + integrity-check the ONNX Runtime native library and the model file.
//! Assets live under <app_data>/upscaler/ and are fetched on first use.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// One downloadable asset (the runtime lib or the model).
pub struct Asset {
    /// File name as stored on disk under the upscaler dir.
    pub file_name: &'static str,
    /// Absolute download URL (a GitHub release asset).
    pub url: &'static str,
    /// Lowercase hex SHA-256 of the file's bytes.
    pub sha256: &'static str,
    /// Expected size in bytes (for the progress total before Content-Length).
    pub size: u64,
}

// ============================================================================
// RELEASE CONFIG — filled in by Task 9 once assets are built, signed, hosted.
// The macOS runtime asset MUST be the Developer-ID re-signed dylib (see spec).
// Until hosted, the url/sha256/size below are placeholders; the DOWNLOAD path
// cannot succeed until they are real, but everything else (status checks, verify
// logic, command wiring, UI) is testable. Do not ship a release with placeholders.
// ============================================================================
#[cfg(target_os = "macos")]
const RUNTIME: Asset = Asset {
    file_name: "libonnxruntime.dylib",
    url: "https://example.invalid/REPLACE_macos_arm64_libonnxruntime.dylib",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    size: 25_000_000,
};
#[cfg(target_os = "windows")]
const RUNTIME: Asset = Asset {
    file_name: "onnxruntime.dll",
    url: "https://example.invalid/REPLACE_windows_x64_onnxruntime.dll",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    size: 40_000_000,
};
#[cfg(target_os = "linux")]
const RUNTIME: Asset = Asset {
    file_name: "libonnxruntime.so",
    url: "https://example.invalid/REPLACE_linux_x64_libonnxruntime.so",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    size: 15_000_000,
};

const MODEL: Asset = Asset {
    file_name: "realesr-general-x4v3.onnx",
    url: "https://example.invalid/REPLACE_realesr-general-x4v3.onnx",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
    size: 5_000_000,
};

/// All assets required on the current platform (runtime first, then model).
pub fn required() -> [&'static Asset; 2] {
    [&RUNTIME, &MODEL]
}

/// Total download size across required assets (for the gate's "~NN MB" label).
pub fn total_download_bytes() -> u64 {
    required().iter().map(|a| a.size).sum()
}

/// The upscaler asset directory: <app_data>/upscaler/.
pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("upscaler")
}

/// Absolute on-disk path to the runtime library (for ORT_DYLIB_PATH).
pub fn runtime_path(app_data: &Path) -> PathBuf {
    dir(app_data).join(RUNTIME.file_name)
}

/// Absolute on-disk path to the model file.
pub fn model_path(app_data: &Path) -> PathBuf {
    dir(app_data).join(MODEL.file_name)
}

/// Lowercase hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// True when every required asset exists on disk with a matching checksum.
pub fn installed(app_data: &Path) -> bool {
    required().iter().all(|a| {
        let p = dir(app_data).join(a.file_name);
        match std::fs::read(&p) {
            Ok(bytes) => sha256_hex(&bytes) == a.sha256,
            Err(_) => false,
        }
    })
}

/// Status payload for the frontend gate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub download_bytes: u64,
}

pub fn status(app_data: &Path) -> Status {
    Status {
        installed: installed(app_data),
        download_bytes: total_download_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn installed_false_when_missing() {
        let tmp = std::env::temp_dir().join("oe_upscale_test_missing");
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(!installed(&tmp));
    }

    #[test]
    fn required_lists_runtime_then_model() {
        let r = required();
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].file_name, "realesr-general-x4v3.onnx");
    }
}
```

- [ ] **Step 2: Run the pure tests**

Run: `cd app/src-tauri && cargo test --lib upscale::assets`
Expected: PASS — `sha256_known_vector`, `installed_false_when_missing`, `required_lists_runtime_then_model`.

- [ ] **Step 3: Add the streaming download with progress events**

Append to `app/src-tauri/src/upscale/assets.rs`:

```rust
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// Progress payload emitted on `upscale://download-progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// Download + verify all required assets into the upscaler dir, emitting
/// cumulative progress. On any checksum mismatch the partial file is removed and
/// an error is returned (no half-installed state).
pub async fn download(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    let assets = required();
    let total: u64 = assets.iter().map(|a| a.size).sum();
    let dir = dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create upscaler dir: {e}"))?;
    let client = reqwest::Client::new();
    let mut received: u64 = 0;

    for a in assets {
        let resp = client
            .get(a.url)
            .send()
            .await
            .map_err(|e| format!("download {}: {e}", a.file_name))?;
        if !resp.status().is_success() {
            return Err(format!("download {}: HTTP {}", a.file_name, resp.status()));
        }
        let tmp = dir.join(format!("{}.part", a.file_name));
        let mut buf: Vec<u8> = Vec::with_capacity(a.size as usize);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read {}: {e}", a.file_name))?;
            buf.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            let _ = app.emit("upscale://download-progress", DownloadProgress { received, total });
        }
        let got = sha256_hex(&buf);
        if got != a.sha256 {
            return Err(format!("checksum mismatch for {} (got {got})", a.file_name));
        }
        std::fs::write(&tmp, &buf).map_err(|e| format!("write {}: {e}", a.file_name))?;
        std::fs::rename(&tmp, dir.join(a.file_name))
            .map_err(|e| format!("install {}: {e}", a.file_name))?;
    }
    Ok(())
}
```

Add to `Cargo.toml` `[dependencies]` (reqwest is already present from the AI Enhance feature; add the streaming helper):

```toml
futures-util = "0.3"
```

- [ ] **Step 4: Verify it compiles + pure tests still pass**

Run: `cd app/src-tauri && cargo test --lib upscale::assets`
Expected: compiles; the 3 pure tests pass. (The `download` fn isn't unit-tested — it needs network; it's manually verified later.)

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/upscale/assets.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat(upscale): asset manifest, status, sha256 verify, streaming download"
```

---

## Task 3: ONNX engine — tile geometry (TDD) + `ort` tiled inference

**Files:**
- Modify (replace stub): `app/src-tauri/src/upscale/engine.rs`
- Modify: `app/src-tauri/Cargo.toml` (per-platform EP features)

- [ ] **Step 1: Write tile-geometry pure fns + tests first**

Replace `app/src-tauri/src/upscale/engine.rs` with the geometry core (no `ort` yet):

```rust
//! Real-ESRGAN tiled inference via ONNX Runtime. The model is a fixed 4x SR net
//! (RealESRGAN realesr-general-x4v3): input NCHW f32 RGB in [0,1], output 4x.

/// A tile to run through the model: source rect (with padding) + the inner rect
/// (without padding) used to crop the model output back to seamless content.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    pub sx: usize, // source x of the padded read (in input px)
    pub sy: usize,
    pub sw: usize, // padded read width
    pub sh: usize,
    pub ix: usize, // inner (unpadded) x relative to the padded tile
    pub iy: usize,
    pub iw: usize, // inner content width
    pub ih: usize,
    pub ox: usize, // output x of the inner content in the FULL input grid
    pub oy: usize,
}

/// Split a `w` x `h` input into tiles of up to `tile` px with `pad` overlap.
/// Each tile reads `pad` extra px on every interior edge; the padded margin is
/// cropped from the model output so seams disappear. Output coords are in INPUT
/// space (multiply by scale=4 when writing into the 4x buffer).
pub fn plan_tiles(w: usize, h: usize, tile: usize, pad: usize) -> Vec<Tile> {
    let mut tiles = Vec::new();
    let mut oy = 0;
    while oy < h {
        let ih = tile.min(h - oy);
        let mut ox = 0;
        while ox < w {
            let iw = tile.min(w - ox);
            let sx = ox.saturating_sub(pad);
            let sy = oy.saturating_sub(pad);
            let ex = (ox + iw + pad).min(w);
            let ey = (oy + ih + pad).min(h);
            tiles.push(Tile {
                sx, sy, sw: ex - sx, sh: ey - sy,
                ix: ox - sx, iy: oy - sy, iw, ih,
                ox, oy,
            });
            ox += iw;
        }
        oy += ih;
    }
    tiles
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_tile_when_image_fits() {
        let t = plan_tiles(100, 80, 256, 16);
        assert_eq!(t.len(), 1);
        let only = t[0];
        assert_eq!((only.ox, only.oy, only.iw, only.ih), (0, 0, 100, 80));
        // no interior edges -> no padding read beyond the image
        assert_eq!((only.sx, only.sy, only.sw, only.sh), (0, 0, 100, 80));
    }

    #[test]
    fn tiles_cover_every_pixel_exactly_once() {
        let (w, h) = (500usize, 300usize);
        let tiles = plan_tiles(w, h, 128, 8);
        let mut covered = vec![0u32; w * h];
        for t in &tiles {
            for yy in t.oy..t.oy + t.ih {
                for xx in t.ox..t.ox + t.iw {
                    covered[yy * w + xx] += 1;
                }
            }
        }
        assert!(covered.iter().all(|&c| c == 1), "every inner pixel covered once");
    }

    #[test]
    fn interior_tiles_have_padding() {
        let tiles = plan_tiles(500, 500, 128, 8);
        // A tile not touching the left/top edge reads pad extra px before it.
        let interior = tiles.iter().find(|t| t.ox > 0 && t.oy > 0).unwrap();
        assert_eq!(interior.ix, 8);
        assert_eq!(interior.iy, 8);
    }
}
```

- [ ] **Step 2: Run the geometry tests**

Run: `cd app/src-tauri && cargo test --lib upscale::engine`
Expected: PASS — `single_tile_when_image_fits`, `tiles_cover_every_pixel_exactly_once`, `interior_tiles_have_padding`.

- [ ] **Step 3: Add per-platform execution-provider features**

In `app/src-tauri/Cargo.toml`, add target-specific `ort` EP features so GPU is enabled per platform with CPU always available (CPU is the default EP, no feature needed):

```toml
[target.'cfg(target_os = "macos")'.dependencies]
ort = { version = "=2.0.0-rc.12", default-features = false, features = ["load-dynamic", "ndarray", "coreml"] }

[target.'cfg(target_os = "windows")'.dependencies]
ort = { version = "=2.0.0-rc.12", default-features = false, features = ["load-dynamic", "ndarray", "directml"] }
```

(Linux keeps the base `ort` from Task 1 — CPU only. Per the `ort` issue noted in research, do NOT enable multiple GPU EP features on one target.)

- [ ] **Step 4: Add the `ort` session + tiled inference**

Append to `app/src-tauri/src/upscale/engine.rs`. **Implementer note:** the exact `ort` 2.0.0-rc API for building inputs/reading outputs should be confirmed against https://ort.pyke.io/ for the pinned version; the structure below is the intended algorithm. Query the model's actual input/output names from the session rather than hardcoding (community ONNX conversions vary).

```rust
use crate::upscale::assets;
use film_core::Image;
use ndarray::Array4;
use ort::session::{builder::GraphOptimizationLevel, Session};
use std::path::Path;
use std::sync::Once;

static INIT: Once = Once::new();

/// Point `ort` at the downloaded runtime library exactly once per process.
fn init_runtime(app_data: &Path) {
    INIT.call_once(|| {
        let lib = assets::runtime_path(app_data);
        std::env::set_var("ORT_DYLIB_PATH", lib);
    });
}

/// Build a session for the model, registering the platform GPU EP with CPU
/// fallback (ort falls back to CPU automatically if a registered EP fails).
fn make_session(app_data: &Path) -> Result<Session, String> {
    init_runtime(app_data);
    let builder = Session::builder().map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = {
        use ort::execution_providers::CoreMLExecutionProvider;
        builder.with_execution_providers([CoreMLExecutionProvider::default().build()])
            .map_err(|e| e.to_string())?
    };
    #[cfg(target_os = "windows")]
    let builder = {
        use ort::execution_providers::DirectMLExecutionProvider;
        builder.with_execution_providers([DirectMLExecutionProvider::default().build()])
            .map_err(|e| e.to_string())?
    };

    builder
        .commit_from_file(assets::model_path(app_data))
        .map_err(|e| format!("load model: {e}"))
}

/// Run one padded tile (RGB f32 [0,1], NCHW) and return the 4x RGB f32 output.
fn run_tile(session: &Session, rgb: &[[f32; 3]], w: usize, h: usize) -> Result<(Vec<[f32; 3]>, usize, usize), String> {
    let mut input = Array4::<f32>::zeros((1, 3, h, w));
    for y in 0..h {
        for x in 0..w {
            let p = rgb[y * w + x];
            input[[0, 0, y, x]] = p[0];
            input[[0, 1, y, x]] = p[1];
            input[[0, 2, y, x]] = p[2];
        }
    }
    let input_name = session.inputs[0].name.clone();
    let output_name = session.outputs[0].name.clone();
    let outputs = session
        .run(ort::inputs![input_name.as_str() => input].map_err(|e| e.to_string())?)
        .map_err(|e| format!("inference: {e}"))?;
    let out = outputs[output_name.as_str()]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let shape = out.shape();
    let (oh, ow) = (shape[2], shape[3]);
    let view = out.view();
    let mut pixels = vec![[0f32; 3]; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            pixels[y * ow + x] = [
                view[[0, 0, y, x]].clamp(0.0, 1.0),
                view[[0, 1, y, x]].clamp(0.0, 1.0),
                view[[0, 2, y, x]].clamp(0.0, 1.0),
            ];
        }
    }
    Ok((pixels, ow, oh))
}

/// Upscale a finished `Image` (linear f32 RGB [0,1]) by the model's fixed 4x,
/// tiled with overlap, calling `on_tile(done, total)` after each tile.
pub fn upscale_4x(
    app_data: &Path,
    src: &Image,
    tile: usize,
    pad: usize,
    mut on_tile: impl FnMut(usize, usize),
) -> Result<Image, String> {
    const SCALE: usize = 4;
    let session = make_session(app_data)?;
    let tiles = plan_tiles(src.width, src.height, tile, pad);
    let total = tiles.len();
    let (ow, oh) = (src.width * SCALE, src.height * SCALE);
    let mut out = vec![[0f32; 3]; ow * oh];

    for (i, t) in tiles.iter().enumerate() {
        // Gather the padded source tile.
        let mut buf = vec![[0f32; 3]; t.sw * t.sh];
        for yy in 0..t.sh {
            for xx in 0..t.sw {
                buf[yy * t.sw + xx] = src.pixels[(t.sy + yy) * src.width + (t.sx + xx)];
            }
        }
        let (up, uw, _uh) = run_tile(&session, &buf, t.sw, t.sh)?;
        // Copy the inner (unpadded) region into the output, scaled by 4.
        for yy in 0..t.ih * SCALE {
            for xx in 0..t.iw * SCALE {
                let srcx = t.ix * SCALE + xx;
                let srcy = t.iy * SCALE + yy;
                let dstx = t.ox * SCALE + xx;
                let dsty = t.oy * SCALE + yy;
                out[dsty * ow + dstx] = up[srcy * uw + srcx];
            }
        }
        on_tile(i + 1, total);
    }

    Ok(Image { width: ow, height: oh, pixels: out, ir: None })
}
```

- [ ] **Step 5: Verify it compiles (geometry tests still green)**

Run: `cd app/src-tauri && cargo build --lib && cargo test --lib upscale::engine`
Expected: compiles; the 3 geometry tests still pass. If the `ort` input/output API differs for rc.12, adapt `run_tile` per the ort docs (the algorithm and tiling are unaffected). Report any API adaptation as a DONE_WITH_CONCERNS note.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/upscale/engine.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat(upscale): tiled inference engine (ort) + tile geometry"
```

---

## Task 4: Extract `finish_full_res` + add `pending_upscale` to Session

**Files:**
- Modify: `app/src-tauri/src/commands.rs:958-1031`
- Modify: `app/src-tauri/src/session.rs:238-253`

- [ ] **Step 1: Add the stash type + field to Session**

In `app/src-tauri/src/session.rs`, after the `PreparedExport` struct (line 245), add:

```rust
/// A finished, upscaled full-res image awaiting save (held between `upscale_image`
/// and `save_upscaled`), plus the metadata to embed as EXIF on save.
pub struct PendingUpscale {
    pub image: Image,
    pub metadata: Metadata,
}
```

And add a field to `Session` (after `pending_export` on line 252):

```rust
    pub pending_upscale: Mutex<Option<PendingUpscale>>,
```

(`Session` derives `Default`, and `Mutex<Option<_>>` defaults to `None`, so no other change is needed.)

- [ ] **Step 2: Extract the finishing pipeline from `export_image`**

In `app/src-tauri/src/commands.rs`, add this helper immediately BEFORE `export_image` (before line 958). It is the verbatim body of `export_image`'s decode→orient→crop→invert→dust→IR→finish sequence (lines 976-1009), returning the finished image plus the source metadata:

```rust
/// Decode the full-res file, apply geometry + inversion + dust/IR + finishing, and
/// return the finished image and its source metadata. Shared by `export_image` and
/// the upscaler so both produce identical pixels.
#[allow(clippy::too_many_arguments)]
pub(crate) fn finish_full_res(
    id: &str,
    params: &InvertParams,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    dust: &[DustStroke],
    ir_removal: &IrRemoval,
    session: &Session,
) -> Result<(film_core::Image, crate::metadata::Metadata), String> {
    ensure_resident(session, id)?;
    let (path, base, thumb, metadata, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (img.path.clone(), dev.base, dev.thumb.clone(), img.metadata.clone(), dev.d_max)
    };
    let full = decode_any(Path::new(&path))?;
    let full = orient(&full, rot90, flip_h, flip_v);
    let full = rotate(&full, angle);
    let full = match image_crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, full.width, full.height);
            crop(&full, x, y, w, h)
        }
        None => full,
    };
    let mut ip = resolve_params(params, &thumb, effective_base(params, base));
    ip.d_max = effective_dmax(params, dev_dmax);
    let mut inv = invert_image(&full, &ip, mode_from(&params.mode));
    let stamps = export_stamps(dust, inv.width, inv.height);
    dust::apply(&mut inv, &stamps);
    if ir_removal.enabled {
        if let Some(ir) = full.ir.as_ref() {
            dust::apply_ir(&mut inv, ir, ir_removal.sensitivity);
        }
    }
    let fin = finish_image(&inv, &finish_from(params));
    Ok((fin, metadata))
}
```

- [ ] **Step 3: Rewrite `export_image` to use the helper**

Replace the body of `export_image` (lines 976-1022, from `ensure_resident...` through the format `match`'s `?`) so it delegates. The new body of `export_image` becomes:

```rust
    let (fin, metadata) = finish_full_res(
        &id, &params, image_crop, rot90, flip_h, flip_v, angle, &dust, &ir_removal, &session,
    )?;
    let out = Path::new(&out_path);
    match format.kind.as_str() {
        "tiff" => {
            if format.bit_depth == 16 {
                film_core::export::write_tiff16(&fin, out).map_err(|e| format!("{e}"))
            } else {
                write_tiff8(&fin, out)
            }
        }
        "png" => write_png(&fin, out, format.bit_depth),
        "jpeg" => write_jpeg(&fin, out, format.quality, format.max_bytes),
        other => Err(format!("unknown export format: {other}")),
    }?;

    let eff = effective_metadata(&metadata, meta_override.as_ref());
    if let Err(e) = crate::exif_write::write_exif(out, &eff) {
        eprintln!("[exif] embed failed for {out_path}: {e}");
    }
    Ok(())
```

(Keep the `export_image` signature, attributes, and doc comment unchanged — only the body from `ensure_resident` onward changes.)

- [ ] **Step 4: Verify export still compiles + all tests pass**

Run: `cd app/src-tauri && cargo build --lib && cargo test --lib`
Expected: compiles; existing command/session tests still pass (no behavior change to export — same pixels, same encode path).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/session.rs
git commit -m "refactor(export): extract finish_full_res; add pending_upscale to session"
```

---

## Task 5: Upscale orchestration + 4 Tauri commands

**Files:**
- Modify: `app/src-tauri/src/upscale/mod.rs`
- Modify: `app/src-tauri/src/commands.rs` (append commands)
- Modify: `app/src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Add the orchestration fn to `upscale/mod.rs`**

Append to `app/src-tauri/src/upscale/mod.rs` (after the `target_dims` fn, before `#[cfg(test)]`):

```rust
use film_core::Image;

/// Default tiling: 256 px tiles with 16 px overlap (bounded memory, seamless).
pub const TILE: usize = 256;
pub const TILE_PAD: usize = 16;

/// Result returned to the panel after an upscale (preview only; full-res is stashed).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleResult {
    pub preview_data_url: String,
    pub out_w: u32,
    pub out_h: u32,
}

/// Downscale `fin` to the model feed size, run tiled 4x, and resize to the exact
/// 8K-capped target. Returns the full-res upscaled image. `on_tile(done,total)`
/// reports inference progress.
pub fn run(
    app_data: &std::path::Path,
    fin: &Image,
    on_tile: impl FnMut(usize, usize),
) -> Result<Image, String> {
    let (fw, fh, ow, oh) = target_dims(fin.width as u32, fin.height as u32)
        .ok_or("image is already at or above 8K on its longest side")?;
    // Feed the model an image downscaled to feed dims (Triangle is fine here).
    let feed = crate::convert::resize_to(fin, fw, fh);
    let up = engine::upscale_4x(app_data, &feed, TILE, TILE_PAD, on_tile)?;
    // 4x of feed should equal (ow,oh); correct any rounding.
    let up = if up.width as u32 == ow && up.height as u32 == oh {
        up
    } else {
        crate::convert::resize_to(&up, ow, oh)
    };
    Ok(up)
}
```

- [ ] **Step 2: Add the commands to `commands.rs`**

Append to `app/src-tauri/src/commands.rs`:

```rust
/// Whether the upscaler runtime+model are installed, and the download size.
#[tauri::command]
pub fn upscaler_status(app: tauri::AppHandle) -> Result<crate::upscale::assets::Status, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(crate::upscale::assets::status(&app_data))
}

/// Download + verify the upscaler assets, emitting `upscale://download-progress`.
#[tauri::command]
pub async fn download_upscaler(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    crate::upscale::assets::download(&app, &app_data).await
}

/// Upscale the current developed image; stash full-res, return a preview.
/// Emits `upscale://progress` ({ done, total }) per tile.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn upscale_image(
    app: tauri::AppHandle,
    id: String,
    params: InvertParams,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    dust: Vec<DustStroke>,
    ir_removal: IrRemoval,
    session: State<'_, Session>,
) -> Result<crate::upscale::UpscaleResult, String> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (fin, metadata) = finish_full_res(
        &id, &params, image_crop, rot90, flip_h, flip_v, angle, &dust, &ir_removal, &session,
    )?;
    let app2 = app.clone();
    let up = crate::upscale::run(&app_data, &fin, move |done, total| {
        let _ = app2.emit("upscale://progress", serde_json::json!({ "done": done, "total": total }));
    })?;
    let (out_w, out_h) = (up.width as u32, up.height as u32);
    // Build a small preview (long edge <= 1600) as a JPEG data URL.
    let preview = crate::convert::proxy(&up, 1600);
    let preview_data_url = encode_jpeg_data_url(&preview, 85)?;
    *session.pending_upscale.lock().unwrap() =
        Some(crate::session::PendingUpscale { image: up, metadata });
    Ok(crate::upscale::UpscaleResult { preview_data_url, out_w, out_h })
}

/// Save the stashed upscaled image to `out_path` in the chosen format, with EXIF.
#[tauri::command]
pub fn save_upscaled(
    out_path: String,
    format: ExportFormat,
    meta_override: Option<MetaOverride>,
    session: State<Session>,
) -> Result<(), String> {
    let guard = session.pending_upscale.lock().unwrap();
    let pending = guard.as_ref().ok_or("no upscaled image to save")?;
    let out = Path::new(&out_path);
    match format.kind.as_str() {
        "tiff" => {
            if format.bit_depth == 16 {
                film_core::export::write_tiff16(&pending.image, out).map_err(|e| format!("{e}"))
            } else {
                write_tiff8(&pending.image, out)
            }
        }
        "png" => write_png(&pending.image, out, format.bit_depth),
        "jpeg" => write_jpeg(&pending.image, out, format.quality, format.max_bytes),
        other => Err(format!("unknown export format: {other}")),
    }?;
    let eff = effective_metadata(&pending.metadata, meta_override.as_ref());
    if let Err(e) = crate::exif_write::write_exif(out, &eff) {
        eprintln!("[exif] embed failed for {out_path}: {e}");
    }
    Ok(())
}
```

NOTE on `encode_jpeg_data_url`: the AI Enhance / render path already builds a JPEG data URL from an `Image` (see `commands.rs:878-880`, which encodes a `jpeg` Vec and formats `data:image/jpeg;base64,{b64}`). If a reusable helper does not already exist, add a small private fn `fn encode_jpeg_data_url(img: &film_core::Image, quality: u8) -> Result<String, String>` next to the other encoders that encodes the image to in-memory JPEG bytes (reuse the same encoder `write_jpeg` uses, or `image::codecs::jpeg`) and returns the base64 data URL. Verify the existing render code at ~commands.rs:870-880 and reuse its exact approach rather than duplicating.

- [ ] **Step 3: Register the commands**

In `app/src-tauri/src/lib.rs`, inside `generate_handler![ ... ]`, add after `commands::ai_enhance_image,`:

```rust
            commands::upscaler_status,
            commands::download_upscaler,
            commands::upscale_image,
            commands::save_upscaled,
```

- [ ] **Step 4: Verify backend compiles + tests pass**

Run: `cd app/src-tauri && cargo build --lib && cargo test --lib`
Expected: compiles; all unit tests pass (the pure upscale tests from Tasks 1-3 plus existing).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/upscale/mod.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(upscale): orchestration + status/download/upscale/save commands"
```

---

## Task 6: Frontend API bindings + store wiring

**Files:**
- Modify: `app/src/lib/api.ts`
- Modify: `app/src/lib/store.ts`

- [ ] **Step 1: Add the Tool type + store**

In `app/src/lib/store.ts`, change the `Tool` union (line 124) to add `"upscale"`:

```typescript
export type Tool = "edit" | "crop" | "eraser" | "enhance" | "upscale";
```

Add after the `openaiApiKey` store (line 128):

```typescript
/** Whether the local upscaler runtime+model are installed (re-checked on tool open). */
export const upscalerInstalled = writable<boolean>(false);
```

- [ ] **Step 2: Add the API bindings**

In `app/src/lib/api.ts`, inside the `api` object after `aiEnhanceImage` (line 208-ish), add:

```typescript
  upscalerStatus: () =>
    invoke<{ installed: boolean; downloadBytes: number }>("upscaler_status"),
  downloadUpscaler: () => invoke<void>("download_upscaler"),
  upscaleImage: (
    id: string, params: InvertParams,
    imageCrop: [number, number, number, number] | null = null,
    geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {},
    dust: DustStroke[] = [],
    irRemoval: IrRemoval = { enabled: false, sensitivity: 50 },
  ) =>
    invoke<{ previewDataUrl: string; outW: number; outH: number }>("upscale_image", {
      id, params, imageCrop,
      rot90: geom.rot90 ?? 0, flipH: geom.flip_h ?? false,
      flipV: geom.flip_v ?? false, angle: geom.angle ?? 0,
      dust: wireDust(dust), irRemoval,
    }),
  saveUpscaled: (outPath: string, format: ExportFormat, metaOverride: MetaOverride | null = null) =>
    invoke<void>("save_upscaled", { outPath, format, metaOverride }),
```

(These mirror `exportImage`'s `geom`/`dust` wiring exactly. The two progress events `upscale://download-progress` and `upscale://progress` are subscribed with `@tauri-apps/api/event` `listen` directly in the panel — same as the tether controller pattern.)

- [ ] **Step 3: Verify type-check**

Run: `cd app && npm run check`
Expected: 0 new errors (pre-existing ~27 warnings unrelated).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/store.ts
git commit -m "feat(upscale): frontend api bindings + tool/store wiring"
```

---

## Task 7: UpscalePanel component (download gate + upscale UI + save)

**Files:**
- Create: `app/src/lib/develop/UpscalePanel.svelte`

- [ ] **Step 1: Create the panel**

Create `app/src/lib/develop/UpscalePanel.svelte`. It reuses the develop-tool look (`.section`/`.head`/`.hint`, accent buttons) and the AiEnhancePanel result/lightbox pattern. The panel needs the active image's id, params, crop, and geometry to call `upscaleImage` — these come from the existing develop stores; pass them in as props from `Develop.svelte` (see Task 8) to match how `EraserPanel` receives `brush`/`hasIr`.

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { t } from "$lib/i18n";
  import { api, type InvertParams, type ExportFormat } from "../api";
  import { upscalerInstalled } from "../store";

  /** Everything needed to reproduce the export pixels for the active image. */
  export let id: string | null;
  export let params: InvertParams;
  export let imageCrop: [number, number, number, number] | null = null;
  export let geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {};
  /** Longest source side (px) so we can show target size + the >=8K notice. */
  export let sourceLong = 0;

  let checking = true;
  let downloadBytes = 0;
  let downloading = false;
  let dlReceived = 0;
  let dlTotal = 0;

  let busy = false;
  let progress = 0; // 0..1 during inference
  let error = "";
  let result = ""; // preview data URL
  let outW = 0, outH = 0;

  let unlistenDl: UnlistenFn | null = null;
  let unlistenUp: UnlistenFn | null = null;

  $: atOrAbove8k = sourceLong >= 8192;
  $: mb = (downloadBytes / 1_000_000).toFixed(0);

  onMount(async () => {
    unlistenDl = await listen<{ received: number; total: number }>(
      "upscale://download-progress", (e) => { dlReceived = e.payload.received; dlTotal = e.payload.total; });
    unlistenUp = await listen<{ done: number; total: number }>(
      "upscale://progress", (e) => { progress = e.payload.total ? e.payload.done / e.payload.total : 0; });
    try {
      const s = await api.upscalerStatus();
      $upscalerInstalled = s.installed;
      downloadBytes = s.downloadBytes;
    } catch (e) { error = String(e); }
    checking = false;
  });
  onDestroy(() => { unlistenDl?.(); unlistenUp?.(); });

  async function download() {
    error = ""; downloading = true; dlReceived = 0; dlTotal = downloadBytes;
    try { await api.downloadUpscaler(); $upscalerInstalled = true; }
    catch (e) { error = String(e); }
    finally { downloading = false; }
  }

  async function upscale() {
    if (!id || atOrAbove8k) return;
    error = ""; result = ""; busy = true; progress = 0;
    try {
      const r = await api.upscaleImage(id, params, imageCrop, geom);
      result = r.previewDataUrl; outW = r.outW; outH = r.outH;
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }

  async function saveResult() {
    const path = await save({
      filters: [{ name: "PNG", extensions: ["png"] }, { name: "TIFF", extensions: ["tiff"] }, { name: "JPEG", extensions: ["jpg"] }],
    });
    if (!path) return;
    const ext = path.split(".").pop()?.toLowerCase();
    const format: ExportFormat =
      ext === "tiff" || ext === "tif" ? { kind: "tiff", bitDepth: 16 }
      : ext === "jpg" || ext === "jpeg" ? { kind: "jpeg", quality: 92 }
      : { kind: "png", bitDepth: 16 };
    try { await api.saveUpscaled(path, format); }
    catch (e) { error = String(e); }
  }
</script>

<div class="section">
  <div class="head"><span>{$t("upscale.title")}</span><span class="exp">{$t("upscale.local")}</span></div>

  {#if checking}
    <div class="hint">{$t("upscale.checking")}</div>
  {:else if !$upscalerInstalled}
    <!-- Download gate -->
    <div class="hint">{$t("upscale.downloadPrompt", { mb })}</div>
    {#if downloading}
      <div class="bar"><span style="width:{dlTotal ? (dlReceived / dlTotal) * 100 : 0}%"></span></div>
    {:else}
      <button class="go" on:click={download}>{$t("upscale.download")}</button>
    {/if}
  {:else}
    <!-- Installed: main UI -->
    {#if atOrAbove8k}
      <div class="hint">{$t("upscale.already8k")}</div>
    {:else}
      <button class="go" disabled={busy || !id} on:click={upscale}>
        {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
        <span>{busy ? $t("upscale.working") : $t("upscale.button")}</span>
      </button>
      {#if busy}<div class="bar"><span style="width:{progress * 100}%"></span></div>{/if}
    {/if}

    {#if error}<div class="err">{error}</div>{/if}

    {#if result}
      <div class="result">
        <img src={result} alt={$t("upscale.title")} />
        <div class="dims">{outW} × {outH}</div>
        <button class="row" on:click={saveResult}>{$t("upscale.save")}</button>
      </div>
    {/if}
  {/if}

  <div class="hint">{$t("upscale.hint")}</div>
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { display: flex; align-items: center; gap: 8px; color: var(--text); font-weight: 600; padding: 4px 0; }
  .exp { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid rgba(244,157,78,0.5); color: var(--accent); border-radius: 4px; padding: 0 5px; }
  .go { width: 100%; padding: 9px 10px; margin: 6px 0; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18); color: #fff; cursor: pointer; font-size: 13px; }
  .go:disabled { opacity: 0.55; cursor: default; }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bar { width: 100%; height: 6px; border-radius: 3px; background: var(--glass-hi); overflow: hidden; margin: 6px 0; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.2s ease; }
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
  .result { margin-top: 8px; }
  .result img { display: block; width: 100%; border: 1px solid var(--glass-brd); border-radius: 8px; }
  .dims { font-size: 11px; color: var(--text-dim); margin: 6px 0; text-align: center; font-variant-numeric: tabular-nums; }
  .row { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
```

- [ ] **Step 2: Verify type-check**

Run: `cd app && npm run check`
Expected: 0 new errors. (The `upscale.*` i18n keys render as raw keys until Task 8 adds them — expected, `$t` falls back to the key.) If `save` from `@tauri-apps/plugin-dialog` is not found, confirm the dialog plugin is a dependency (it is — `open` is already imported elsewhere); `save` is exported by the same package and `dialog:allow-save` is already in `capabilities/default.json`.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/develop/UpscalePanel.svelte
git commit -m "feat(upscale): UpscalePanel with download gate, progress, save"
```

---

## Task 8: Toolbar tool + icon + Develop wiring + i18n

**Files:**
- Modify: `app/src/lib/icons/Icon.svelte`
- Modify: `app/src/lib/develop/Toolbar.svelte`
- Modify: `app/src/lib/tabs/Develop.svelte`
- Modify: `i18n-strings.csv`

- [ ] **Step 1: Add a `maximize` icon**

In `app/src/lib/icons/Icon.svelte`, add to the icon map (match the existing single-quote/inline-SVG/trailing-comma style of siblings like `sparkles`/`eraser`):

```
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
```

- [ ] **Step 2: Add the toolbar tool after `enhance`**

In `app/src/lib/develop/Toolbar.svelte`, append to the `tools` array (after the `enhance` entry, making it last):

```typescript
    { id: "upscale", icon: "maximize", labelKey: "toolbar.upscale", enabled: true },
```

- [ ] **Step 3: Import + render the panel in Develop**

In `app/src/lib/tabs/Develop.svelte`, add after the `AiEnhancePanel` import:

```svelte
  import UpscalePanel from "../develop/UpscalePanel.svelte";
```

Then add a branch after the `{:else if $tool === "enhance"}` block, before the closing `{/if}` of the tool-pane:

```svelte
          {:else if $tool === "upscale"}
            <UpscalePanel id={$activeId} params={effParams} imageCrop={imageCrop}
                          geom={{ rot90: 0, flip_h: false, flip_v: false, angle: 0 }}
                          sourceLong={Math.max(origW, origH)} />
```

**Implementer note:** wire the props from the SAME sources `Develop.svelte` already passes to the export/eraser flows. `effParams`, `imageCrop`, `$activeId`, `origW`, `origH` already exist in `Develop.svelte` (see lines 39-45 and the export wiring). For `geom`, reuse whatever orientation/angle the export call uses if a committed-geometry value exists in this component; if export currently passes zeros for live develop, pass zeros here too. Match the existing export invocation's arguments exactly so upscale pixels equal export pixels. Do not invent new geometry state.

- [ ] **Step 4: Add i18n strings**

Append to `/i18n-strings.csv` (columns `key,en,zh,file,note`; check none already exist first):

```csv
toolbar.upscale,"Upscale","放大","src/lib/develop/Toolbar.svelte","title"
upscale.title,"Upscale","放大","src/lib/develop/UpscalePanel.svelte","heading"
upscale.local,"local","本地","src/lib/develop/UpscalePanel.svelte","label"
upscale.checking,"Checking upscaler…","正在检查放大器…","src/lib/develop/UpscalePanel.svelte","text"
upscale.downloadPrompt,"Download the local upscaler (~{mb} MB) to enable on-device super-resolution.","下载本地放大器（约 {mb} MB）以启用设备端超分辨率。","src/lib/develop/UpscalePanel.svelte","text"
upscale.download,"Download upscaler","下载放大器","src/lib/develop/UpscalePanel.svelte","button"
upscale.button,"Upscale","放大","src/lib/develop/UpscalePanel.svelte","button"
upscale.working,"Upscaling…","放大中…","src/lib/develop/UpscalePanel.svelte","button"
upscale.already8k,"This image is already 8K or larger on its longest side, so upscaling won't add detail.","该图像最长边已达到或超过 8K，放大不会增加细节。","src/lib/develop/UpscalePanel.svelte","text"
upscale.save,"Save upscaled image…","保存放大后的图像…","src/lib/develop/UpscalePanel.svelte","button"
upscale.hint,"Runs a local AI model on your device (no upload). Output is capped at 8K on the longest side; best results come from smaller sources.","在本地设备上运行 AI 模型（不上传）。输出最长边上限为 8K；较小的原图效果最佳。","src/lib/develop/UpscalePanel.svelte","hint"
```

- [ ] **Step 5: Regenerate the dictionary**

Run: `cd /Users/mohaelder/Repos/filmrev && python3 scripts/gen-i18n.py`
Expected: regenerates `app/src/lib/i18n/dict.ts` with the new keys (verify `toolbar.upscale`, `upscale.button`, `upscale.downloadPrompt` present in both `en` and `zh`). Never hand-edit `dict.ts`.

- [ ] **Step 6: Verify type-check**

Run: `cd app && npm run check`
Expected: 0 new errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/icons/Icon.svelte app/src/lib/develop/Toolbar.svelte app/src/lib/tabs/Develop.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(upscale): toolbar tool, develop wiring, i18n strings"
```

---

## Task 9: Release — host assets, re-sign macOS dylib, fill manifest

**Files:**
- Modify: `app/src-tauri/src/upscale/assets.rs` (real URLs/SHA-256/sizes)
- Create: `docs/upscaler-assets.md` (release runbook)

This task is a release/ops activity, not unit-testable. It is REQUIRED before shipping — until done, `download` cannot succeed (placeholder URLs).

- [ ] **Step 1: Obtain and verify the model**

Download `realesr-general-x4v3` as ONNX (e.g. the Qualcomm HF conversion noted in the spec), confirm it is a fixed-4x model with NCHW f32 input in [0,1], and record its SHA-256 (`shasum -a 256 realesr-general-x4v3.onnx`) and byte size.

- [ ] **Step 2: Obtain ONNX Runtime native libs per platform**

From Microsoft's official ONNX Runtime v1.26 release assets, take the CPU+CoreML build (macOS arm64), the build matching the `directml` feature (Windows x64, include `DirectML.dll` if the chosen build requires it — if so, add it as a 3rd asset in the manifest and to `installed`/`download`), and the Linux x64 `.so`.

- [ ] **Step 3: Re-sign the macOS dylib with the app's Developer ID**

```bash
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: <your identity>" libonnxruntime.dylib
codesign --verify --verbose libonnxruntime.dylib
```

(So library validation passes when the app `dlopen`s it; this avoids the bundle-notarization and `disable-library-validation` paths.)

- [ ] **Step 4: Host as release assets + fill the manifest**

Upload the (re-signed) dylib, the Windows DLL(s), the Linux `.so`, and the model to a stable GitHub release (e.g. tag `upscaler-assets-v1`). Replace every `example.invalid/REPLACE_*` URL, the `sha256` zeros, and the `size` estimates in `app/src-tauri/src/upscale/assets.rs` with the real values from Steps 1-2.

- [ ] **Step 5: Document the runbook**

Create `docs/upscaler-assets.md` recording: asset source URLs, the re-sign command, the release tag, and that the `cut-release` flow must refresh these only when the runtime/model version changes (not every app release). Add a one-line pointer in the `cut-release` skill notes that asset bumps are independent of app version bumps.

- [ ] **Step 6: Manual end-to-end verification**

Build and run the app. Open the Upscale tool on a clean profile: confirm the download gate appears with the right size, the progress bar advances, and the main UI appears after verification. Upscale a small image (e.g. 1500px) and confirm: progress bar advances per tile, a preview appears with the expected 8K-capped dimensions, and Save writes a valid file. Force CPU (temporarily disable the GPU EP) and confirm it still completes. Open a >8K source and confirm the "already 8K" notice shows.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/upscale/assets.rs docs/upscaler-assets.md
git commit -m "chore(upscale): host assets, re-sign macOS dylib, fill manifest"
```

---

## Self-Review Notes

- **Spec coverage:** standalone `upscale` tool after AI Enhance (Task 8); full-res → saved file (Tasks 4/5/7); ONNX Runtime via `ort` with CoreML/DirectML/CPU fallback (Tasks 1/3); `realesr-general-x4v3` model (Tasks 2/9); download-on-first-use gate with progress + Next (Tasks 2/5/7); 8K cap policy (Task 1 `target_dims`); tiled inference (Task 3); finished pixels via the develop/finish pipeline, not the JPEG preview (Task 4 `finish_full_res`); source ≥8K informs rather than degrades (Tasks 1/7); macOS dylib re-sign hosted outside bundle (Tasks 1 `load-dynamic` / 9); progress via Tauri events (existing `tether.rs` pattern); save reuses encoders + EXIF (Task 5). Denoise slider correctly omitted (spec stretch goal). All covered.
- **Type consistency:** `target_dims` returns `(feed_w, feed_h, out_w, out_h)` used by `upscale::run`; `UpscaleResult { preview_data_url, out_w, out_h }` (serde camelCase) matches the TS `{ previewDataUrl, outW, outH }`; `Status { installed, download_bytes }` ↔ TS `{ installed, downloadBytes }`; `PendingUpscale { image, metadata }` set in `upscale_image`, read in `save_upscaled`; `finish_full_res` signature identical at definition (Task 4) and both call sites (export + `upscale_image`); event names `upscale://download-progress` / `upscale://progress` identical in backend emit (Tasks 2/5) and frontend listen (Task 7); tool id `"upscale"` consistent across store/Toolbar/Develop.
- **Flagged-for-implementation uncertainties (verified during work, not assumed):** exact `ort` 2.0.0-rc input/output API (Task 3 Step 4/5 — verify vs ort docs); whether the Windows ORT build needs a separate `DirectML.dll` asset (Task 9 Step 2); the exact `encode_jpeg_data_url` reuse point (Task 5 Step 2 — reuse the render code at ~commands.rs:870-880); the precise `geom` values `Develop.svelte` passes to export so upscale matches (Task 8 Step 3). Manifest URLs/SHA-256/sizes are genuine release-time values (Task 9), clearly marked in code.
