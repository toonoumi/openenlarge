# HDR Support — Design Spec

**Date:** 2026-06-16
**Status:** agreed design (sub-project 1), ready for implementation plan
**Scope of THIS spec:** sub-project 1 — the **HDR preview toggle**. Sub-projects 2 (HDR export) and 3 (HDR-aware editing) are scoped at the end and get their own spec/plan cycles.

---

## 1. Goal

A per-image **HDR toggle** (button left of the Reset button in the Basic panel). When on, the viewport preview shows the image in **true HDR** — highlights glow brighter than SDR white on HDR-capable displays — while editing stays real-time. The same render/encoder later powers HDR file export (sub-project 2).

## 2. Feasibility (verified) and platform reality

A live HDR **canvas** is NOT possible in our webview (WebKit/WKWebView doesn't implement the HDR-canvas APIs; Tauri/wry don't opt the layer into EDR). But WebKit **does** render a **gain-map HDR `<img>`** as true EDR — **verified on macOS 26 + XDR via an in-app spike** (a CoreImage-generated gain-map JPEG glowed brighter than `#fff`).

So HDR display = **encode a gain-map image, show it in an `<img>`** (not a live canvas). Platform behavior:

| Platform (webview) | Encode gain-map file | Show HDR in-app |
|---|---|---|
| macOS (WKWebView) | ✅ | ✅ **verified** |
| Windows (WebView2 = Chromium) | ✅ | ✅ very likely (unverified HW) — run the same spike before claiming |
| Linux (WebKitGTK) | ✅ | ⚠️ likely SDR-only (Linux desktop HDR immature) — **graceful**: `<img>` shows its SDR base, no breakage |

**Cross-platform decision:** use **`libultrahdr`** (cross-platform gain-map JPEG encoder; Rust FFI crate `ultrahdr` or pure-Rust `ultrahdr-rs`) — one code path on all three OSes. HDR display lights up where the platform supports EDR; export (sub-project 2) produces a real HDR file everywhere regardless.

## 3. Architecture / data flow (settle mode)

Editing is unchanged: the live **SDR WebGL canvas** renders in real time as today. HDR is a **settle-on-gesture-end** preview:

1. `hdr` is on (per-image toggle).
2. User drags a slider/curve → live SDR canvas updates per frame (the `<img>` overlay is hidden during the gesture).
3. On gesture end (the existing `pointerup` / `change` commit trigger in `+page.svelte`), the frontend calls a backend command **`encode_hdr(id, params, view) → blob-url/bytes`**, then sets the HDR `<img src>` to the returned gain-map JPEG and **crossfades it over the canvas (~150 ms)**.
4. Next gesture → hide `<img>`, show live canvas. Repeat.

**Encoder input = two renditions** (the gain map is `HDR / SDR`):
- **SDR base** = today's soft-clipped output (the current look — full back-compat for SDR viewers).
- **HDR rendition** = the expanded-highlight output (§4).

