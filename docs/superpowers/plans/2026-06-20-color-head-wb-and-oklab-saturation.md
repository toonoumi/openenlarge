# Subtractive Color-Head WB + OKLab Saturation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Temp/Tint reach an optical CMY color-head look (subtractive WB mode) and rebuild Saturation in OKLab so heavy pushes stay believable instead of going neon.

**Architecture:** Two render paths run in lockstep — the Rust core (`film-core`) for full-res CPU export and a GLSL mirror (`shaders.ts`) for the live GPU proxy. Part A adds a `wb_mode` (`Gain` | `Subtractive`); in `Subtractive` mode the WB gains are applied as a per-channel multiply on normalised log-density `t` **before** the filmic S-curve (anchored at black) instead of the current post-curve multiply. Part B replaces the display-space saturation stretch with OKLab chroma scaling plus neutral protection, skin-hue damping, and hue-preserving gamut compression.

**Tech Stack:** Rust (`film-core` crate, `rayon`), Tauri (serde wire structs), TypeScript + WebGL2 (GLSL ES 3.00), Svelte 5, Python i18n codegen.

## Global Constraints

- **CPU/GPU parity is mandatory.** Any constant or formula touched in `crates/film-core/src/engine.rs` or `crates/film-core/src/finish.rs` MUST be mirrored verbatim in `app/src/lib/viewport/gl/shaders.ts`. The CPU path is the export; the GPU path is the preview; they must match.
- **Back-compat: no silent re-render of existing edits.** Rust serde default for `wb_mode` is `"gain"` (existing session JSON lacks the field → loads as today). The *frontend* default for a freshly-opened image is `"subtractive"`.
- **Saturation/vibrance at 0 must be exact identity** (existing edits unchanged).
- **i18n:** never edit `app/src/lib/i18n/dict.ts` by hand. Add rows to `/i18n-strings.csv` and run `python3 scripts/gen-i18n.py`.
- **Commit on `main`** (per project convention), one commit per task. End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run Rust tests from repo root with `cargo test -p film-core`. Run the Tauri crate tests with `cargo test --manifest-path app/src-tauri/Cargo.toml`. Frontend type-check/build with `cd app && npm run build`.

---

## File Structure

- `crates/film-core/src/engine.rs` — **Task 1.** `WbMode` enum, `wb_mode` field on `InversionParams`, `CMY_STRENGTH`, subtractive branch in `invert_d`.
- `crates/film-core/src/finish.rs` — **Task 4.** OKLab `apply_saturation` + colour-space helpers + tests.
- `app/src-tauri/src/session.rs` — **Task 2.** `wb_mode: String` on the wire `InvertParams`.
- `app/src-tauri/src/commands.rs` — **Task 2.** `wb_mode_from` parser; set `ip.wb_mode` in `build_params`.
- `app/src-tauri/src/gpu_upload.rs` — **Task 2.** `wb_mode: u8` on `ResolvedInversion`; set in `resolve_to_uniforms`.
- `app/src/lib/viewport/gl/shaders.ts` — **Task 3** (`INVERT_FRAG`) + **Task 5** (`FRAG`/`finishAt`).
- `app/src/lib/viewport/gl/invert.ts` — **Task 3.** `wb_mode` on the TS uniform mirror.
- `app/src/lib/viewport/gl/renderer.ts` — **Task 3.** `u_wb_mode` location + set.
- `app/src/lib/api.ts` — **Task 6.** `wb_mode` on the TS `InvertParams` type + `defaultParams`.
- `app/src/lib/develop/Basic.svelte` — **Task 6.** "Color head" toggle.
- `/i18n-strings.csv` — **Task 6.** Two new strings.

---

## Task 1: Subtractive WB in the film-core engine

**Files:**
- Modify: `crates/film-core/src/engine.rs` (`InversionParams` struct + `Default`, new consts, `invert_d`)
- Test: `crates/film-core/src/engine.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub enum WbMode { Gain, Subtractive }` (derives `Debug, Clone, Copy, PartialEq, Eq`, `Default` = `Gain`); `pub wb_mode: WbMode` field on `InversionParams`; `const CMY_STRENGTH: f32`. `invert_d` behavior: `Gain` = unchanged `filmic_s(t)·wb[c]`; `Subtractive` = `filmic_s(t · wb[c]^CMY_STRENGTH)` with no post-curve multiply.

- [ ] **Step 1: Write failing tests**

Add to the `tests` module in `crates/film-core/src/engine.rs`:

