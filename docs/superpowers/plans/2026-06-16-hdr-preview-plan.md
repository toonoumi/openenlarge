# HDR Preview Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-image **HDR toggle** (button left of Reset) that previews the image in true HDR via an encoded gain-map `<img>` overlay — live SDR editing, crossfade to HDR on gesture-end ("settle mode").

**Architecture:** The live WebGL viewport stays **SDR** (the webview can't do a live HDR canvas). HDR mode adds a **highlight-expansion** in the CPU inverter (`invert_d`, gated by `InversionParams.hdr`) so highlights exceed 1.0. A backend `encode_hdr` command CPU-renders the image twice — SDR base + HDR rendition — and encodes a **gain-map JPEG** (via the `ultrahdr` crate → libultrahdr), which the frontend shows in an `<img>` over the canvas, refreshed (debounced) on each edit's gesture-end. No GPU/shader changes.

**Tech Stack:** Rust (`film-core` + `app/src-tauri`), `ultrahdr` crate (FFI to libultrahdr), TypeScript/Svelte/WebGL2.

**Spec:** `docs/superpowers/specs/2026-06-16-hdr-design.md`

**Concurrency/WIP:** the user runs a parallel session committing to `main`, and keeps `cargo fmt` WIP in `app/src-tauri/src/session.rs`. ALWAYS commit explicit paths (`git commit -- <paths>`), never `git add -A`; stash `session.rs` when editing it (see Task 4). i18n strings are generated — **edit `/i18n-strings.csv` + run `python3 scripts/gen-i18n.py`, never `dict.ts` directly**.

**Verification commands:**
- `cargo test -p film-core`
- `cargo test --manifest-path app/src-tauri/Cargo.toml`
- `cargo build --manifest-path app/src-tauri/Cargo.toml`
- `cd app && npx vitest run src/lib/viewport/gl/ && npm run check`

---

## Phase A — Encoder (de-risk first)

### Task 1: `encode_gain_map_jpeg` via the `ultrahdr` crate

**Files:**
- Create: `app/src-tauri/src/hdr.rs`
- Modify: `app/src-tauri/src/Cargo.toml` (add `ultrahdr`), `app/src-tauri/src/lib.rs` (add `mod hdr;`)
- Test: in `hdr.rs`

**Interface (the rest of the plan depends only on this signature):**
```rust
/// Encode an HDR gain-map JPEG from an SDR base + an HDR rendition (same dims).
/// `sdr`/`hdr` are linear-RGB Images (f32, 0..1 for sdr, 0..~headroom for hdr).
/// Returns JPEG bytes containing an ISO 21496-1 / Apple gain map.
pub fn encode_gain_map_jpeg(sdr: &film_core::Image, hdr: &film_core::Image, quality: u8) -> Result<Vec<u8>, String>
```

> **This task is a spike + implement.** `ultrahdr` 0.1.5 is an FFI binding to libultrahdr; its exact `Encoder`/`RawImage`/`ColorTransfer` API and build requirements (it may need cmake/a C++ toolchain) are **not pre-verified**. Confirm the API against `https://docs.rs/ultrahdr/0.1.5/ultrahdr/` (the `Encoder`, `RawImage`/`OwnedPackedImage`, `ImgFormat`, `ColorTransfer` items) as the first step. **Fallback if the cross-platform FFI build is too painful:** implement the same `encode_gain_map_jpeg` interface with macOS CoreImage (`CIContext.writeJPEGRepresentation(of: sdrCIImage, ... options: [.hdrImage: hdrCIImage])` via an `objc2`/swift bridge — proven working in the feasibility spike). If you take the fallback, gate it `#[cfg(target_os = "macos")]` and STOP to report so we decide on non-mac platforms.

- [ ] **Step 1: Add the dependency.** In `app/src-tauri/Cargo.toml` add `ultrahdr = "0.1"` (confirm latest 0.1.x). Run `cargo build --manifest-path app/src-tauri/Cargo.toml` to confirm it builds on this machine (FFI may pull/build libultrahdr — if it fails, that's the signal to evaluate the CoreImage fallback; report).

- [ ] **Step 2: Write the failing test** (in `hdr.rs`):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use film_core::Image;

    fn solid(w: usize, h: usize, c: [f32; 3]) -> Image {
        Image { width: w, height: h, pixels: vec![c; w * h], ir: None }
    }

    #[test]
    fn encode_gain_map_jpeg_emits_a_gain_map() {
        // SDR white base + an HDR rendition 2x brighter → a non-trivial gain map.
        let sdr = solid(64, 64, [0.9, 0.9, 0.9]);
        let hdr = solid(64, 64, [1.8, 1.8, 1.8]);
        let bytes = encode_gain_map_jpeg(&sdr, &hdr, 90).expect("encode");
        assert!(bytes.len() > 1000, "got {} bytes", bytes.len());
        // JPEG SOI marker.
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "not a JPEG");
        // Gain-map metadata marker (ISO 21496-1 'urn:iso' or Apple 'hdrgainmap'),
        // mirroring the feasibility-spike check (`strings | grep gainmap`).
        let hay = bytes.windows(1).map(|b| b[0]).collect::<Vec<u8>>();
        let needle_iso = b"urn:iso";
        let needle_apple = b"hdrgainmap";
        let has = hay.windows(needle_iso.len()).any(|w| w == needle_iso)
            || hay.windows(needle_apple.len()).any(|w| w == needle_apple);
        assert!(has, "no gain-map metadata in output");
    }
}
```

- [ ] **Step 3: Run it to confirm it fails** (function undefined): `cargo test --manifest-path app/src-tauri/Cargo.toml encode_gain_map_jpeg_emits` → FAIL.

- [ ] **Step 4: Implement `encode_gain_map_jpeg`** in `hdr.rs` using the confirmed `ultrahdr` API: convert `sdr` → packed 8-bit sRGB `RawImage`; convert `hdr` → a packed HDR `RawImage` (float or half, linear/PQ per the crate's `ColorTransfer` — pick what the crate expects for an HDR intent image); configure the `Encoder` with both, encode, return the JPEG bytes. Add `pub mod hdr;` is not needed — add `mod hdr;` (or `pub mod hdr;` if `encode_hdr` lives elsewhere) to `lib.rs`.

- [ ] **Step 5: Run the test** → PASS. Run full `cargo test --manifest-path app/src-tauri/Cargo.toml` → green.

- [ ] **Step 6: Commit**
```bash
git add app/src-tauri/src/hdr.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/lib.rs
git commit -m "feat(hdr): gain-map JPEG encoder (ultrahdr)" -- app/src-tauri/src/hdr.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/lib.rs
```

---

## Phase B — HDR highlight expansion (film-core)

### Task 2: `invert_d` highlight expansion gated by `InversionParams.hdr`

**Files:**
- Modify: `crates/film-core/src/engine.rs` (`InversionParams`, its `Default`, `invert_d`)
- Test: `crates/film-core/src/engine.rs` tests

- [ ] **Step 1: Add fields + constants.** In `engine.rs`, add to `InversionParams` (after `soft_clip`):
```rust
    /// HDR mode: expand highlights above the knee into [knee, HDR_HEADROOM] instead
    /// of the SDR soft-clip toward 1.0. Used only for the HDR rendition (encode_hdr).
    pub hdr: bool,
