# Upscaler assets runbook

The local Upscale tool downloads its ONNX Runtime + model on first use (not
bundled). The manifest lives in `app/src-tauri/src/upscale/assets.rs`
(`RUNTIME` per-OS + `MODEL`). Assets are hosted as **GitHub release assets** on a
dedicated tag of the **public** `MohaElder/openenlarge` repo, so the app's
unauthenticated `reqwest` download works.

This is decoupled from app releases — bump only when the runtime or model
changes. The `cut-release` flow does NOT touch these.

## Current release: `upscaler-assets-v1`

| Asset | Source | sha256 | bytes |
|---|---|---|---|
| `libonnxruntime.dylib` | ONNX Runtime 1.26.0 osx-arm64, **re-signed** (below) | `ba6ff4015f593fa87682b0e7d36164c1f7fa05148b7dff442efb34e13a60bf1a` | 37,078,528 |
| `onnxruntime.dll` | ONNX Runtime 1.26.0 win-x64 (CPU) | `b2ba7ca16e0e4fe71ad5148744ab885a2f5809e52a0c3de4d9ba3853a03977f9` | 14,897,976 |
| `libonnxruntime.so` | ONNX Runtime 1.26.0 linux-x64 (CPU) | `5bd5bedf736fc501692435d0ec4f6e8b2bdf48cd30af8e6d00d61b3ddc9a7ab8` | 23,023,576 |
| `realesr-general-x4v3.onnx` | OwlMaster/AllFilesRope mirror (SRVGGNetCompact, BSD-3 underlying) | `09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4` | 4,871,181 |

### macOS dylib re-sign (required)

ONNX Runtime's official dylib ships unsigned. Because the app `dlopen`s it from
app-data (outside the bundle) under Hardened Runtime, it must be signed by the
**same team** as the app. Re-sign with the Developer ID, then verify:

```bash
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: Aako, Inc (N7BMGT3KJY)" libonnxruntime.dylib
codesign --verify --strict --verbose=2 libonnxruntime.dylib   # -> valid on disk
codesign -dvv libonnxruntime.dylib | grep -E "TeamIdentifier|flags"
# expect: TeamIdentifier=N7BMGT3KJY, flags=0x10000(runtime)
```

### Model validation (was checked before hosting)

`realesr-general-x4v3.onnx` was verified via onnxruntime: input
`[batch_size, 3, height, width]` f32 (dynamic NCHW), a 17×23 input produced a
68×92 output (exactly 4×), output range ~[0, 1]. This matches the engine's
assumptions (`engine.rs`: dynamic input/output names queried at runtime,
NCHW f32 [0,1], 4× with the output-shape guard).

## How the current assets were produced

```bash
# 1. ONNX Runtime 1.26.0 platform builds
gh release download v1.26.0 --repo microsoft/onnxruntime \
  --pattern 'onnxruntime-osx-arm64-1.26.0.tgz' \
  --pattern 'onnxruntime-linux-x64-1.26.0.tgz' \
  --pattern 'onnxruntime-win-x64-1.26.0.zip'
# extract the real lib from each: lib/libonnxruntime.*.dylib, lib/libonnxruntime.so.*, lib/onnxruntime.dll
#   -> rename to libonnxruntime.dylib / libonnxruntime.so / onnxruntime.dll

# 2. model
curl -L https://huggingface.co/OwlMaster/AllFilesRope/resolve/main/realesr-general-x4v3.onnx \
  -o realesr-general-x4v3.onnx

# 3. re-sign the dylib (see above)

# 4. checksums + sizes for the manifest
shasum -a 256 *.dylib *.dll *.so *.onnx
stat -f%z <file>

# 5. host
gh release create upscaler-assets-v1 --repo MohaElder/openenlarge \
  --title "Upscaler assets v1 ..." --notes "..." \
  libonnxruntime.dylib onnxruntime.dll libonnxruntime.so realesr-general-x4v3.onnx

# 6. paste the URLs/sha256/sizes into app/src-tauri/src/upscale/assets.rs
```

## Known follow-ups / caveats

- **Windows & Linux are CPU-only in v1.** macOS gets CoreML from the stock
  osx-arm64 build. The Windows `directml` EP we request falls back to CPU on the
  stock CPU runtime. To enable DirectML, host the
  `onnxruntime-win-x64` *DirectML* build + `DirectML.dll` as an extra asset and
  add it to `required()` / `download()` / `installed()`. Verify on real Windows
  hardware that requesting the DirectML EP on the CPU runtime falls back
  gracefully rather than erroring the session build.
- **Model license provenance.** The hosted model is a third-party mirror with no
  license file; the underlying Real-ESRGAN model is BSD-3. For a clean,
  author-attested license, re-export from the official `.pth`
  (`realesr-general-x4v3.pth`) with `dynamic_axes` on H/W and re-host.
- **Notarization.** The re-signed dylib is signed + hardened + timestamped but
  not separately notarized; library validation passes on same-team load. If a
  future macOS gate requires notarized nested code, staple-notarize the dylib
  too.