```rust
    fn sub_params(wb: [f32; 3]) -> InversionParams {
        InversionParams { base: [0.9, 0.9, 0.9], d_max: 1.5, wb, wb_mode: WbMode::Subtractive, ..Default::default() }
    }

    #[test]
    fn subtractive_black_stays_neutral() {
        // A pixel equal to the film base has density 0 → t=0 → filmic_s(0)=0 for every
        // channel regardless of the WB filter. No "yellow shadow".
        let p = sub_params([1.3, 1.0, 0.7]);
        let out = invert_d(p.base, &p);
        assert_eq!(out, [0.0, 0.0, 0.0], "subtractive black must be pure neutral, got {out:?}");
    }

    #[test]
    fn subtractive_neutral_wb_equals_gain() {
        // With wb = [1,1,1] the subtractive and gain paths both reduce to filmic_s(t).
        let scan = [0.25_f32, 0.30, 0.18];
        let gain = InversionParams { base: [0.9, 0.9, 0.9], d_max: 1.5, wb: [1.0, 1.0, 1.0], wb_mode: WbMode::Gain, ..Default::default() };
        let sub = InversionParams { wb_mode: WbMode::Subtractive, ..gain.clone() };
        let a = invert_d(scan, &gain);
        let b = invert_d(scan, &sub);
        for c in 0..3 {
            assert!((a[c] - b[c]).abs() < 1e-6, "c{c}: gain {a:?} != sub {b:?}");
        }
    }

    #[test]
    fn subtractive_warm_filter_brightens_red_midtone() {
        // A red-boosted WB filter (red gain > 1) raises the red channel of a mid-density
        // pixel vs. the neutral subtractive render — the subtractive shift IS happening.
        let scan = [0.30_f32, 0.30, 0.30];
        let neutral = sub_params([1.0, 1.0, 1.0]);
        let warm = sub_params([1.3, 1.0, 0.8]);
        let n = invert_d(scan, &neutral);
        let w = invert_d(scan, &warm);
        assert!(w[0] > n[0] + 1e-4, "red filter should brighten red mid: {n:?} -> {w:?}");
        assert!(w[2] < n[2] - 1e-4, "blue cut should darken blue mid: {n:?} -> {w:?}");
    }
```

- [ ] **Step 2: Run tests, verify they fail to compile**

Run: `cargo test -p film-core subtractive`
Expected: FAIL — `WbMode` and `wb_mode` do not exist yet (compile error).

- [ ] **Step 3: Add the enum, field, default, and constant**

In `crates/film-core/src/engine.rs`, add after the `use` lines (near top):

```rust
/// How white balance is applied. `Gain` multiplies the positive output after the
/// filmic curve (von-Kries display gain). `Subtractive` applies the same gains as a
/// per-channel multiply on normalised log-density BEFORE the filmic curve, like a
/// dichroic enlarger head changing each emulsion layer's exposure — coupled to the
/// tone-curve slope, anchored at black, no highlight clipping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WbMode {
    #[default]
    Gain,
    Subtractive,
}
```

Add `wb_mode` to the `InversionParams` struct (after the `wb` field):

```rust
    /// Per-channel white-balance gain applied in linear light before gamma.
    pub wb: [f32; 3],
    /// How `wb` is applied: post-curve gain (default) or subtractive (pre-curve, color-head).
    pub wb_mode: WbMode,
```

Add `wb_mode: WbMode::Gain,` to the `Default for InversionParams` impl (after `wb: [1.0, 1.0, 1.0],`).

Add the strength constant next to `EXPO_K` / the filmic consts:

```rust
/// Subtractive WB strength: gain `g` → density scale `g^CMY_STRENGTH` on `t`. Tuned so
/// the mid-tone shift at a typical Temp/Tint roughly matches the old gain magnitude
/// while giving a proper shadow→highlight crossover. Mirrored in shaders.ts.
const CMY_STRENGTH: f32 = 1.6;
```

- [ ] **Step 4: Branch the WB application in `invert_d`**

In `invert_d`, replace the per-channel closure body. The current line computing `v`:

```rust
        let v = filmic_s(t) * p.wb[c];
```

becomes (keep everything above it — `clamped`, `dmin`, `d`, `t` — and everything below it — the `if p.hdr { … } else { … }` block — unchanged):

```rust
        // WB application depends on the mode (mirror shaders.ts INVERT_FRAG):
        //  - Gain:        post-curve display multiply  →  filmic_s(t) · wb[c]
        //  - Subtractive: pre-curve density multiply    →  filmic_s(t · wb[c]^CMY_STRENGTH)
        //    Anchored at black (t=0 → 0 for any filter), coupled to the filmic slope.
        let v = match p.wb_mode {
            WbMode::Gain => filmic_s(t) * p.wb[c],
            WbMode::Subtractive => filmic_s(t * p.wb[c].max(EPS).powf(CMY_STRENGTH)),
        };
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `cargo test -p film-core`
Expected: PASS (all engine tests, including the three new ones).

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): subtractive color-head WB mode (pre-curve density multiply)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Plumb `wb_mode` through the Rust wire

**Files:**
- Modify: `app/src-tauri/src/session.rs` (`InvertParams` struct)
- Modify: `app/src-tauri/src/commands.rs` (`wb_mode_from` + `build_params`)
- Modify: `app/src-tauri/src/gpu_upload.rs` (`ResolvedInversion` + `resolve_to_uniforms`)
- Test: `app/src-tauri/src/commands.rs` tests + `app/src-tauri/src/gpu_upload.rs` tests

**Interfaces:**
- Consumes: `WbMode`, `InversionParams.wb_mode` (Task 1).
- Produces: `InvertParams.wb_mode: String` (serde default `"gain"`); `fn wb_mode_from(&str) -> film_core::WbMode`; `ResolvedInversion.wb_mode: u8` (0 = gain, 1 = subtractive).

- [ ] **Step 1: Write failing tests**

In `app/src-tauri/src/commands.rs` tests module, add:

```rust
    #[test]
    fn build_params_defaults_wb_mode_gain() {
        let p = sample_invert_params();
        let ip = build_params(&p, [0.8, 0.6, 0.4]);
        assert_eq!(ip.wb_mode, film_core::WbMode::Gain);
    }

    #[test]
    fn build_params_reads_subtractive_wb_mode() {
        let mut p = sample_invert_params();
        p.wb_mode = "subtractive".to_string();
        let ip = build_params(&p, [0.8, 0.6, 0.4]);
        assert_eq!(ip.wb_mode, film_core::WbMode::Subtractive);
    }