```
Add to `impl Default for InversionParams` (`hdr: false,`). Add module constants near `EPS`:
```rust
/// HDR highlight expansion: output above this knee is remapped into [knee, HDR_HEADROOM].
const HDR_KNEE: f32 = 0.8;
/// HDR headroom ceiling (linear, ~1.3 stops over SDR white). Tuned on real scans (plan Task 7).
const HDR_HEADROOM: f32 = 2.5;
```

- [ ] **Step 2: Write the failing tests:**
```rust
    #[test]
    fn invert_d_hdr_false_matches_today() {
        let p = InversionParams { base: [0.7, 0.6, 0.5], ..Default::default() };
        let phdr = InversionParams { hdr: false, ..p.clone() };
        for probe in [[0.05, 0.04, 0.03], [0.3, 0.25, 0.2], [0.69, 0.59, 0.49]] {
            assert_eq!(invert_d(probe, &p), invert_d(probe, &phdr), "hdr=false must equal default");
        }
    }

    #[test]
    fn invert_d_hdr_expands_highlights_above_knee() {
        // A very dense negative (near base*tiny) → brightest output. In HDR it must
        // exceed 1.0 (toward HDR_HEADROOM); in SDR it stays <= ~1.0.
        let base = [0.7, 0.6, 0.5];
        let bright_neg = [0.7 * 1e-3, 0.6 * 1e-3, 0.5 * 1e-3]; // dense → bright positive
        let sdr = invert_d(bright_neg, &InversionParams { base, hdr: false, ..Default::default() });
        let hdr = invert_d(bright_neg, &InversionParams { base, hdr: true, ..Default::default() });
        assert!(sdr[0] <= 1.0001, "SDR highlight should cap ~1.0: {}", sdr[0]);
        assert!(hdr[0] > 1.05, "HDR highlight should exceed 1.0: {}", hdr[0]);
        assert!(hdr[0] <= 2.5001, "HDR highlight capped at headroom: {}", hdr[0]);
    }

    #[test]
    fn invert_d_hdr_below_knee_unchanged() {
        // A mid pixel whose output is below the knee must be identical in HDR and SDR.
        let base = [0.7, 0.6, 0.5];
        let mid = [0.35, 0.30, 0.25];
        let sdr = invert_d(mid, &InversionParams { base, hdr: false, ..Default::default() });
        let hdr = invert_d(mid, &InversionParams { base, hdr: true, ..Default::default() });
        if sdr[0] < 0.8 { // only assert when genuinely below the knee
            assert!((sdr[0] - hdr[0]).abs() < 1e-5, "below-knee differs: {} vs {}", sdr[0], hdr[0]);
        }
    }