**Default mechanism (chosen): backend CPU render.** `encode_hdr` renders the working image at preview size on the CPU twice — once SDR (`hdr=false`), once HDR (`hdr=true`) — via the existing `invert_image` + `finish_image` path (the same one `render_view`'s CPU branch uses, which is in parity with the GPU shader), then feeds both to `libultrahdr`. This reuses tested code and needs no GPU→JS→backend readback plumbing; the cadence is debounced/preview-size so CPU cost is fine. (Alternative, if fidelity ever demands the exact GPU result: read back the GPU float buffer via `renderProcessed(bit16=true)` and derive the SDR base — not needed initially.)

Debounce so rapid consecutive commits coalesce (encode only the latest). The `<img>` carries CSS `dynamic-range-limit: no-limit` so it presents full headroom.

## 4. The HDR mechanism — highlight expansion

Today `invert_d` caps highlights at ~1.0 via the `soft_clip` rolloff, so the float output has **no headroom** — a gain map computed from it would be all 1.0 (no HDR). HDR mode changes the highlight handling:

- **Below a knee** (e.g. `HDR_KNEE ≈ 0.8` in output): unchanged — identical to the SDR result.
- **Above the knee:** instead of compressing toward 1.0, **expand** smoothly into `[1.0 … HDR_HEADROOM]` (a tunable ceiling, ≈ 2–3 stops → ~2.0–4.0 linear), so speculars / light sources / blown sky exceed SDR white. Continuous and monotonic at the knee.
- The **SDR base** for the gain map = today's clamped/soft-clipped output (unchanged → SDR viewers see the current look, full back-compat). The **HDR rendition** = the expanded-highlight output. `libultrahdr` stores `gain = HDR / SDR`.

This lives in **both** `crates/film-core/src/engine.rs` (`invert_d`, for the export/backend render) **and** `app/src/lib/viewport/gl/shaders.ts` (`INVERT_FRAG` Mode-D branch, for the live/readback path), kept in **parity**, gated by an `hdr` flag + `headroom`/`knee` threaded through `InversionParams` → `ResolvedInversion` uniforms (mirror how `d_max`/`soft_clip` already flow). `HDR_KNEE` / `HDR_HEADROOM` are **tuned by a controller-driven visual pass** on the user's real DNGs (as with the Cineon tone defaults), not guessed once.

## 5. Toggle + state

- A button **left of the Reset button** in `Basic.svelte`'s `.head` row (the row that currently holds the section toggle + Reset). Clear on/off state styling (reuse the accent-on pattern, e.g. like `.wbdrop.on`).
- New `hdr: bool` field on `InvertParams` (`session.rs`), `#[serde(default)]` for back-compat; added to `default_invert_params()` (default `false`) and the TS `defaultParams()`/type and `commands_test_support`.
- Toggling commits to history (undoable, like other param changes).

## 6. Encoder dependency

- Add `libultrahdr` via the `ultrahdr` Rust crate (FFI) or `ultrahdr-rs` (pure Rust) — the plan picks based on build friction across mac/win/linux (pure-Rust avoids a C++ build). Input: the HDR float rendition (+ SDR base); output: gain-map JPEG bytes (ISO 21496-1, which also carries Apple/Adobe metadata for the widest viewer support).
- One backend module (e.g. `app/src-tauri/src/hdr.rs`) wrapping "render SDR+HDR → encode gain-map JPEG", used by both the preview command (this spec) and export (sub-project 2).

## 7. Testing & validation

- **Unit (film-core):** the highlight-expansion function — `≤1.0` and identical to SDR below the knee; continuous/monotonic at the knee; reaches ~`HDR_HEADROOM` at the densest input; `hdr=false` reproduces today's `invert_d` exactly (regression guard).
- **Parity:** GPU uniform tests confirm the `hdr`/`headroom`/`knee` flags reach `ResolvedInversion`; CPU↔GPU branch agreement on a probe pixel.
- **Encoder:** a test that `encode_hdr` produces a JPEG containing a gain map (assert the gain-map marker/metadata, like the spike checked).
- **Visual (controller-driven):** invert a few real DNGs with HDR on, encode, and confirm via the spike-style `<img>` that highlights glow; tune `HDR_KNEE`/`HDR_HEADROOM`.
- **Cross-platform:** export/encode path compiles + runs on macOS now; note Windows/Linux verification as follow-up.

## 8. Out of scope (own specs/plans later)

- **Sub-project 2 — HDR export:** reuse §6's encoder; add an "HDR (gain-map JPEG)" option in `ExportModal.svelte` + the export commands (`export_image`/`export_begin`). Largely independent; the file is HDR on all platforms.
- **Sub-project 3 — HDR-aware editing:** exposure / whites / highlights / tone-curve operate into the headroom, and the tone-curve UI represents the >1.0 region. Refines how much of the edit lives in HDR.
- A live HDR **canvas** (blocked in WKWebView; possible on Windows/Chromium but not worth a second display path now).
- Non-gain-map HDR formats (PQ/HLG AVIF/HEIC) for export.

## 9. Key code references (verify before editing)

- `crates/film-core/src/engine.rs` — `invert_d` (highlight soft-clip), `InversionParams` (add hdr/headroom/knee fields).
- `app/src/lib/viewport/gl/shaders.ts` — `INVERT_FRAG` Mode-D branch (mirror the expansion); `gl/invert.ts` + `gpu_upload.rs` `ResolvedInversion`/`resolve_to_uniforms` (thread the flags).
- `app/src/lib/viewport/gl/renderer.ts` — `renderProcessed`/16-bit readback (preview source).
- `app/src-tauri/src/commands.rs` — `build_params`/`resolve_params`/`develop_heavy`; add `encode_hdr` command (register in `lib.rs`); new `hdr.rs` module.
- `app/src-tauri/src/session.rs` — `InvertParams` (+ `hdr`; has long-lived `cargo fmt` WIP → stash when editing).
- `app/src/lib/develop/Basic.svelte` — the `.head` row (toggle left of Reset); `app/src/lib/api.ts` (`hdr` field + `encodeHdr` binding).
- `app/src/lib/tabs/Develop.svelte` / `Viewport.svelte` — the HDR `<img>` overlay + crossfade + settle-on-commit wiring.
- `i18n-strings.csv` (+ `scripts/gen-i18n.py`) for the toggle label/tooltip — **edit the CSV, regenerate; never edit `dict.ts` directly**.