```

In `app/src-tauri/src/gpu_upload.rs` tests module, add:

```rust
    #[test]
    fn resolve_to_uniforms_maps_wb_mode() {
        let mut p = sample_invert_params();
        p.wb_mode = "subtractive".to_string();
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.wb_mode, 1u8);
        p.wb_mode = "gain".to_string();
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.wb_mode, 0u8);
    }
```

`sample_invert_params()` (in `app/src-tauri/src/lib.rs`'s `commands_test_support`) just delegates to `crate::commands::default_invert_params()`. After adding the new field (Step 3), add `wb_mode: "gain".to_string(),` to the `InvertParams { … }` literal inside `default_invert_params` in `commands.rs` (`grep -n "fn default_invert_params" app/src-tauri/src/commands.rs`).

- [ ] **Step 2: Run tests, verify they fail to compile**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml wb_mode`
Expected: FAIL — `InvertParams` has no `wb_mode`, `ResolvedInversion` has no `wb_mode`.

- [ ] **Step 3: Add the field, parser, and mappings**

In `app/src-tauri/src/session.rs`, add to `InvertParams` (after the `tint` field block, near `wb_manual`):

```rust
    /// White-balance application mode: "gain" (post-curve display gain, legacy) or
    /// "subtractive" (pre-curve density multiply, optical color-head look). Serde
    /// default "gain" so pre-existing saved edits load exactly as before.
    #[serde(default = "wb_mode_gain")]
    pub wb_mode: String,
```

Add the default helper near the other `#[serde(default = "…")]` free fns in `session.rs` (e.g. next to `identity_curve`):

```rust
fn wb_mode_gain() -> String { "gain".to_string() }
```

In `app/src-tauri/src/commands.rs`, add the parser near `build_params`:

```rust
/// Parse the wire `wb_mode` string into the engine enum. Unknown values fall back
/// to `Gain` (the safe legacy behavior).
pub(crate) fn wb_mode_from(s: &str) -> film_core::WbMode {
    match s {
        "subtractive" => film_core::WbMode::Subtractive,
        _ => film_core::WbMode::Gain,
    }
}
```

Set it in `build_params` — change the `InversionParams { … }` literal to add the field:

```rust
    InversionParams {
        base,
        print_exposure: 2f32.powf(p.exposure), // EV stops → linear print exposure
        d_max: p.d_max_override.unwrap_or(1.5),
        positive: p.positive,
        wb_mode: wb_mode_from(&p.wb_mode),
        ..Default::default()
    }
```

`film-core`'s `lib.rs` currently only re-exports `Image` (`pub use image::Image;`). Add a sibling re-export so `film_core::WbMode` resolves in the Tauri crate:

```rust
pub use engine::WbMode;
```