```
(Note: `InversionParams` must derive/allow `.clone()` — it already does `#[derive(Clone)]`.)

- [ ] **Step 3: Run → FAIL** (`hdr` field missing): `cargo test -p film-core invert_d_hdr` → FAIL.

- [ ] **Step 4: Implement.** In `invert_d`, replace the final soft-clip block. Current tail:
```rust
        let out = (print_lin * p.wb[c]).powf(p.paper_grade);
        if out > p.soft_clip {
            let comp = (1.0 - p.soft_clip).max(EPS);
            p.soft_clip + (1.0 - (-(out - p.soft_clip) / comp).exp()) * comp
        } else {
            out
        }
```
becomes:
```rust
        let out = (print_lin * p.wb[c]).powf(p.paper_grade);
        if p.hdr {
            // HDR: expand highlights above the knee into [knee, HDR_HEADROOM] so
            // speculars/lights exceed SDR white (the gain map captures this headroom).
            if out > HDR_KNEE {
                let t = ((out - HDR_KNEE) / (1.0 - HDR_KNEE)).clamp(0.0, 1.0);
                HDR_KNEE + t * (HDR_HEADROOM - HDR_KNEE)
            } else {
                out
            }
        } else if out > p.soft_clip {
            let comp = (1.0 - p.soft_clip).max(EPS);
            p.soft_clip + (1.0 - (-(out - p.soft_clip) / comp).exp()) * comp
        } else {
            out
        }
```

- [ ] **Step 5: Run → PASS.** `cargo test -p film-core invert_d_hdr` then full `cargo test -p film-core`. (The existing `mode_d_*` tests use `hdr=false` default → unaffected.)

- [ ] **Step 6: Commit**
```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): HDR highlight expansion in invert_d (gated by hdr)" -- crates/film-core/src/engine.rs
```

---

## Phase C — Backend command

### Task 3: `encode_hdr` command (CPU dual-render → gain-map JPEG)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add `encode_hdr`), `app/src-tauri/src/lib.rs` (register)
- (uses Task 1 `hdr::encode_gain_map_jpeg`, Task 2 `InversionParams.hdr`)

