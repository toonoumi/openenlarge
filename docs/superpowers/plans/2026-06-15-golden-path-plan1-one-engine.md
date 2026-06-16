# Plan 1 — One Inversion Engine (Cineon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Kodak Cineon / negadoctor model (`Mode::D`) the single inversion path the app ever runs, remove the engine toggle and film-stock dropdown from the UI, and delete the now-dead Mode B/C/Naive and spectral-stock code.

**Architecture:** The app already has a correct Cineon inverter (`invert_d` + the shader's `u_mode==3` branch). This plan flips all param construction and mode resolution to Cineon unconditionally, strips the now-unused UI controls, then removes the dead engine modes and the spectral stock model. `D_max` stays at its current default (`2.0`); auto-deriving it per-roll is Plan 2, where it can be made crop-aware. The `stock`/`mode`/`black`/`gamma` fields stay in the wire contract (`InvertParams`) so old catalog blobs still deserialize, but the backend stops reading them.

**Tech Stack:** Rust (`film-core` crate + `app/src-tauri` Tauri backend), TypeScript/Svelte frontend, WebGL2 GLSL shaders.

**Verification commands (used throughout):**
- `cargo test -p film-core`
- `cargo test --manifest-path app/src-tauri/Cargo.toml`
- `cargo build --manifest-path app/src-tauri/Cargo.toml`
- `cd app && npx vitest run src/lib/viewport/gl/ && npm run check`

---

## Phase A — Route everything through Cineon (backend)

### Task 1: `build_params` always builds Cineon params

**Files:**
- Modify: `app/src-tauri/src/commands.rs:211-232` (`build_params`)
- Test: `app/src-tauri/src/commands.rs` (tests module at `:1305`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `commands.rs`:

```rust
    #[test]
    fn build_params_is_always_cineon_regardless_of_mode_or_stock() {
        use crate::commands_test_support::sample_invert_params;
        // Even with the legacy Mode-B + Portra selection, we now build Cineon params:
        // identity matrices, d_max at the default, exposure → print_exposure (2^ev).
        let mut p = sample_invert_params();
        p.mode = "b".into();
        p.stock = "portra400".into();
        p.exposure = 1.0; // 1 EV → 2.0x print exposure
        let ip = build_params(&p, [0.8, 0.6, 0.4]);
        assert_eq!(ip.base, [0.8, 0.6, 0.4]);
        assert!((ip.print_exposure - 2.0).abs() < 1e-5, "exposure → print_exposure");
        assert!((ip.d_max - 2.0).abs() < 1e-6, "d_max default");
        assert!((ip.paper_grade - 0.5).abs() < 1e-6, "paper_grade default");
        assert_eq!(ip.m_post, nalgebra::Matrix3::identity(), "no stock matrix");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml build_params_is_always_cineon`
Expected: FAIL — current `build_params` routes `mode=="b"`+Portra through `params_for_stock`, producing a non-identity `m_post` and `exposure` (not `print_exposure`).

- [ ] **Step 3: Rewrite `build_params`**

Replace `commands.rs:211-232` with:

```rust
pub(crate) fn build_params(p: &InvertParams, base: [f32; 3]) -> InversionParams {
    // One engine: Kodak Cineon (negadoctor). The exposure slider drives print
    // exposure; d_max/paper_* come from InversionParams::Default; WB is set by the
    // caller (resolve_params / resolve_to_uniforms). `stock`/`mode`/`black`/`gamma`
    // are vestigial — kept in the wire contract for back-compat, no longer read.
    InversionParams {
        base,
        print_exposure: 2f32.powf(p.exposure), // EV stops → linear print exposure
        ..Default::default()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml build_params_is_always_cineon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "refactor(engine): build_params always constructs Cineon params"
```

---

### Task 2: `mode_from` always resolves to Cineon

**Files:**
- Modify: `app/src-tauri/src/commands.rs:203-209` (`mode_from`)
- Test: `app/src-tauri/src/commands.rs` (tests module)

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn mode_from_is_always_cineon() {
        use film_core::engine::Mode;
        for s in ["b", "c", "d", "naive", "anything"] {
            assert_eq!(mode_from(s), Mode::D, "mode {s} must resolve to Cineon");
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml mode_from_is_always_cineon`
Expected: FAIL — `mode_from("c")` currently returns `Mode::C`.

- [ ] **Step 3: Rewrite `mode_from`**

Replace `commands.rs:203-209` with:

```rust
pub(crate) fn mode_from(_s: &str) -> Mode {
    // One engine. The `mode` wire field is vestigial; always Cineon.
    Mode::D
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml mode_from_is_always_cineon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "refactor(engine): mode_from always resolves to Cineon"
```

---

### Task 3: Fix the GPU-uniform tests that assumed Mode B/C

**Files:**
- Modify: `app/src-tauri/src/gpu_upload.rs:314-326` (`uniforms_none_stock_mode_c_is_identity_matrices_mode_1`)
- Modify: `app/src-tauri/src/gpu_upload.rs:384-394` (`uniforms_portra_mode_b_fits_nonidentity_mpost_mode_0`)

These two tests now contradict the one-engine rule (they expect `mode==1`/`mode==0`). Both must assert Cineon (`mode==3`) with identity matrices.

- [ ] **Step 1: Replace the two tests**

Replace `uniforms_none_stock_mode_c_is_identity_matrices_mode_1` (`:314-326`) with:

```rust
    #[test]
    fn uniforms_always_cineon_mode_3_identity_matrices() {
        let mut p = sample_invert_params();
        p.stock = "none".into();
        p.mode = "c".into(); // legacy value is ignored now
        p.exposure = 1.0; // 1 EV → 2.0x print exposure
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.mode, 3, "always Cineon");
        assert_eq!(u.base, [0.8, 0.6, 0.4]);
        assert_eq!(u.m_pre, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(u.m_post, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        assert!((u.print_exposure - 2.0).abs() < 1e-5, "2^1 print exposure");
    }
```

Replace `uniforms_portra_mode_b_fits_nonidentity_mpost_mode_0` (`:384-394`) with:

```rust
    #[test]
    fn uniforms_portra_is_ignored_stays_cineon_identity() {
        let mut p = sample_invert_params();
        p.stock = "portra400".into();
        p.mode = "b".into(); // legacy values ignored
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.mode, 3, "stock/mode ignored → Cineon");
        let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(u.m_post, identity, "no stock matrix applied");
    }
```

- [ ] **Step 2: Run the gpu_upload tests**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml gpu_upload`
Expected: PASS (both rewritten tests green; `uniforms_mode_d_maps_to_3_with_cineon_defaults` still green).

- [ ] **Step 3: Run the whole backend suite to catch other mode-dependent tests**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS. If any other test asserts a non-Cineon mode or a stock matrix, update it to the one-engine reality the same way (assert `mode==3`, identity matrices).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/gpu_upload.rs
git commit -m "test(engine): GPU uniform tests assert single Cineon path"
```

---

### Task 4: Default new images to Cineon

**Files:**
- Modify: `app/src-tauri/src/commands.rs:99` (`default_invert_params`, the `mode` field)
- Test: `app/src-tauri/src/commands.rs` (tests module)

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn default_params_use_cineon_mode() {
        assert_eq!(default_invert_params().mode, "d");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml default_params_use_cineon_mode`
Expected: FAIL — default is currently `"b"`.

- [ ] **Step 3: Change the default**

In `commands.rs:99`, change:

```rust
        mode: "b".into(),
```
to:
```rust
        mode: "d".into(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml default_params_use_cineon_mode`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(engine): default new images to the Cineon engine"
```

---

## Phase B — Remove the engine toggle + stock dropdown (frontend)

### Task 5: Strip the stock + engine selectors from the develop UI

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte:122-145` (remove the two `<select>` blocks)
- Modify: `app/src/lib/api.ts` (`defaultParams`: set `mode: "d"`; leave `stock: "none"`)
- Test: `app/src/lib/viewport/gl/` (existing vitest) + `npm run check`

- [ ] **Step 1: Remove the Film Profile and engine `<select>` blocks**

Delete `Basic.svelte:122-145` (the `<!-- Film Profile -->` heading, the 14-option stock `<select>`, and the `<!-- Inversion engine -->` mode `<select>`). The block that begins `<!-- Film Base (collapsible) -->` at `:147` becomes the first child of `.body`.

- [ ] **Step 2: Set the frontend default mode to Cineon**

In `app/src/lib/api.ts`, find the `defaultParams()` object (the `InvertParams` defaults; `mode` is currently `"b"`) and set `mode: "d"`. Leave `stock: "none"` as-is (vestigial).

- [ ] **Step 3: Verify the frontend compiles and type-checks**

Run: `cd app && npm run check`
Expected: 0 errors. (`$params.stock` / `$params.mode` are still valid fields; we only removed the controls that bind them.)

- [ ] **Step 4: Run the GL unit tests**

Run: `cd app && npx vitest run src/lib/viewport/gl/`
Expected: PASS (these exercise the shader uniform plumbing, unaffected by the removed selectors).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/Basic.svelte app/src/lib/api.ts
git commit -m "feat(ui): remove film-stock and engine selectors (one Cineon path)"
```

---

## Phase C — Delete the dead engine modes and spectral stock model

> Nothing reaches Mode B/C/Naive or the spectral stocks after Phase A. This phase removes them so there is genuinely one engine to maintain. These are deletion tasks: the "test" is that the suites stay green and the build is clippy-clean after each removal.

### Task 6: Remove the spectral stock model and its callers

**Files:**
- Delete: `crates/film-core/src/spectral.rs`
- Modify: `crates/film-core/src/lib.rs` (remove `pub mod spectral;` and any `pub use spectral::...`)
- Modify: `crates/film-core/src/engine.rs` (remove `params_for_stock:183-205` and its tests `stock_params_make_b_differ_from_identity`, `mode_b_*` that import `Stock`)
- Modify: `crates/film-core/src/calibrate.rs` (remove `fit_m_post:152`, `balance_neutral:194`, `generic_m_post:217`, `patch_density:138`, `FIT_LEVELS:135`, and tests `generic_m_post_*`, `fit_m_post_*`, `balance_neutral_*`)
- Modify: `app/src-tauri/src/commands.rs` (remove `stock_from:184-201` and the `use ...Stock` import; remove any remaining references)

- [ ] **Step 1: Delete the spectral module and its declaration**

```bash
git rm crates/film-core/src/spectral.rs
```
Then remove the `pub mod spectral;` line (and any `spectral::` re-exports) from `crates/film-core/src/lib.rs`.

- [ ] **Step 2: Remove spectral callers**

In `engine.rs` delete `params_for_stock` and the `#[test]`s that reference `crate::spectral::Stock` (`stock_params_make_b_differ_from_identity`). In `calibrate.rs` delete `fit_m_post`, `balance_neutral`, `generic_m_post`, `patch_density`, `FIT_LEVELS`, the `SpectralData` import, and the tests that use them. In `commands.rs` delete `stock_from` and its `Stock` import.

- [ ] **Step 3: Build and test film-core**

Run: `cargo test -p film-core`
Expected: PASS (compiler will name any missed reference — remove it). No `unused import`/dead-code warnings.

- [ ] **Step 4: Build and test the backend**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml && cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(engine): delete spectral film-stock model (one Cineon path)"
```

---

### Task 7: Collapse `Mode` to Cineon-only and remove B/C/Naive inverters

**Files:**
- Modify: `crates/film-core/src/engine.rs` (remove `invert_b:95`, `invert_c:79`, `invert_naive:63`, `tone:72`; reduce `enum Mode` to a single `D` or remove it; simplify `invert_image:162`)
- Modify: `crates/film-core/src/engine.rs` `InversionParams` (remove `m_pre`, `m_post`, `exposure`, `black`, `gamma`, `wb`-untouched? keep `wb`; `wb` IS used by `invert_d`)
- Modify: `app/src-tauri/src/commands.rs` (`mode_from` return type / callers), `gpu_upload.rs:153-158` (mode match collapses to `3`)
- Modify: `app/src-tauri/src/gpu_upload.rs` `ResolvedInversion` + `resolve_to_uniforms` (drop `m_pre`/`m_post`/`exposure`/`black`/`gamma` if removed from `InversionParams`)
- Modify: `app/src/lib/viewport/gl/invert.ts` + `shaders.ts` (drop the `u_mode==0/1/2` branches and the now-unused uniforms)

> Note: `invert_d` uses `base`, `wb`, `d_max`, `print_exposure`, `paper_black`, `paper_grade`, `soft_clip`. Keep exactly those on `InversionParams`. `m_pre`/`m_post`/`exposure`/`black`/`gamma` are only used by the removed B/C inverters and may be dropped — but dropping them cascades into `ResolvedInversion`, the shader, and `invert.ts`. If that cascade is too large to do safely in one task, keep the fields (defaulted, unused) and drop only the inverter functions + `Mode` variants; the dead struct fields can be removed in a follow-up. Prefer the smaller, green step.

- [ ] **Step 1: Decide the cut line**

Minimum viable: remove `invert_b`, `invert_c`, `invert_naive`, `tone`, and reduce `enum Mode` to `D` only (or delete `Mode` and make `invert_image` always call `invert_d`). Keep `InversionParams` fields as-is to avoid the cross-boundary cascade. This keeps the GPU shader untouched (its `u_mode==3` branch is the only one ever selected).

- [ ] **Step 2: Remove the inverters and reduce `Mode`**

In `engine.rs`: delete `invert_naive`, `invert_c`, `invert_b`, `tone`. Change `enum Mode` to:

```rust
/// Which inversion to run. One engine: Kodak Cineon (negadoctor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Kodak Cineon densitometry (darktable negadoctor).
    D,
}
```

Simplify `invert_image` to:

```rust
pub fn invert_image(img: &crate::Image, p: &InversionParams, _mode: Mode) -> crate::Image {
    let pixels = img.pixels.par_iter().map(|&px| invert_d(px, p)).collect();
    crate::Image {
        width: img.width,
        height: img.height,
        pixels,
        ir: img.ir.clone(),
    }
}
```

Delete the engine tests that exercise the removed inverters (`naive_*`, `mode_c_*`, `mode_b_*`, `wb_gain_scales_channels_before_gamma`, `naive_and_b_differ_*`). Keep all `mode_d_*` tests and `invert_image_preserves_ir_plane` (update its `Mode::B` to `Mode::D`).

- [ ] **Step 3: Fix backend mode mapping**

In `gpu_upload.rs:153-158`, the match over `Mode` now has one arm — replace with `let mode = 3u8;` (Cineon). Update `invert_image_is_per_pixel_and_order_preserving` in `engine.rs` to iterate only `Mode::D`.

- [ ] **Step 4: Build and test everything**

Run:
```bash
cargo test -p film-core
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
```
Expected: all PASS, clean build. Fix any reference the compiler flags.

- [ ] **Step 5: Frontend sanity (shader still loads)**

Run: `cd app && npx vitest run src/lib/viewport/gl/ && npm run check`
Expected: PASS, 0 errors. (Shader unchanged in the minimal cut; only the `u_mode==3` branch is ever hit.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(engine): collapse to the single Cineon inverter"
```

---

## Phase D — Final verification

### Task 8: Full green sweep + manual smoke

- [ ] **Step 1: Run every suite**

```bash
cargo test -p film-core
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
cd app && npx vitest run src/lib/viewport/gl/ && npm run check
```
Expected: all PASS, 0 type errors, clean build.

- [ ] **Step 2: Manual smoke (real app)**

Launch the app, open a developed negative, and confirm: the develop panel no longer shows the Film Profile or engine dropdowns; the image inverts via Cineon (matches what the old "Cineon (beta)" toggle produced); Temp/Tint, gray-point picker, exposure, and finishing all still work. Open a negative saved under the old Mode-B default and confirm it now renders via Cineon without errors (old `stock`/`mode` fields are ignored, not rejected).

- [ ] **Step 3: Commit any smoke-test fixes, then stop**

This completes Plan 1. Plan 2 (coherent per-roll base + crop-aware analysis, which fixes GitHub issue #1 and adds auto-`D_max`) builds on this.

---

## Self-review notes

- **Spec coverage:** Plan 1 covers spec §1 (one model), §2 (remove stock dropdown, engine toggle, Mode B/C/Naive, spectral) and the "make Cineon the default" half of §5 Plan 1. It deliberately does **not** touch base sampling, the WB reseed storm, crop-aware analysis, or auto-`D_max` — those are Plans 2–3.
- **Vestigial fields:** `stock`, `mode`, `black`, `gamma`, `auto_wb`, `wb_manual` stay in `InvertParams` (`session.rs:49`) for serde back-compat with saved catalogs; the backend stops reading `stock`/`mode`/`black`/`gamma`. Confirmed by `invert_params_backfills_missing_fields_via_serde_default` (`session.rs:318`), which still passes.
- **Type consistency:** `Mode::D` is the only variant after Task 7; every `mode_from`/`invert_image`/`resolve_to_uniforms` site is updated to match. `InversionParams` keeps `base, wb, d_max, print_exposure, paper_black, paper_grade, soft_clip` (all used by `invert_d`); the minimal cut in Task 7 keeps the other fields to avoid a shader cascade.