(Alternatively reference `film_core::engine::WbMode` everywhere; the re-export is cleaner and matches the `Image` precedent. Task 1's tests live inside `engine.rs` so they use the bare `WbMode`.)

In `app/src-tauri/src/gpu_upload.rs`, add to `ResolvedInversion` (after `positive`):

```rust
    /// WB mode for the shader: 0 = gain (post-curve), 1 = subtractive (pre-curve).
    pub wb_mode: u8,
```

Set it at the end of the `ResolvedInversion { … }` literal in `resolve_to_uniforms`:

```rust
        mode,
        positive: p.positive,
        wb_mode: match crate::commands::wb_mode_from(&p.wb_mode) {
            film_core::WbMode::Subtractive => 1,
            film_core::WbMode::Gain => 0,
        },
```

Add `wb_mode: "gain".to_string(),` to the `sample_invert_params()` literal (per Step 1 note).

- [ ] **Step 4: Run tests, verify they pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (new `wb_mode` tests + existing suite).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs
git commit -m "feat(tauri): plumb wb_mode through InvertParams/build_params/ResolvedInversion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: GPU INVERT_FRAG subtractive mirror + TS uniform wiring

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (`INVERT_FRAG`)
- Modify: `app/src/lib/viewport/gl/invert.ts` (`ResolvedInversion`, `InversionUniforms`, `toInversionUniforms`)
- Modify: `app/src/lib/viewport/gl/renderer.ts` (uniform location list + `drawInvertPass`)

**Interfaces:**
- Consumes: `ResolvedInversion.wb_mode: u8` JSON from Task 2.
- Produces: GPU Mode D render that matches `engine.rs::invert_d` for both WB modes.

- [ ] **Step 1: Add `wb_mode` to the TS uniform mirror**

In `app/src/lib/viewport/gl/invert.ts`:
- Add `wb_mode: number;` to `interface ResolvedInversion` (after `positive: boolean;`).
- Add `wb_mode: number;` to `interface InversionUniforms` (after `positive: boolean;`).
- Add `wb_mode: r.wb_mode,` to the object returned by `toInversionUniforms` (after `positive: r.positive,`).

- [ ] **Step 2: Add the uniform + subtractive branch in `INVERT_FRAG`**

In `app/src/lib/viewport/gl/shaders.ts`, in `INVERT_FRAG`, add the uniform + constant near the other inversion uniforms (after `uniform bool u_positive;`):

```glsl
uniform int u_wb_mode;        // 0 = gain (post-curve), 1 = subtractive (pre-curve)
```

Add the strength constant next to `EXPO_K`:

```glsl
// Subtractive WB strength — MUST equal engine.rs CMY_STRENGTH.
const float CMY_STRENGTH = 1.6;
```

**NOTE (base file changed since the plan was written):** `INVERT_FRAG` Mode D was rewritten to apply exposure via a `filmicInv` round-trip after WB, mirroring the current `engine.rs::invert_d` (Task 1 shipped `Subtractive = filmic_s(t * wb^CMY_STRENGTH * expo_gain)`). The current Mode D return reads:

```glsl
    vec3 y = vec3(filmicSraw(t.r), filmicSraw(t.g), filmicSraw(t.b)) * u_wb;
    return clamp(vec3(
      filmicS(filmicInv(y.r) * expo_gain),
      filmicS(filmicInv(y.g) * expo_gain),
      filmicS(filmicInv(y.b) * expo_gain)), 0.0, 1.0);
```

Replace exactly those four lines with a `u_wb_mode` branch (Gain arm = the existing code verbatim; Subtractive arm mirrors the shipped Rust `filmic_s(t * wb^CMY_STRENGTH * expo_gain)`):

```glsl
    // WB mode (mirror engine.rs invert_d):
    //  0 gain: WB as post-curve display gain, exposure via the filmicInv round-trip.
    //  1 subtractive (color head): per-channel density multiply BEFORE the curve,
    //    folding exposure into the same t-multiply; anchored at black (t=0 → 0).
    vec3 v;
    if (u_wb_mode == 1) {
      vec3 s = pow(max(u_wb, vec3(EPS)), vec3(CMY_STRENGTH));
      v = vec3(
        filmicS(t.r * s.r * expo_gain),
        filmicS(t.g * s.g * expo_gain),
        filmicS(t.b * s.b * expo_gain));
    } else {
      vec3 y = vec3(filmicSraw(t.r), filmicSraw(t.g), filmicSraw(t.b)) * u_wb;
      v = vec3(
        filmicS(filmicInv(y.r) * expo_gain),
        filmicS(filmicInv(y.g) * expo_gain),
        filmicS(filmicInv(y.b) * expo_gain));
    }
    return clamp(v, 0.0, 1.0);
```

- [ ] **Step 3: Wire the uniform in `renderer.ts`**

In `app/src/lib/viewport/gl/renderer.ts`:
- Add `"u_wb_mode"` to the uniform-name array passed to `getUniformLocation` (the list starting `"u_src","u_base","u_wb",…` around line 165-169).
- In `drawInvertPass`, after the `u_positive` line (`gl.uniform1i(L.u_positive, u.positive ? 1 : 0);`), add:

```ts
    gl.uniform1i(L.u_wb_mode, u.wb_mode);
```

- [ ] **Step 4: Build to verify it compiles + shader links**

Run: `cd app && npm run build`
Expected: build succeeds (TypeScript type-checks; the WebGL shader is validated at runtime — a smoke check happens in Task 7).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts app/src/lib/viewport/gl/invert.ts app/src/lib/viewport/gl/renderer.ts
git commit -m "feat(gpu): mirror subtractive WB in INVERT_FRAG + wire u_wb_mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: OKLab perceptual saturation in finish.rs

**Files:**
- Modify: `crates/film-core/src/finish.rs` (`apply_saturation` + new helpers + consts)
- Test: `crates/film-core/src/finish.rs` tests module

**Interfaces:**
- Produces: rebuilt `apply_saturation(rgb, p)` — OKLab chroma scaling with neutral protection, skin damping, hue-preserving gamut compression; identity at `saturation == vibrance == 0`. Same signature as today, so `finish_pixel` is unchanged.

- [ ] **Step 1: Write failing tests**

Add to the `tests` module in `crates/film-core/src/finish.rs`:

```rust
    fn chroma_of(rgb: [f32; 3]) -> f32 {
        let lin = [srgb_to_linear(rgb[0]), srgb_to_linear(rgb[1]), srgb_to_linear(rgb[2])];
        let lab = linear_to_oklab(lin[0], lin[1], lin[2]);
        (lab[1] * lab[1] + lab[2] * lab[2]).sqrt()
    }
    /// Build a display-space pixel from an OKLab (L, C, hue) triple.
    fn px_from_lch(l: f32, c: f32, h: f32) -> [f32; 3] {
        let lab = [l, c * h.cos(), c * h.sin()];
        let lin = oklab_to_linear(lab);
        std::array::from_fn(|i| linear_to_srgb(lin[i].clamp(0.0, 1.0)))
    }

    #[test]
    fn oklab_saturation_identity_at_zero() {
        let px = [0.42_f32, 0.55, 0.30];
        let p = FinishParams { saturation: 0.0, vibrance: 0.0, ..Default::default() };
        assert_eq!(apply_saturation(px, &p), px);
    }

    #[test]
    fn oklab_saturation_raises_chroma() {
        let px = [0.55_f32, 0.40, 0.30];
        let p = FinishParams { saturation: 0.5, ..Default::default() };
        let out = apply_saturation(px, &p);
        assert!(chroma_of(out) > chroma_of(px) + 1e-3, "{} !> {}", chroma_of(out), chroma_of(px));
    }

    #[test]
    fn oklab_saturation_stays_in_gamut_under_heavy_push() {
        let px = [0.60_f32, 0.35, 0.25];
        let p = FinishParams { saturation: 3.0, ..Default::default() };
        let out = apply_saturation(px, &p);
        for c in 0..3 {
            assert!((0.0..=1.0).contains(&out[c]), "channel {c} out of gamut: {out:?}");
        }
    }

    #[test]
    fn oklab_saturation_preserves_neutral() {
        let px = [0.5_f32, 0.5, 0.5];
        let p = FinishParams { saturation: 1.0, ..Default::default() };
        let out = apply_saturation(px, &p);
        for c in 0..3 {
            assert!((out[c] - 0.5).abs() < 0.02, "neutral drifted: {out:?}");
        }
    }

    #[test]
    fn oklab_saturation_damps_skin() {
        // Two pixels with equal lightness + chroma, one at the skin hue, one opposite.
        // The skin pixel must gain LESS chroma than the non-skin pixel.
        let l = 0.7_f32;
        let c0 = 0.06_f32;
        let skin = px_from_lch(l, c0, SKIN_HUE);
        let other = px_from_lch(l, c0, SKIN_HUE + std::f32::consts::PI);
        let p = FinishParams { saturation: 1.0, ..Default::default() };
        let skin_ratio = chroma_of(apply_saturation(skin, &p)) / chroma_of(skin);
        let other_ratio = chroma_of(apply_saturation(other, &p)) / chroma_of(other);
        assert!(skin_ratio < other_ratio - 1e-3, "skin {skin_ratio} not damped vs {other_ratio}");
    }
```

- [ ] **Step 2: Run tests, verify they fail to compile**

Run: `cargo test -p film-core oklab_saturation`
Expected: FAIL — `srgb_to_linear`, `linear_to_oklab`, `oklab_to_linear`, `SKIN_HUE` don't exist yet.

- [ ] **Step 3: Add colour-space helpers + constants**

In `crates/film-core/src/finish.rs`, add above `apply_saturation` (these are also used by the tests, so keep them accessible to the module — plain `fn`/`const` items in the same file are visible to `#[cfg(test)] mod tests` via `use super::*`):

```rust
// --- OKLab perceptual saturation (replaces the display-space cube stretch). ---
// Chroma is scaled in OKLab so pushes enrich colour without per-channel clipping
// (which twists hue → neon). Luma (L) is held fixed; near-neutrals and skin hues are
// protected; out-of-gamut chroma is compressed along the (gray→colour) line back to
// the boundary. MUST be mirrored in shaders.ts (FRAG/finishAt).
const SAT_C_REF: f32 = 0.20;      // OKLab chroma treated as "fully saturated" (vibrance weight)
const SAT_C_NEUTRAL: f32 = 0.025; // boost ramps from 0 below this chroma (protect neutrals)
const SKIN_HUE: f32 = 0.70;       // OKLab hue (rad) at skin/orange
const SKIN_WIDTH: f32 = 0.55;     // half-window (rad) of the skin damp
const SKIN_DAMP: f32 = 0.5;       // max boost reduction inside the skin window

#[inline]
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}
#[inline]
fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}
#[inline]
fn linear_to_oklab(r: f32, g: f32, b: f32) -> [f32; 3] {
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ]
}
#[inline]
fn oklab_to_linear(lab: [f32; 3]) -> [f32; 3] {
    let l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    let m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    let s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];
    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ]
}
/// Angular distance on the hue circle, in radians [0, π].
#[inline]
fn hue_dist(a: f32, b: f32) -> f32 {
    let tau = 2.0 * std::f32::consts::PI;
    let mut d = (a - b).rem_euclid(tau);
    if d > std::f32::consts::PI { d = tau - d; }
    d
}
```

Note: `smoothstep` already exists in this file (used by `tone_curve`); reuse it.

- [ ] **Step 4: Replace `apply_saturation`**

Replace the whole body of `apply_saturation` (currently the luma-cube stretch) with:

```rust
/// Perceptual saturation in OKLab: scale chroma (luma fixed), protect neutrals + skin,
/// and compress any out-of-gamut result along the hue line instead of clipping per
/// channel. `saturation` is uniform; `vibrance` is weighted toward muted pixels.
/// Identity when both are 0. Mirrored in shaders.ts::finishAt.
fn apply_saturation(rgb: [f32; 3], p: &FinishParams) -> [f32; 3] {
    if p.saturation.abs() < EPS && p.vibrance.abs() < EPS {
        return rgb;
    }
    let lin = [srgb_to_linear(rgb[0]), srgb_to_linear(rgb[1]), srgb_to_linear(rgb[2])];
    let lab = linear_to_oklab(lin[0], lin[1], lin[2]);
    let (l, a, b) = (lab[0], lab[1], lab[2]);
    let c = (a * a + b * b).sqrt();
    if c < EPS {
        return rgb; // pure neutral: nothing to saturate
    }
    let h = b.atan2(a);
    // Boost: saturation uniform; vibrance weighted toward muted (low-chroma) pixels.
    let vib_w = 1.0 - (c / SAT_C_REF).clamp(0.0, 1.0);
    let mut gain = p.saturation + p.vibrance * vib_w;
    // Protect near-neutrals and skin hues from the boost.
    let neutral = smoothstep(0.0, SAT_C_NEUTRAL, c);
    let skin = 1.0 - SKIN_DAMP * smoothstep(SKIN_WIDTH, 0.0, hue_dist(h, SKIN_HUE));
    gain *= neutral * skin;
    let scale = (1.0 + gain).max(0.0);
    let lab2 = [l, a * scale, b * scale];
    // Hue-preserving gamut compression: find the largest fraction `tg` of the
    // (gray → boosted colour) segment that stays in [0,1] on every channel. The
    // achromatic point (L,0,0) is in gamut, so tg ≥ 0 always exists.
    let gray = oklab_to_linear([l, 0.0, 0.0]);
    let col = oklab_to_linear(lab2);
    let mut tg = 1.0_f32;
    for ch in 0..3 {
        let (g0, c0) = (gray[ch], col[ch]);
        if c0 > 1.0 {
            tg = tg.min((1.0 - g0) / (c0 - g0));
        } else if c0 < 0.0 {
            tg = tg.min(g0 / (g0 - c0));
        }
    }
    let tg = tg.clamp(0.0, 1.0);
    let out_lin: [f32; 3] = std::array::from_fn(|ch| (gray[ch] + (col[ch] - gray[ch]) * tg).clamp(0.0, 1.0));
    [linear_to_srgb(out_lin[0]), linear_to_srgb(out_lin[1]), linear_to_srgb(out_lin[2])]
}
```

- [ ] **Step 5: Reconcile the pre-existing saturation tests**

The old tests `positive_saturation_increases_chroma` and the vibrance test assert the *old* cube-stretch numbers. Run `cargo test -p film-core` and inspect failures. For each old saturation/vibrance test that encodes the old formula, update its assertion to the perceptual contract (chroma increases / vibrance favors muted pixels) using the `chroma_of` helper from Step 1 — do NOT delete coverage. Example replacement for `positive_saturation_increases_chroma`:

```rust
    #[test]
    fn positive_saturation_increases_chroma() {
        let px = [0.55_f32, 0.40, 0.30];
        let p = FinishParams { saturation: 0.5, ..Default::default() };
        assert!(chroma_of(apply_saturation(px, &p)) > chroma_of(px));
    }
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `cargo test -p film-core`
Expected: PASS (new OKLab tests + reconciled old tests + the rest of the suite).

- [ ] **Step 7: Commit**

```bash
git add crates/film-core/src/finish.rs
git commit -m "feat(finish): OKLab perceptual saturation with neutral/skin protection + gamut roll-off

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: GPU finishAt OKLab mirror

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (`FRAG`: helper fns + `finishAt`)

**Interfaces:**
- Consumes: existing `u_saturation`, `u_vibrance` uniforms (already wired).
- Produces: GPU saturation that matches `finish.rs::apply_saturation`.

- [ ] **Step 1: Add GLSL colour-space helpers + constants**

In `app/src/lib/viewport/gl/shaders.ts`, in `FRAG`, add above `vec3 finishAt(` (after the `BRIGHTNESS_DENSITY_RANGE` const):

```glsl
// OKLab perceptual saturation — MUST equal finish.rs apply_saturation + consts.
const float SAT_C_REF = 0.20;
const float SAT_C_NEUTRAL = 0.025;
const float SKIN_HUE = 0.70;
const float SKIN_WIDTH = 0.55;
const float SKIN_DAMP = 0.5;
const float PI = 3.14159265358979;

float srgbToLinear(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float linearToSrgb(float c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
vec3 srgbToLinear3(vec3 c) { return vec3(srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)); }
vec3 linearToSrgb3(vec3 c) { return vec3(linearToSrgb(c.r), linearToSrgb(c.g), linearToSrgb(c.b)); }
vec3 linearToOklab(vec3 rgb) {
  float l = 0.4122214708*rgb.r + 0.5363325363*rgb.g + 0.0514459929*rgb.b;
  float m = 0.2119034982*rgb.r + 0.6806995451*rgb.g + 0.1073969566*rgb.b;
  float s = 0.0883024619*rgb.r + 0.2817188376*rgb.g + 0.6299787005*rgb.b;
  vec3 lms_ = pow(max(vec3(l, m, s), vec3(0.0)), vec3(1.0/3.0));
  return vec3(
    0.2104542553*lms_.x + 0.7936177850*lms_.y - 0.0040720468*lms_.z,
    1.9779984951*lms_.x - 2.4285922050*lms_.y + 0.4505937099*lms_.z,
    0.0259040371*lms_.x + 0.7827717662*lms_.y - 0.8086757660*lms_.z);
}
vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774*lab.y + 0.2158037573*lab.z;
  float m_ = lab.x - 0.1055613458*lab.y - 0.0638541728*lab.z;
  float s_ = lab.x - 0.0894841775*lab.y - 1.2914855480*lab.z;
  vec3 lms = vec3(l_*l_*l_, m_*m_*m_, s_*s_*s_);
  return vec3(
     4.0767416621*lms.x - 3.3077115913*lms.y + 0.2309699292*lms.z,
    -1.2684380046*lms.x + 2.6097574011*lms.y - 0.3413193965*lms.z,
    -0.0041960863*lms.x - 0.7034186147*lms.y + 1.7076147010*lms.z);
}
float hueDist(float a, float b) {
  float d = mod(abs(a - b), 2.0 * PI);
  return d > PI ? 2.0 * PI - d : d;
}
vec3 oklabSaturate(vec3 rgb) {
  if (abs(u_saturation) < 1e-5 && abs(u_vibrance) < 1e-5) return rgb;
  vec3 lab = linearToOklab(srgbToLinear3(rgb));
  float c = length(lab.yz);
  if (c < 1e-5) return rgb;
  float hh = atan(lab.z, lab.y);
  float vibW = 1.0 - clamp(c / SAT_C_REF, 0.0, 1.0);
  float gain = u_saturation + u_vibrance * vibW;
  float neutral = smoothstep(0.0, SAT_C_NEUTRAL, c);
  float skin = 1.0 - SKIN_DAMP * smoothstep(SKIN_WIDTH, 0.0, hueDist(hh, SKIN_HUE));
  gain *= neutral * skin;
  float scale = max(1.0 + gain, 0.0);
  vec3 lab2 = vec3(lab.x, lab.y * scale, lab.z * scale);
  vec3 gray = oklabToLinear(vec3(lab.x, 0.0, 0.0));
  vec3 col = oklabToLinear(lab2);
  float tg = 1.0;
  for (int ch = 0; ch < 3; ch++) {
    float g0 = gray[ch]; float c0 = col[ch];
    if (c0 > 1.0) tg = min(tg, (1.0 - g0) / (c0 - g0));
    else if (c0 < 0.0) tg = min(tg, g0 / (g0 - c0));
  }
  tg = clamp(tg, 0.0, 1.0);
  vec3 outLin = clamp(mix(gray, col, tg), 0.0, 1.0);
  return linearToSrgb3(outLin);
}
```

Note: GLSL's built-in `smoothstep(edge0, edge1, x)` matches the Rust `smoothstep` used here, including the reversed-edge form `smoothstep(SKIN_WIDTH, 0.0, d)`.

- [ ] **Step 2: Call it in `finishAt`**

In `finishAt`, replace the four lines computing the old saturation:

```glsl
  float y = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
  float mx = max(max(t.r, t.g), t.b);
  float mn = min(min(t.r, t.g), t.b);
  float cur = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  float f = 1.0 + u_saturation + u_vibrance * (1.0 - cur);
  vec3 s = clamp(vec3(y) + (t - vec3(y)) * f, 0.0, 1.0);
```

with:

```glsl
  vec3 s = oklabSaturate(t);
```

- [ ] **Step 3: Build to verify compile + shader link**

Run: `cd app && npm run build`
Expected: build succeeds. (Runtime shader-link smoke check in Task 7.)

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts
git commit -m "feat(gpu): mirror OKLab perceptual saturation in finishAt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Color-head toggle UI + frontend default + i18n

**Files:**
- Modify: `app/src/lib/api.ts` (`InvertParams` type + `defaultParams`)
- Modify: `app/src/lib/develop/Basic.svelte` (toggle button by the WB header)
- Modify: `/i18n-strings.csv` (two strings) + run `scripts/gen-i18n.py`

**Interfaces:**
- Consumes: backend `wb_mode` wire field (Task 2).
- Produces: `InvertParams.wb_mode: "gain" | "subtractive"`; default `"subtractive"` for new images; a toggle that flips it and commits.

- [ ] **Step 1: Add `wb_mode` to the TS type + default**

In `app/src/lib/api.ts`, add to `interface InvertParams` (after `wb_manual: boolean;`):

```ts
  wb_mode: "gain" | "subtractive"; // WB application: post-curve gain vs subtractive color-head
```

In `defaultParams()`, add `wb_mode` to the returned object on the WB line. Change:

```ts
  auto_wb: true, temp: 5500, tint: 0, wb_manual: false, hdr: false,
```

to:

```ts
  auto_wb: true, temp: 5500, tint: 0, wb_manual: false, wb_mode: "subtractive", hdr: false,
```

(New images get the color-head look; `catalog.ts` spreads `{ ...defaultParams(), ...e.params }`, so loaded edits keep their stored value, and edits saved before this field existed fall back to the default — acceptable, since those are pre-release WIP per the project's uncommitted-WIP workflow.)

- [ ] **Step 2: Add the i18n strings**

Append two rows to `/i18n-strings.csv` (CSV columns: `key,en,zh,file,note`):

```csv
basic.colorHead,"Color head","彩色头","src/lib/develop/Basic.svelte","toggle"
basic.colorHeadTitle,"Subtractive CMY color-head white balance (toggle)","减色 CMY 彩色头白平衡（切换）","src/lib/develop/Basic.svelte","tooltip"
```

Run: `python3 scripts/gen-i18n.py`
Expected: regenerates `app/src/lib/i18n/dict.ts` with the two new keys; exits 0.

- [ ] **Step 3: Add the toggle button in Basic.svelte**

In `app/src/lib/develop/Basic.svelte`, in the WB header (`<span class="wbbtns">` block, after the Auto WB button around line 333-335), add a toggle mirroring the existing `hdrtoggle` pattern:

```svelte
          <button class="auto" class:on={$params.wb_mode === 'subtractive'}
                  title={$t('basic.colorHeadTitle')} aria-pressed={$params.wb_mode === 'subtractive'}
                  on:click={() => { params.update((p) => ({ ...p, wb_mode: p.wb_mode === 'subtractive' ? 'gain' : 'subtractive' })); commitActive(); }}>
            {$t('basic.colorHead')}
          </button>
```

Verify `commitActive` and `params` are already in scope in this component (they are — used by the existing HDR toggle at line 288 and `commitActive` by other controls). If `commitActive` is not imported in this file, use the same commit call the HDR toggle uses.

- [ ] **Step 4: Build + type-check**

Run: `cd app && npm run build`
Expected: build succeeds; no missing-i18n-key or type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/develop/Basic.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): Color head WB toggle + subtractive default for new images

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verify in the app + tune + before/after

**Files:** none (verification + optional constant tune)

- [ ] **Step 1: Full test sweep**

Run:
```bash
cargo test -p film-core
cargo test --manifest-path app/src-tauri/Cargo.toml
cd app && npm run build
```
Expected: all green.

- [ ] **Step 2: Launch the app and smoke-test the shaders**

Use the `run` skill (or `cd app && npm run tauri dev`). Open the tester's negative in Develop. Confirm: no WebGL shader-link errors in the console; the image renders (this exercises both new shader branches — INVERT_FRAG `u_wb_mode` and `oklabSaturate`).

- [ ] **Step 3: A/B the color head against the optical print**

With the tester's frame open, toggle **Color head** off/on and sweep Temp/Tint. Compare to the optical CMY enlarger frame. The subtractive mode should reach a shift that tracks the head (neutral crossover across shadows→mids→highlights, no crushed/tinted black). If the magnitude is too weak or too strong relative to the head, adjust `CMY_STRENGTH` in BOTH `crates/film-core/src/engine.rs` and `app/src/lib/viewport/gl/shaders.ts` (keep them identical), rebuild, recheck. Re-run `cargo test -p film-core` after any change (the structural tests must still pass).

- [ ] **Step 4: Push saturation and confirm it stays believable**

Bump the Saturation slider hard. Confirm: colors enrich without going neon, skies/grays stay clean (neutral protection), and faces stay believable (skin damp). If skin still shifts, adjust `SKIN_HUE`/`SKIN_WIDTH`/`SKIN_DAMP` in BOTH files identically and rebuild.

- [ ] **Step 5: Capture before/after**

Export or screenshot the tester's three comparison frames (optical / camera / OE) with the new pipeline — both Color-head-off and Color-head-on, plus a saturation-pushed example — for the before/after writeup requested in the task.

- [ ] **Step 6: Final commit (only if Step 3/4 changed a constant)**

```bash
git add crates/film-core/src/engine.rs app/src/lib/viewport/gl/shaders.ts
git commit -m "tune(color): CMY_STRENGTH / skin-damp constants from tester-frame A/B

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Subtractive CMY/dichroic WB → Tasks 1 (core), 2 (wire), 3 (GPU). ✓
- Tone-axis behaves subtractively (pre-curve density multiply, anchored black) → Task 1. ✓
- Perceptual/film-like saturation in OKLab → Task 4 (core), 5 (GPU). ✓
- Protect skin/neutrals → Task 4/5 (`neutral` ramp + `skin` damp). ✓
- Saturation no longer collapses/neon (gamut roll-off vs per-channel clip) → Task 4/5. ✓
- Default Subtractive for new images, Gain for existing → Task 2 (serde default gain) + Task 6 (frontend default subtractive). ✓
- Before/after with tester frames; verify in app → Task 7. ✓
- CPU/GPU parity for every formula/constant → Tasks 3, 5, 7 (paired edits). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. Tuning steps (CMY_STRENGTH, skin consts) have concrete starting values and explicit "edit both files identically" instructions, not placeholders.

**Type consistency:** `WbMode { Gain, Subtractive }` used identically in Tasks 1-2; wire field `wb_mode: String` (Rust) / `number` u8 (`ResolvedInversion`/uniform) / `"gain"|"subtractive"` (TS `InvertParams`) — three distinct layers, each converted explicitly (`wb_mode_from`, the u8 match, the `=== 'subtractive'` checks). `apply_saturation` keeps its existing signature so `finish_pixel` is untouched. Helper names (`srgb_to_linear`/`srgbToLinear`, `linear_to_oklab`/`linearToOklab`, `oklab_to_linear`/`oklabToLinear`, `hue_dist`/`hueDist`) are consistent within each language.