**Background:** `render_view` already CPU-renders a developed image (geometry → crop → `invert_image` → `finish_image` → JPEG). `encode_hdr` mirrors it but produces TWO float renditions (SDR + HDR) and returns a gain-map JPEG (base64 data URL, so the frontend can set `<img src>` directly).

- [ ] **Step 1: Add the command** (model the geometry/crop/scale on `render_view`; reuse its `ViewSpec`). After `render_view`:
```rust
/// Render the developed image (geometry + crop + develop params) twice — SDR base
/// and HDR rendition — and return a gain-map JPEG as a data URL for an <img>.
#[tauri::command]
pub fn encode_hdr(
    id: String,
    params: InvertParams,
    view: ViewSpec,
    session: State<Session>,
) -> Result<String, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;

    // Geometry + crop + scale exactly as render_view does (orient → straighten →
    // persistent crop → view crop → resize_to(out_w,out_h)). Factor render_view's
    // geometry into a shared helper OR inline the same steps to produce `scaled`.
    let scaled = crate::commands::render_geometry(dev, &view)?; // see note below

    let base = effective_base(&params, dev.base);
    let mut ip = build_params(&params, base);
    ip.wb = wb_from_params(params.temp, params.tint);
    ip.d_max = effective_dmax(&params, dev.d_max);

    let sdr = finish_image(&invert_image(&scaled, &ip, mode_from(&params.mode)), &finish_from(&params));
    let mut ip_hdr = ip.clone();
    ip_hdr.hdr = true;
    let hdr = finish_image(&invert_image(&scaled, &ip_hdr, mode_from(&params.mode)), &finish_from(&params));

    let jpeg = crate::hdr::encode_gain_map_jpeg(&sdr, &hdr, PREVIEW_JPEG_QUALITY)?;
    use base64::Engine;
    Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpeg)))
}
```
> **Note (geometry reuse):** `render_view` currently inlines orient → straighten → crop → resize. Extract that into a small helper `fn render_geometry(dev: &Developed, view: &ViewSpec) -> Result<Image, String>` and call it from both `render_view` and `encode_hdr` (DRY). If extraction is risky mid-task, inline the identical steps in `encode_hdr` and note it as a `DONE_WITH_CONCERNS` cleanup. `finish_from`/`finish_image`/`invert_image`/`mode_from`/`build_params`/`effective_base`/`effective_dmax`/`wb_from_params`/`PREVIEW_JPEG_QUALITY` all already exist in `commands.rs`. `base64` is already a dependency (used by `to_jpeg_b64`); reuse the same encoding call style as `to_jpeg_b64`.

- [ ] **Step 2: Register** `commands::encode_hdr,` in the `tauri::generate_handler![...]` list in `lib.rs`.

