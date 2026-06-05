# RedRoom — GPU Develop Pipeline (single-shader inversion + finishing)

**Date:** 2026-06-04
**Status:** Approved (design phase)
**Supersedes the deferred items of:** `docs/superpowers/specs/2026-06-04-redroom-zoom-perf-design.md`
(which listed "GPU/wgpu rendering" and "shared memory" as Out/later)

## Problem

Editing large DNGs (200–400 MB scans on `/Volumes/Disk2`) is slow and laggy:

1. **Every** zoom, exposure, temp, or tint change re-runs the full **CPU inversion** and ships a
   fresh base64 **JPEG** over IPC. `invert_image` is single-threaded (`pixels.iter().map(..)`,
   `engine.rs:128`) — one core, one pixel at a time, with per-pixel `log10` + 3×3 matrix math.
   These params live in `srcKey` (`Viewport.svelte:142`), so each tick = a backend round-trip.
2. Changing **view quality** (Performance↔Quality) re-decodes the whole file, because the working
   image is baked at the quality cap in `develop_image` (`commands.rs:223`, `session.rs:20`).
3. The GPU only does the cheap **finishing** layer; the heavy decode/demosaic/**inversion** are all
   CPU. The source texture is uploaded as 8-bit from a JPEG (`renderer.ts:113`).

## Goal

Move the per-pixel **develop math (inversion + finishing) onto the GPU as a single
source-of-truth shader**, used for **both live preview and full-res export**, so that:

- Zoom / pan / exposure / temp / tint / mode / stock become **GPU uniforms or texture-coordinate
  math** — no backend round-trip while editing.
- The decoded image is uploaded to the GPU **once per image** (not per frame), as a **float**
  texture — which also fixes the 8-bit-banding blocker for GPU inversion.
- View quality becomes a **GPU sampling flag**, not a re-decode.
- **All existing develop features stay intact** (see Feature Parity Checklist).

Non-goal: rewriting decode/demosaic, the SQLite catalog, or the app shell. Non-goal: WebGPU
(we extend the existing WebGL2 pipeline). Non-goal: tiled full-res live viewing (the live texture
is a bounded proxy; true full-res is export-only).

## Key decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | One combined spec for all four improvements | Coherent; #2 and #4 are the same change |
| GPU API | **Extend WebGL2** (not WebGPU) | Reuses `renderer.ts`/`shaders.ts`; works in WKWebView today |
| Source of truth | **One GLSL shader for preview AND export** | No redundant inversion implementation |
| Where the shader lives | **In the webview** (not Rust/wgpu) | Display surface is the webview canvas; avoids the Rust→webview GPU-handoff problem. Rust-GPU would need per-frame readback (kills the win) or a native-window app-shell rewrite |
| Live texture size | **Bounded proxy** (≤8192px long edge, RGBA16F) uploaded once | Avoids 0.7–1.5 GB VRAM for full-res floats; true full-res used by export only |
| Quality toggle | GPU sampling flag (mip/anisotropy/linear) | No re-decode |
| Export | **Same shader, offscreen, tiled, readback** | Preview == export by construction |
| Dust / IR | **Stay in Rust**, applied pre-invert on commit/toggle | Iterative inpainting doesn't port to a fragment shader; kept off the per-frame path |
| CPU engine | **Kept**, not deleted | Powers batch library thumbnails + doubles as the parity test oracle + GPU-unavailable fallback |

## Why Rust is still essential

The shader only takes over per-pixel develop math. Rust keeps everything a webview cannot do:

- RAW/DNG decode + demosaic (`decode.rs`, rawler) — the heavy native step.
- File I/O (reading `/Volumes/...`, writing exports), sandboxed away from the webview.
- The SQLite catalog / persistence layer.
- Export container encoding (8/16-bit TIFF, PNG, JPEG) from the GPU's returned pixels.
- The film **model**: per-stock `fit_m_post` matrix (`spectral.rs`, `calibrate.rs`), film-base
  sampling (`sample_base`), and WB resolution (`wb.rs`) — all produce **uniforms** the shader
  consumes.
- EXIF/metadata, import, and **batch library-grid thumbnails** (CPU invert/finish, headless).

## Target architecture

```
CPU (Rust, once per image)            GPU/WebGL2 (every frame)          CPU (Rust, on export)
──────────────────────────            ────────────────────────          ─────────────────────
decode + demosaic (rawler)            sample working texture            decode full-res again
  → linear f32 working buffer  ─┐       (zoom/pan = tex coords +        apply geometry (orient/
  → cap ≤8192px, downcast f16   ├──►     orient/straighten/crop UVs)      straighten/crop, CPU)
  → upload ONCE, RGBA16F tex  ──┘     INVERT pass (B/C/Naive,           upload to OFFSCREEN
                                        m_pre/m_post, base, wb,            RGBA16F framebuffer
resolve_params(thumb, base) ──────►     exposure/black/gamma)           run SAME shader, TILED
  → matrix + vec3 uniforms            FINISH pass (existing:            readPixels back to Rust
                                        tone/sat/grade/texture)         Rust stitches + encodes
dust::apply / apply_ir (pre-invert,   raw-bypass branch (uniform)        TIFF/PNG/JPEG → disk
  on commit) → re-upload tile         → canvas
```

### Data-flow changes

1. **One upload per image, not per frame.** Rust ships the linear working buffer **once** as raw
   bytes via `tauri::ipc::Response` (no base64), into an `RGBA16F` texture. Eliminates the
   per-frame JPEG encode/decode/IPC entirely.
2. **`srcKey` collapses.** After the change, only **switching images**, **committing a dust
   stroke**, or a **quality re-decode** triggers a new upload. Exposure/temp/tint/mode/stock/zoom
   all become GPU redraws, like the finishing sliders already are (`finishKey`,
   `Viewport.svelte:147`).
3. **Quality toggle = sampling flag**, not a re-decode.

## The shader (two passes)

**Why two passes, not one:** the existing finishing `FRAG` computes the texture/unsharp by
re-evaluating `finishAt` on a 3×3 neighbourhood (`shaders.ts:70–80`). If inversion were folded
inline, each pixel's inversion would run **9×** (once per neighbour sample). So inversion is a
**separate pass** writing an intermediate float texture that the finishing pass reads.

- **Pass 1 — INVERT** (new `INVERT_FRAG`): samples the `RGBA16F` working texture, runs the
  inversion, writes the inverted positive to an **intermediate `RGBA16F` framebuffer**.
  - New uniforms: `u_base` (vec3), `u_m_pre` (mat3), `u_m_post` (mat3), `u_wb` (vec3),
    `u_exposure`, `u_black`, `u_gamma` (float), `u_mode` (int: 0=B,1=C,2=Naive), `u_raw` (bool).
  - Port `invert_b` / `invert_c` / `invert_naive` and `tone()` exactly, including the `EPS=1e-5`
    clamps, `log10` (GLSL `log2(x)*0.30103`), and the `max(EPS,1.0)` guards (`engine.rs:42–97`).
  - `u_raw == true` → bypass inversion, pass the sampled scan straight through.
- **Pass 2 — FINISH** (existing `FRAG`, unchanged): reads the intermediate texture as `u_src` and
  applies `tone`, `colorGrade`, vibrance/sat, the LUT, and texture/unsharp exactly as today. When
  `u_raw`, the finishing pass is skipped and pass 1's output is shown at display gamma.

`renderer.ts` changes: upload `RGBA16F`/`HALF_FLOAT` source (requires `EXT_color_buffer_float`),
create the intermediate FBO + run the two passes, add inversion uniform setters, and add the
offscreen-FBO render path for export.

## Export (offscreen, tiled)

`export_image` no longer runs the CPU invert. Instead:

1. Rust decodes full-res, applies geometry on CPU (reuse existing `orient`/`rotate`/`crop`).
2. Applies dust/IR on the full-res **linear** buffer (Rust, pre-invert).
3. Hands the buffer to the frontend export renderer, which uploads it (in **tiles** ≤16384px) to
   an offscreen `RGBA16F` framebuffer and runs the **same** invert+finish shader per tile.
4. `readPixels` (float) → Rust stitches tiles → encodes 8/16-bit TIFF/PNG/JPEG → writes to disk.

Because preview and export run the identical shader, they match by construction (no CPU/GPU drift).

## Dust & IR (parity-preserving re-domaining)

Inpainting (`dust::inpaint_masked`, `apply_ir`, `dust.rs`) is iterative region-fill and is **not**
ported to GLSL. Instead it stays in Rust but moves:

- **When:** runs on **stroke-commit** / **IR-toggle**, not every frame.
- **Where:** applied to the **linear working buffer (pre-inversion)** instead of the inverted
  positive (today). After healing, Rust re-uploads the affected region (or the whole texture).
- **Effect:** preview and export now heal in the **same (linear, pre-invert) domain**, so they
  match exactly. For clone/fill healing this is visually equivalent to today and arguably more
  correct (heal before the non-linear transform).
- Per-frame editing never re-runs dust/IR.

## Feature Parity Checklist

Tracked literally in the implementation PR; nothing merges until every row is verified.

| Feature | After | Parity mechanism |
|---|---|---|
| Inversion Mode B / C / Naive | GLSL shader | port `engine.rs` math 1:1 (log10, EPS clamps, m_pre/m_post) |
| Stocks (Portra400, FujiC200) | Rust `fit_m_post` → mat3 uniform | matrix in Rust, consumed by shader |
| Film base (orange mask) | Rust `sample_base` → vec3 uniform | unchanged Rust |
| White balance (Kelvin/tint) | Rust `wb_from_kelvin` → vec3 uniform | unchanged Rust |
| exposure / black / gamma | shader uniforms | port `tone()` 1:1 |
| Finishing (contrast…saturation) | unchanged GLSL | ✅ already ported |
| Tone curve (master + R/G/B + region sliders) | LUT texture | ✅ already a LUT |
| Color grading (sh/mid/hi/global, blend, balance) | unchanged GLSL uniforms | ✅ already ported |
| Dust brush strokes | Rust `dust::apply`, pre-invert on commit | same algorithm, new domain |
| IR auto removal | Rust `apply_ir`, pre-invert on toggle | same algorithm, new domain |
| Geometry: orient (rot90/flip) | GPU tex-coords (preview), CPU (export) | transformed UVs |
| Geometry: straighten (angle) | GPU tex-coords (preview), CPU (export) | rotated bilinear sample |
| Geometry: persistent + view crop | GPU tex-coords (preview), CPU (export) | crop UVs |
| Raw (un-inverted) view | shader bypass branch | `u_raw` uniform |
| Histogram | from canvas | ✅ unchanged |
| Export TIFF/PNG/JPEG, 8/16-bit | GPU render → Rust encode | tiled RGBA16F readback |
| Library grid thumbnails | CPU invert/finish (kept) | doubles as test oracle |
| Performance/Quality toggle | GPU sampling flag | no re-decode |

## Precision

- Working texture and export framebuffer are **`RGBA16F`** (half-float), gated on
  `EXT_color_buffer_float`. This is the blocker that prevented GPU inversion on the current 8-bit
  JPEG texture — half-float removes shadow banding in the `log10` density math.

## Testing

- **Golden parity test (the core "check"):** render a fixture scan through the **CPU engine** and
  the **shader** at small resolution for each `{mode × stock}` combination; assert per-pixel
  channel diff < ε (ε chosen for half-float + GLSL `log2` vs `log10` rounding). This is what keeps
  the kept-CPU-oracle and the shader from drifting.
- **Existing Rust unit tests stay green** — the CPU engine is not deleted.
- **Geometry math** (UV transforms for orient/straighten/crop) unit-tested against the CPU
  `orient`/`rotate`/`crop` results.
- **Export readback** test: a small synthetic image exported via the GPU path decodes back to the
  expected pixels (round-trip through FBO + `readPixels` + encode).
- **Manual E2E** on `/Volumes/Disk2/Film Scans` DNGs: confirm smooth zoom/pan, instant
  exposure/temp/tint, quality toggle with no re-decode, dust stroke + IR toggle still heal, export
  matches preview, and walk the full Parity Checklist.

## Fallback

If WebGL2 or `EXT_color_buffer_float` is unavailable, **keep the current CPU `render_view` + JPEG
path** as a runtime fallback (feature-detected, same as `webgl2Available()` today). No GPU = old
behavior, not a broken app.

## Rollout order (within this spec)

1. **rayon-parallelize** `invert_image` / `finish_image` (`engine.rs`, `finish.rs`) — immediate
   relief on every CPU path and hardens the test oracle. Independent, low-risk, lands first.
2. **Float upload + raw IPC bytes:** Rust ships the linear working buffer once via
   `tauri::ipc::Response`; `renderer.ts` uploads `RGBA16F`.
3. **Port inversion** (B/C/Naive + `tone`) into the shader; add uniform plumbing; raw-bypass.
4. **Geometry on GPU** (orient/straighten/crop as UV transforms for preview).
5. **Dust/IR re-domaining** (pre-invert, on commit; re-upload tile).
6. **Offscreen tiled export** (same shader, FBO, readback, Rust stitch+encode).
7. **Remove the per-frame JPEG `render_view` path** from the hot path (keep it as fallback only).

## Architecture / files

```
crates/film-core/src/
├── engine.rs     rayon-parallelize invert_image; CPU engine kept as oracle/thumbnails
├── finish.rs     rayon-parallelize finish_image
└── (spectral/calibrate/wb unchanged — they feed uniforms)

app/src-tauri/src/
├── commands.rs   render_view: return raw float bytes (tauri::ipc::Response) once per image,
│                 not per-frame JPEG; export_image: drive offscreen GPU render + encode readback;
│                 dust/IR applied pre-invert on the working buffer
├── session.rs    Developed: working buffer ready for float upload (bounded cap); quality = flag
└── convert.rs    encode-from-readback helpers; geometry reused for export

app/src/lib/viewport/
├── gl/shaders.ts   ADD inversion stage + raw-bypass to FRAG; float source
├── gl/renderer.ts  RGBA16F upload; inversion uniforms; offscreen FBO + tiled export render
└── Viewport.svelte move exposure/temp/tint/mode/stock/zoom out of srcKey into GPU redraw;
                    upload-once; dust commit re-upload; quality = sampling flag
```

## Assumptions

1. WKWebView (macOS) supports WebGL2 + `EXT_color_buffer_float` for `RGBA16F` render targets.
   If not on some target, the CPU fallback covers it.
2. A bounded ≤8192px proxy is acceptable for live viewing; pixel-peeping at >100% on the largest
   scans shows the proxy, not native pixels (true native pixels are export-only). Tiled full-res
   live viewing is explicitly out of scope.
3. Shipping the linear working buffer once as raw IPC bytes is faster than today's per-frame
   base64 JPEG; if the one-time upload is too large, downcasting to f16 in Rust halves it.
4. GLSL `log2(x)*0.30103` matches Rust `log10` within the chosen parity ε at half-float precision.
```