- [ ] **Step 3: Build** `cargo build --manifest-path app/src-tauri/Cargo.toml` → clean. Run `cargo test --manifest-path app/src-tauri/Cargo.toml` → green (no new unit test required; `encode_gain_map_jpeg` is tested in Task 1, geometry in render_view's existing tests; the command is thin glue).

- [ ] **Step 4: Commit**
```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(hdr): encode_hdr command (SDR+HDR dual render -> gain-map data URL)" -- app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
```

---

## Phase D — Frontend

### Task 4: `hdr` wire field + API binding

**Files:**
- Modify: `app/src-tauri/src/session.rs` (`InvertParams` — **stash WIP first**), `app/src-tauri/src/commands.rs` (`default_invert_params`), `app/src-tauri/src/commands_test_support` inline (`sample_invert_params`), `app/src/lib/api.ts`

- [ ] **Step 1: session.rs (WIP stash).** `git status --short app/src-tauri/src/session.rs`; if modified, `git stash push -- app/src-tauri/src/session.rs`. Add to `InvertParams` (after `wb_manual` or near `d_max_override`):
```rust
    /// HDR preview toggle (per image). Frontend-only trigger for the gain-map
    /// overlay + encode_hdr; the live render stays SDR regardless.
    #[serde(default)]
    pub hdr: bool,
```

- [ ] **Step 2: defaults.** In `commands.rs` `default_invert_params()` add `hdr: false,`. In the inline `sample_invert_params()` test helper (in `lib.rs`) add `hdr: false,` if it constructs the struct literally (it delegates to `default_invert_params` — likely no change; verify).

- [ ] **Step 3: api.ts.** Add `hdr: boolean;` to the `InvertParams` type; `hdr: false` in `defaultParams()`. Add:
```ts
encodeHdr(id: string, params: InvertParams, view: ViewSpec) {
  return invoke<string>("encode_hdr", { id, params, view });
}
```
(Match the existing `renderView`/`ViewSpec` typing.)

- [ ] **Step 4: Build/check.** `cargo test --manifest-path app/src-tauri/Cargo.toml` (serde-default test still green); `cd app && npm run check` (0 errors). Then `git stash pop` if you stashed.

- [ ] **Step 5: Commit** (explicit paths; do NOT sweep session.rs fmt WIP):
```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src/lib/api.ts
git commit -m "feat(hdr): hdr wire field + encodeHdr API binding" -- app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src/lib/api.ts
```

### Task 5: HDR toggle button (left of Reset)

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte` (the `.head` row), `i18n-strings.csv` (+ regenerate)

- [ ] **Step 1: i18n.** Add to `i18n-strings.csv`:
```
basic.hdr,"HDR","HDR","src/lib/develop/Basic.svelte","toggle"
basic.hdrTitle,"Preview in HDR (toggle)","以 HDR 预览（切换）","src/lib/develop/Basic.svelte","tooltip"
```
Run `python3 scripts/gen-i18n.py`.

- [ ] **Step 2: Toggle button.** In `Basic.svelte`'s `.head` row (currently `[section toggle] … [Reset]`), add an HDR toggle button immediately LEFT of the Reset button:
```svelte
  <span class="headbtns">
    <button class="hdrtoggle" class:on={$params.hdr}
            title={$t('basic.hdrTitle')}
            on:click={() => { params.update((p) => ({ ...p, hdr: !p.hdr })); commitActive(); }}>
      {$t('basic.hdr')}
    </button>
    <button class="reset" on:click={resetBasic}>{$t('basic.reset')}</button>
  </span>
```
(Wrap the existing Reset button + the new toggle in a flex `.headbtns` span so they sit together on the right; keep the section toggle on the left.) Add CSS for `.headbtns { display:inline-flex; gap:6px; align-items:center; }` and `.hdrtoggle` mirroring `.reset` styling + an `.hdrtoggle.on` accent state (like `.wbdrop.on`: `color:#fff; border-color:var(--accent); background:rgba(244,157,78,0.18);`). `commitActive` is already imported.

- [ ] **Step 3: Verify** `cd app && npm run check` (0 errors) + `npx vitest run src/lib/viewport/gl/` (pass).

- [ ] **Step 4: Commit**
```bash
git add app/src/lib/develop/Basic.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(ui): HDR toggle button (left of Reset)" -- app/src/lib/develop/Basic.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
```

### Task 6: HDR `<img>` overlay + settle-on-commit + crossfade

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte` (and/or `app/src/lib/viewport/Viewport.svelte`)

This wires the settle behavior. Explore the current `Develop.svelte`/`Viewport.svelte` structure first; the steps below are the contract.

- [ ] **Step 1: Overlay element.** In the viewport area (over the WebGL canvas), add an absolutely-positioned `<img class="hdr-overlay" />` that is shown only when `$params.hdr` and a gain-map data URL is available. CSS: `position:absolute; inset:0; object-fit:contain; dynamic-range-limit: no-limit; transition: opacity 150ms;` opacity 0/1 for crossfade.

- [ ] **Step 2: Encode on settle.** When `$params.hdr` is on, after an edit gesture ends, call `api.encodeHdr($activeId, effParams, view)` (the same `view`/`ViewSpec` the viewport uses for `renderView`), set the `<img src>` to the returned data URL, and fade the overlay in. Trigger points: reuse the existing commit signal (the app already commits on `pointerup`/`change` in `+page.svelte`; subscribe to that or to a `developRev`/params-settled signal). **Debounce ~200 ms** so rapid commits coalesce — encode only the latest.

- [ ] **Step 3: Hide during active edits.** While a gesture is in progress (e.g. `pointerdown` on a slider/canvas until `pointerup`), fade the overlay OUT so the live SDR canvas shows real-time; fade back in after the debounced encode completes. Toggling `$params.hdr` off hides the overlay entirely.

- [ ] **Step 4: Verify** `cd app && npm run check` (0 errors) + `npx vitest run src/lib/viewport/gl/` (pass). Manual smoke happens in Task 7.

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/tabs/Develop.svelte app/src/lib/viewport/Viewport.svelte
git commit -m "feat(hdr): gain-map <img> overlay with settle-mode crossfade" -- app/src/lib/tabs/Develop.svelte app/src/lib/viewport/Viewport.svelte
```

---

## Phase E — Tune & verify

### Task 7: Controller-driven HDR tuning + full smoke

> **Not a subagent task** — the controller drives the visual tuning of `HDR_KNEE`/`HDR_HEADROOM` (eyeballing real scans), as with the Cineon tone tuning.

- [ ] **Step 1: Full automated sweep:**
```bash
cargo test -p film-core
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
cd app && npx vitest run src/lib/viewport/gl/ && npm run check
```
All green; build clean (only the 2 known session.rs warnings).

- [ ] **Step 2: Visual tuning (controller).** Using a harness (extend `crates/film-core/examples/`), invert a few real DNGs with `hdr=true`, encode via `encode_gain_map_jpeg`, and view the gain-map JPEG in the spike-style `<img>` to confirm highlights glow and the look is natural; adjust `HDR_KNEE`/`HDR_HEADROOM` (engine constants) — don't overfit; check several scans. Commit any constant changes (`crates/film-core/src/engine.rs`).

- [ ] **Step 3: Manual smoke (real app, XDR display).** `npm run tauri dev`; develop an image; toggle **HDR** (button left of Reset). Confirm: live SDR while dragging a slider; on release the preview crossfades to HDR with highlights glowing brighter than white; toggling off returns to SDR; the toggle is undoable (Cmd+Z); switching images doesn't break it.

- [ ] **Step 4: Commit any smoke fixes; stop.** HDR preview toggle complete. Next: sub-project 2 (HDR export — reuse `encode_gain_map_jpeg` in the export modal/commands), then sub-project 3 (HDR-aware editing).

---

## Self-review notes
- **Spec coverage:** §3 settle-mode (Tasks 5–6), §4 highlight expansion (Task 2), §5 toggle+state (Tasks 4–5), §6 encoder (Task 1), §7 testing (Tasks 1,2 unit + Task 7 visual/smoke). The spec's "encode_hdr CPU dual-render default" = Task 3. GPU shader parity is intentionally NOT needed (live viewport stays SDR; HDR is CPU-rendered for the gain map) — noted in Architecture.
- **Type consistency:** `InversionParams.hdr: bool` (engine) ↔ `InvertParams.hdr: bool` (wire) ↔ `hdr: boolean` (TS); `encode_gain_map_jpeg(sdr,hdr,quality)->Vec<u8>` used by `encode_hdr`; `encode_hdr(id,params,view)->String` (data URL) ↔ `api.encodeHdr`. `HDR_KNEE`/`HDR_HEADROOM` engine constants.
- **Risk:** Task 1 (ultrahdr FFI build + exact API) is the de-risk-first task with a documented CoreImage fallback; everything downstream depends only on `encode_gain_map_jpeg`'s signature, so a fallback impl doesn't ripple.
- **No cache/parity impact:** no `Developed`/cache change; no GPU shader/uniform change (live path untouched).
