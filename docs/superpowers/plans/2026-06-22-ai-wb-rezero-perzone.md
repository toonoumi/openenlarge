# AI White Balance: Re-zero + Per-Zone Neutralizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make auto-WB land the temp/tint sliders at center with symmetric tuning headroom (Phase 1), then correct tonal-zone-dependent color casts (pink highlights / green midtones) with a gentle classical per-zone neutralizer (Phase 2a).

**Architecture:** WB today is applied solely as `wb_from_kelvin(temp, tint)` inside the Cineon inversion; the auto estimate (`as_shot_wb`) writes its result into the visible temp/tint sliders, landing them off-center. Phase 1 introduces a hidden per-image `wb_baseline` gains field that the auto estimate populates, leaving the visible sliders neutral (`temp=5500, tint=0`); the final WB is the element-wise product `wb_baseline × wb_from_kelvin(temp, tint)`. Phase 2a adds a separate corrective layer: a new estimator bins the inverted positive into shadow/mid/highlight luma zones (reusing the color-grade zone edges) and computes damped, clamped per-zone gray-world gains; a new finish-stage function applies them multiplicatively, mirrored in the GLSL shader. Both the Rust CPU path and the GLSL GPU path must stay bit-identical, as they are for every other engine constant.

**Tech Stack:** Rust (`crates/film-core` engine + `app/src-tauri` Tauri commands), TypeScript (`app/src/lib` API + develop UI), GLSL (WebGL shaders in `app/src/lib/viewport/gl/shaders.ts`).

## Global Constraints

- **CPU/GPU parity:** any engine math added to `crates/film-core` MUST be mirrored verbatim in `app/src/lib/viewport/gl/shaders.ts`, and any new uniform added to `ResolvedInversion` (`gpu_upload.rs`) MUST be added to the shader uniform list and the JS uniform upload. This is an existing invariant (see `engine.rs` "MUST equal shaders.ts" comments).
- **Noise-match invariant (commit a08d1f2):** every near-native buffer fed to the inversion must pass through `crate::convert::match_proxy_noise(&buf, PROXY_EDGE)`. Do NOT add a new decode→invert path that bypasses it. The per-zone estimator MUST run on the same proxy/noise-matched buffer the existing auto-WB estimator uses (it already does — `as_shot_wb` runs on `dev.thumb`), so it inherits this for free. Do not "fix" the resulting slight softening by removing the blur.
- **Backward compatibility:** new params MUST deserialize from old session JSON via serde defaults. `wb_baseline` defaults to `[1.0, 1.0, 1.0]`; `pz_sh`/`pz_mid`/`pz_hi` default to `[1.0, 1.0, 1.0]` (identity gains); `pz_enabled` defaults to `true`; `pz_strength` defaults to `0.7`. Identity per-zone gains guarantee an un-recomputed old edit renders identically even with `pz_enabled = true`.
- **WB composition is element-wise product:** `wb_final[c] = wb_baseline[c] * wb_from_kelvin(temp, tint)[c]`. Neutral sliders (`temp=5500, tint=0`) give `wb_from_kelvin ≈ [1,1,1]`, so `wb_final == wb_baseline`.
- **`build_params` must keep leaving `wb = [1,1,1]`:** `auto_seed_wb` and the per-zone estimator invert with `build_params` and rely on `wb == [1,1,1]`. Composition happens ONLY in `resolve_params` and `resolve_to_uniforms`.
- **Faithful tone is the sole render path** (`tone_mode` forced to `Faithful` / `1u8`). Per-zone correction applies to the inverted positive regardless of tone mode.
- Existing test suites must stay green: `cargo test -p film-core` (156 tests) and the app test suite (170 tests).

---

## Phase 1 — Re-zero WB sliders (offset/baseline model)

### File Structure (Phase 1)

- `app/src-tauri/src/session.rs` — add `wb_baseline: [f32; 3]` field to the `InvertParams` struct (the wire/persisted params).
- `app/src-tauri/src/commands.rs` — compose baseline × slider in `resolve_params`; extend `AsShotWb` with `gains`; return baseline gains from `as_shot_wb` and `gray_point_wb`.
- `app/src-tauri/src/gpu_upload.rs` — compose baseline × slider in `resolve_to_uniforms`.
- `app/src/lib/api.ts` — add `wb_baseline` to the TS `InvertParams` interface and `defaultParams`; extend `AsShotWb` type with `gains`.
- `app/src/lib/develop/*` (the WB seeding/consumer code) — on auto-WB and gray-point, write `wb_baseline` and reset `temp`/`tint` to neutral.

### Task 1: Add `wb_baseline` field to params (Rust + TS), default identity

**Files:**
- Modify: `app/src-tauri/src/session.rs` (the `InvertParams` struct, around lines 46–49)
- Modify: `app/src/lib/api.ts` (`InvertParams` interface ~line 44–91; `defaultParams` ~line 363–397)
- Test: `app/src-tauri/src/session.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Produces: `InvertParams.wb_baseline: [f32; 3]` (Rust) / `wb_baseline: [number, number, number]` (TS), default `[1.0, 1.0, 1.0]`.

- [ ] **Step 1: Write the failing test** (append to the test module in `session.rs`; if none exists, create one at the end of the file)

```rust
#[cfg(test)]
mod wb_baseline_tests {
    use super::*;

    #[test]
    fn invert_params_defaults_wb_baseline_to_identity_from_old_json() {
        // Old session JSON has no `wb_baseline` key. Serde must fill the identity
        // default so existing edits render with WB == wb_from_kelvin(temp,tint).
        let json = r#"{
            "mode":"d","stock":"none","exposure":0.0,"black":0.0,"gamma":0.4545,
            "auto_wb":true,"temp":5500.0,"tint":0.0,"wb_manual":false,
            "wb_mode":"gain","tone_mode":"faithful"
        }"#;
        let p: InvertParams = serde_json::from_str(json).expect("must deserialize old JSON");
        assert_eq!(p.wb_baseline, [1.0, 1.0, 1.0]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app --lib wb_baseline 2>&1 | tail -20` (or the crate name shown in `app/src-tauri/Cargo.toml`'s `[package] name`; check with `grep '^name' app/src-tauri/Cargo.toml`)
Expected: FAIL — `no field 'wb_baseline'` (compile error).

- [ ] **Step 3: Add the field with a serde default**

In `app/src-tauri/src/session.rs`, near the other WB fields (after `pub tint: f32,` ~line 49), add:

```rust
    /// Hidden auto-WB baseline gains (per-image). The auto estimate populates this
    /// instead of writing temp/tint, so the visible sliders re-zero to neutral with
    /// symmetric headroom. Final WB = wb_baseline × wb_from_kelvin(temp, tint).
    /// Defaults to identity so old edits (no key) render unchanged.
    #[serde(default = "default_wb_baseline")]
    pub wb_baseline: [f32; 3],
```

Add the default helper near the top of the file (after the `use` statements):

```rust
fn default_wb_baseline() -> [f32; 3] {
    [1.0, 1.0, 1.0]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p app --lib wb_baseline 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Mirror the field in TypeScript**

In `app/src/lib/api.ts`, add to the `InvertParams` interface (next to `tint: number;`):

```typescript
  /** Hidden auto-WB baseline gains; auto-WB writes this, sliders stay neutral. */
  wb_baseline: [number, number, number];
```

And in `defaultParams()` (next to `temp: 5500, tint: 0,`):

```typescript
  wb_baseline: [1, 1, 1],
```

- [ ] **Step 6: Verify TS compiles**

Run: `cd app && npm run check 2>&1 | tail -20` (or the typecheck script in `app/package.json` — `grep -A20 '"scripts"' app/package.json`)
Expected: no new type errors.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/session.rs app/src/lib/api.ts
git commit -m "feat(wb): add hidden wb_baseline param (identity default)"
```

---

### Task 2: Compose baseline × slider in the render paths

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`resolve_params` ~lines 319–327)
- Modify: `app/src-tauri/src/gpu_upload.rs` (`resolve_to_uniforms` ~line 197)
- Test: `app/src-tauri/src/commands.rs` (inline test module)

**Interfaces:**
- Consumes: `InvertParams.wb_baseline` (Task 1), `wb_from_params(temp, tint) -> [f32;3]` (existing, commands.rs:315–317).
- Produces: render `ip.wb[c] == wb_baseline[c] * wb_from_params(temp,tint)[c]` in BOTH the CPU (`resolve_params`) and GPU (`resolve_to_uniforms`) paths.

- [ ] **Step 1: Write the failing test** (add to the test module in `commands.rs`)

```rust
#[cfg(test)]
mod wb_compose_tests {
    use super::*;

    fn base_params() -> InvertParams {
        // Minimal params; rely on serde defaults via a round-trip from defaultParams-like JSON.
        serde_json::from_str(r#"{
            "mode":"d","stock":"none","exposure":0.0,"black":0.0,"gamma":0.4545,
            "auto_wb":true,"temp":5500.0,"tint":0.0,"wb_manual":false,
            "wb_mode":"gain","tone_mode":"faithful"
        }"#).unwrap()
    }

    #[test]
    fn resolve_composes_baseline_times_slider() {
        let mut p = base_params();
        p.wb_baseline = [1.2, 1.0, 0.8];
        // Neutral sliders → wb_from_params ≈ [1,1,1] → wb == baseline.
        let ip = resolve_params(&p, &film_core::Image::new(1, 1), [0.5, 0.5, 0.5]);
        for c in 0..3 {
            assert!((ip.wb[c] - p.wb_baseline[c]).abs() < 1e-3, "ch {c}: {:?}", ip.wb);
        }
    }

    #[test]
    fn neutral_baseline_equals_legacy_wb() {
        // Identity baseline must reproduce today's WB exactly (back-compat for old edits).
        let mut p = base_params();
        p.temp = 7200.0;
        p.tint = 20.0;
        p.wb_baseline = [1.0, 1.0, 1.0];
        let ip = resolve_params(&p, &film_core::Image::new(1, 1), [0.5, 0.5, 0.5]);
        let legacy = wb_from_params(p.temp, p.tint);
        for c in 0..3 {
            assert!((ip.wb[c] - legacy[c]).abs() < 1e-6, "ch {c}: {:?} vs {:?}", ip.wb, legacy);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app --lib wb_compose 2>&1 | tail -20`
Expected: FAIL — `resolve_composes_baseline_times_slider` (wb == [1,1,1], ignores baseline).

- [ ] **Step 3: Compose in `resolve_params`**

In `app/src-tauri/src/commands.rs`, change line 325 from:

```rust
    ip.wb = wb_from_params(p.temp, p.tint);
```

to:

```rust
    // Final WB = hidden auto baseline × visible slider trim (both per-channel gains).
    let slider = wb_from_params(p.temp, p.tint);
    ip.wb = std::array::from_fn(|c| p.wb_baseline[c] * slider[c]);
```

- [ ] **Step 4: Mirror in `resolve_to_uniforms`**

In `app/src-tauri/src/gpu_upload.rs`, change line 197 from:

```rust
    ip.wb = wb_from_params(p.temp, p.tint);
```

to:

```rust
    let slider = wb_from_params(p.temp, p.tint);
    ip.wb = std::array::from_fn(|c| p.wb_baseline[c] * slider[c]);
```

(`wb_from_params` is `pub(crate)` in commands.rs; it is already imported/visible here — confirm with `grep -n "wb_from_params" app/src-tauri/src/gpu_upload.rs`. If not imported, add `use crate::commands::wb_from_params;`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p app --lib wb_compose 2>&1 | tail -20`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs
git commit -m "feat(wb): compose wb_baseline x slider in CPU and GPU render paths"
```

---

### Task 3: Return baseline gains from `as_shot_wb` (auto-WB writes baseline, not sliders)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`AsShotWb` struct ~1842–1846; `as_shot_wb` ~1848–1888)
- Modify: `app/src/lib/api.ts` (the `AsShotWb` TS type)
- Test: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `auto_seed_wb(src, params, base, dev_dmax) -> (f32, f32)` (existing, returns temp/tint), `wb_from_params` (existing).
- Produces: `AsShotWb { temp: f32, tint: f32, gains: [f32; 3] }` where `gains == wb_from_params(temp, tint)` — the exact gains today's render applies, to be stored as `wb_baseline`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod as_shot_gains_tests {
    use super::*;

    #[test]
    fn as_shot_wb_gains_match_cct_projection() {
        // The returned gains must equal wb_from_params(temp,tint) so that storing
        // them as wb_baseline (with neutral sliders) reproduces today's applied WB.
        let temp = 6800.0_f32;
        let tint = 15.0_f32;
        let g = as_shot_gains(temp, tint);
        let want = wb_from_params(temp, tint);
        for c in 0..3 {
            assert!((g[c] - want[c]).abs() < 1e-6, "ch {c}: {g:?} vs {want:?}");
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app --lib as_shot_gains 2>&1 | tail -20`
Expected: FAIL — `as_shot_gains` not defined.

- [ ] **Step 3: Add the `gains` field and a small helper, populate in `as_shot_wb`**

In `commands.rs`, extend the struct (~1842):

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct AsShotWb {
    pub temp: f32,
    pub tint: f32,
    /// Baseline gains the frontend stores in `wb_baseline`; equals the WB today's
    /// render applies for (temp,tint), so storing it + neutral sliders is identical.
    pub gains: [f32; 3],
}
```

Add the helper near `wb_from_params` (~line 317):

```rust
/// Baseline gains for a (temp, tint) estimate — exactly the WB the render applies.
pub(crate) fn as_shot_gains(temp: f32, tint: f32) -> [f32; 3] {
    wb_from_params(temp, tint)
}
```

In `as_shot_wb`, change the final return (~1886–1887) from:

```rust
    let (temp, tint) = auto_seed_wb(&thumb, &params, base, dev_dmax);
    Ok(AsShotWb { temp, tint })
```

to:

```rust
    let (temp, tint) = auto_seed_wb(&thumb, &params, base, dev_dmax);
    Ok(AsShotWb { temp, tint, gains: as_shot_gains(temp, tint) })
```

- [ ] **Step 4: Update `gray_point_wb` to also return gains**

`gray_point_wb` (~2096) currently returns `AsShotWb { temp, tint: tint * 150.0 }`. The struct now needs `gains`. The gray-point pick produces *additional* gains on top of the current total WB; the new baseline that makes the clicked pixel neutral is `current_total × gp`. Replace the body:

```rust
#[tauri::command]
pub fn gray_point_wb(params: InvertParams, rgb: [f32; 3]) -> AsShotWb {
    // Additional gains (relative to the current WB) that neutralise the clicked pixel.
    let (temp, tint) = gray_point_temp_tint(&params, rgb);
    let gp = wb_from_params(temp, tint);
    // Current total WB = baseline × slider. New baseline = current_total × gp, so the
    // pick becomes the new neutral and the frontend can re-zero the sliders.
    let slider = wb_from_params(params.temp, params.tint);
    let new_baseline: [f32; 3] =
        std::array::from_fn(|c| params.wb_baseline[c] * slider[c] * gp[c]);
    AsShotWb { temp, tint: tint * 150.0, gains: new_baseline }
}
```

- [ ] **Step 5: Mirror the TS type**

In `app/src/lib/api.ts`, find the `AsShotWb` type and add `gains`:

```typescript
export interface AsShotWb {
  temp: number;
  tint: number;
  gains: [number, number, number];
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cargo test -p app --lib as_shot_gains 2>&1 | tail -20` → PASS
Run: `cd app && npm run check 2>&1 | tail -20` → no new errors

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src/lib/api.ts
git commit -m "feat(wb): as_shot_wb + gray_point_wb return baseline gains"
```

---

### Task 4: Frontend — store baseline, re-zero the sliders

**Files:**
- Modify: the develop/WB consumer in `app/src/lib/develop/` (find with `grep -rn "as_shot_wb\|gray_point_wb" app/src/lib app/src/routes`)
- Test: the existing frontend test setup (find with `grep -rn "as_shot_wb" app/src --include=*.test.ts`); if a unit boundary exists, test the mapping; otherwise verify via the manual GUI smoke step.

**Interfaces:**
- Consumes: `AsShotWb { temp, tint, gains }` (Task 3).
- Produces: on auto-WB / gray-point, sets `params.wb_baseline = result.gains`, `params.temp = 5500`, `params.tint = 0`. "Reset WB" sets `wb_baseline = [1,1,1]`, `temp = 5500`, `tint = 0`.

- [ ] **Step 1: Locate the seed call site**

Run: `grep -rn "as_shot_wb\|\.temp =\|\.tint =" app/src/lib/develop app/src/routes 2>/dev/null | head -30`
Identify where the `as_shot_wb` invoke result currently assigns `params.temp`/`params.tint`.

- [ ] **Step 2: Write/adjust the failing test (if a testable mapping fn exists)**

If the assignment is wrapped in a function (e.g. `applyAsShotWb(params, wb)`), add a test:

```typescript
import { describe, it, expect } from "vitest";
import { applyAsShotWb } from "./<file>";
import { defaultParams } from "$lib/api";

describe("applyAsShotWb", () => {
  it("stores gains as baseline and re-zeros sliders", () => {
    const p = defaultParams();
    const out = applyAsShotWb(p, { temp: 7200, tint: 30, gains: [1.2, 1, 0.8] });
    expect(out.wb_baseline).toEqual([1.2, 1, 0.8]);
    expect(out.temp).toBe(5500);
    expect(out.tint).toBe(0);
  });
});
```

If the assignment is inline (not factored), first extract it into `applyAsShotWb(params, wb): InvertParams`, then add the test.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd app && npx vitest run <file>.test.ts 2>&1 | tail -20`
Expected: FAIL — still assigns temp/tint from the estimate.

- [ ] **Step 4: Implement the re-zero mapping**

```typescript
export function applyAsShotWb(p: InvertParams, wb: AsShotWb): InvertParams {
  return { ...p, wb_baseline: wb.gains, temp: 5500, tint: 0 };
}
```

Wire the gray-point handler the same way (it returns `gains` as the new baseline). Update any "Reset WB" / default control to set `wb_baseline: [1, 1, 1], temp: 5500, tint: 0`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd app && npx vitest run <file>.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib
git commit -m "feat(wb): frontend stores auto-WB as baseline, re-zeros temp/tint"
```

---

### Task 5: Phase 1 manual GUI smoke test + full suites

**Files:** none (verification only)

- [ ] **Step 1: Run both backend suites**

Run: `cargo test -p film-core 2>&1 | tail -5 && cargo test -p app --lib 2>&1 | tail -5`
Expected: all green (≥156 film-core, ≥170 app, plus the new tests).

- [ ] **Step 2: Build + launch the app**

Use the `run` skill (or `cd app && npm run tauri dev`). Open a roll.

- [ ] **Step 3: Verify the re-zero behavior**

- Open an image → Temp slider reads 5500, Tint reads 0 (centered), image is auto-corrected (not raw).
- Push Temp warmer/cooler — symmetric room both directions.
- Gray-point pick a neutral patch → it becomes neutral AND sliders snap back to 5500/0.
- Open an OLD edit (developed before this change) → renders identically to before; its saved temp/tint show where they were.

- [ ] **Step 4: Commit any fixes, then proceed to Phase 2a.**

---

## Phase 2a — Per-zone neutralizer (classical)

### File Structure (Phase 2a)

- `crates/film-core/src/calibrate.rs` — add `per_zone_wb_gains(...)` estimator (bins inverted positive into 3 luma zones, per-zone damped/clamped gray-world gains, identity fallback).
- `crates/film-core/src/finish.rs` — add `apply_per_zone_wb(rgb, pz)` (luma-keyed multiplicative correction, same smoothstep weights as `color_grade`), and wire it into the finish pipeline BEFORE `color_grade`.
- `crates/film-core/src/engine.rs` or `finish.rs` — a `PerZoneWb` struct holding the 3 zone gains + strength + enabled.
- `app/src-tauri/src/session.rs` — add `pz_enabled`, `pz_strength`, `pz_sh`, `pz_mid`, `pz_hi` params.
- `app/src-tauri/src/commands.rs` — add `per_zone_wb` command (estimate on the developed thumb, crop-aware like `as_shot_wb`); register it in `lib.rs`.
- `app/src-tauri/src/gpu_upload.rs` — add per-zone uniforms to `ResolvedInversion`.
- `app/src/lib/api.ts` — add the params + a `PerZoneWb` type + `defaultParams`.
- `app/src/lib/viewport/gl/shaders.ts` — mirror `apply_per_zone_wb` in GLSL, add uniforms, apply before `colorGrade`.
- `app/src/lib/develop/*` — toggle + intensity slider UI; invoke `per_zone_wb` and store the result.

### Zone-edge constants to reuse (from `finish.rs` ColorGrade, lines 330–332)

`sh_edge = 0.33`, `hi_edge = 0.66`, `softness = 0.25`. Luma weights (mirror of `color_grade`, finish.rs:378–391):
```
w_sh  = 1 - smoothstep(sh_edge - soft, sh_edge + soft, L)
w_hi  =     smoothstep(hi_edge - soft, hi_edge + soft, L)
w_mid = clamp(1 - w_sh - w_hi, 0, 1)
```
with `luma L = 0.2126 r + 0.7152 g + 0.0722 b` and `smoothstep(e0,e1,x) = t*t*(3-2t), t=clamp((x-e0)/(e1-e0),0,1)`.

### Task 6: Per-zone gray-world estimator in `calibrate.rs`

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (add function + constants near `auto_wb_gains_strength`, after line 291)
- Test: `crates/film-core/src/calibrate.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Consumes: an already-inverted positive `&Image`.
- Produces:
  ```rust
  pub const PER_ZONE_STRENGTH: f32 = 0.7;
  pub const PER_ZONE_MAX_GAIN: f32 = 1.25; // clamp: no zone swings more than ±25%
  /// Per-zone gray-world gains [shadows, mids, highlights], each [r,g,b].
  /// A zone with too few near-neutral pixels yields identity [1,1,1].
  pub fn per_zone_wb_gains(img: &Image, strength: f32) -> [[f32; 3]; 3];
  ```

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod per_zone_tests {
    use super::*;

    fn luma(p: [f32; 3]) -> f32 { 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] }

    #[test]
    fn uniform_cast_gives_equal_zone_gains() {
        // A single cast across all tones → all three zones report the same gains
        // (the faithfulness invariant: per-zone collapses to a global correction).
        let cast = [0.6f32, 0.5, 0.45];
        let mut pixels = Vec::new();
        for i in 0..300 {
            let s = 0.15 + 0.7 * (i as f32 / 299.0); // sweep brightness across zones
            pixels.push([cast[0] * s, cast[1] * s, cast[2] * s]);
        }
        let img = Image { width: 300, height: 1, pixels, ir: None };
        let z = per_zone_wb_gains(&img, 1.0);
        for c in 0..3 {
            assert!((z[0][c] - z[1][c]).abs() < 0.05, "sh vs mid ch{c}: {z:?}");
            assert!((z[1][c] - z[2][c]).abs() < 0.05, "mid vs hi ch{c}: {z:?}");
        }
    }

    #[test]
    fn pink_highlights_neutral_mids_corrects_only_highlights() {
        // Mids neutral gray, highlights pushed pink (R,B up vs G). The highlight zone
        // must get a correction (G boosted relative to R/B), the mid zone ≈ identity.
        let mut pixels = Vec::new();
        for _ in 0..400 { pixels.push([0.45f32, 0.45, 0.45]); }      // neutral mids
        for _ in 0..200 { pixels.push([0.92f32, 0.80, 0.90]); }      // pink highlights
        let img = Image { width: 600, height: 1, pixels, ir: None };
        let z = per_zone_wb_gains(&img, 1.0);
        // mid zone ~identity
        for c in 0..3 { assert!((z[1][c] - 1.0).abs() < 0.08, "mid not identity ch{c}: {z:?}"); }
        // highlight zone boosts green relative to red/blue (neutralises pink)
        assert!(z[2][1] > z[2][0] && z[2][1] > z[2][2], "highlights not de-pinked: {z:?}");
    }

    #[test]
    fn empty_zone_is_identity() {
        // All pixels in the mid band → shadow & highlight zones have no pixels →
        // identity gains (never invent a cast).
        let img = Image { width: 100, height: 1, pixels: vec![[0.45, 0.45, 0.45]; 100], ir: None };
        let z = per_zone_wb_gains(&img, 1.0);
        assert_eq!(z[0], [1.0, 1.0, 1.0], "empty shadow zone must be identity: {z:?}");
        assert_eq!(z[2], [1.0, 1.0, 1.0], "empty highlight zone must be identity: {z:?}");
    }

    #[test]
    fn gains_are_clamped() {
        // An extreme single-zone cast must be bounded by PER_ZONE_MAX_GAIN.
        let mut pixels = vec![[0.45f32, 0.45, 0.45]; 300];
        for _ in 0..300 { pixels.push([0.95f32, 0.05, 0.95]); } // violently pink highlights
        let img = Image { width: 600, height: 1, pixels, ir: None };
        let z = per_zone_wb_gains(&img, 1.0);
        for zone in &z {
            for &g in zone {
                assert!(g <= PER_ZONE_MAX_GAIN + 1e-4 && g >= 1.0 / PER_ZONE_MAX_GAIN - 1e-4,
                    "gain out of clamp: {g} in {z:?}");
            }
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core per_zone 2>&1 | tail -20`
Expected: FAIL — `per_zone_wb_gains` not defined.

- [ ] **Step 3: Implement the estimator**

Add to `calibrate.rs` (after `auto_wb_gains_strength`, ~line 291):

```rust
/// Per-zone damping (analogous to AUTO_WB_STRENGTH): corrects most of a zone's
/// residual cast while leaving the look faithful. Tunable on real problem rolls.
pub const PER_ZONE_STRENGTH: f32 = 0.7;
/// Hard clamp on any per-zone per-channel gain — keeps the correction gentle so it
/// never reads as "AI-processed". ±25%.
pub const PER_ZONE_MAX_GAIN: f32 = 1.25;

/// Zone edges + softness reused from the color-grade split-toning (finish.rs).
const PZ_SH_EDGE: f32 = 0.33;
const PZ_HI_EDGE: f32 = 0.66;
const PZ_SOFT: f32 = 0.25;

#[inline]
fn pz_luma(p: [f32; 3]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}
#[inline]
fn pz_smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Per-zone gray-world WB gains [shadows, mids, highlights] from an already-inverted
/// positive. Bins near-neutral pixels into 3 luma zones (the color-grade edges),
/// computes a damped, clamped gray-world correction per zone, and returns identity
/// for any zone with too few neutral pixels. With a uniform cast all zones agree, so
/// the result collapses to a global correction (faithfulness invariant).
pub fn per_zone_wb_gains(img: &Image, strength: f32) -> [[f32; 3]; 3] {
    let identity = [1.0f32, 1.0, 1.0];
    if img.pixels.is_empty() {
        return [identity; 3];
    }
    let k = strength.clamp(0.0, 1.0);
    // Accumulate a saturation-gated, weighted channel sum per zone.
    // weights: [shadow, mid, highlight] from the luma smoothstep masks.
    let mut sum = [[0.0f64; 3]; 3];
    let mut wsum = [0.0f64; 3];
    for &p in &img.pixels {
        let mx = p[0].max(p[1]).max(p[2]);
        let mn = p[0].min(p[1]).min(p[2]);
        let sat = if mx > 1e-6 { (mx - mn) / mx } else { 0.0 };
        if sat > 0.25 {
            continue; // reject chromatic content (same gate spirit as auto_wb_gains)
        }
        let l = pz_luma(p);
        let w_sh = 1.0 - pz_smoothstep(PZ_SH_EDGE - PZ_SOFT, PZ_SH_EDGE + PZ_SOFT, l);
        let w_hi = pz_smoothstep(PZ_HI_EDGE - PZ_SOFT, PZ_HI_EDGE + PZ_SOFT, l);
        let w_mid = (1.0 - w_sh - w_hi).clamp(0.0, 1.0);
        let w = [w_sh, w_mid, w_hi];
        for z in 0..3 {
            wsum[z] += w[z] as f64;
            for c in 0..3 {
                sum[z][c] += (w[z] * p[c]) as f64;
            }
        }
    }
    // Min effective pixel weight for a zone to be trusted (≈ a handful of pixels).
    let min_w = (img.pixels.len() as f64 / 50.0).max(8.0);
    let mut out = [identity; 3];
    for z in 0..3 {
        if wsum[z] < min_w {
            continue; // too few neutral pixels → identity, never invent a cast
        }
        let mean = [
            (sum[z][0] / wsum[z]) as f32,
            (sum[z][1] / wsum[z]) as f32,
            (sum[z][2] / wsum[z]) as f32,
        ];
        let gray = (mean[0] + mean[1] + mean[2]) / 3.0;
        for c in 0..3 {
            let raw = gray / mean[c].max(1e-6);
            let damped = 1.0 + k * (raw - 1.0);
            out[z][c] = damped.clamp(1.0 / PER_ZONE_MAX_GAIN, PER_ZONE_MAX_GAIN);
        }
    }
    out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core per_zone 2>&1 | tail -20`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(wb): per-zone gray-world estimator (damped, clamped, identity fallback)"
```

---

### Task 7: `apply_per_zone_wb` in `finish.rs` + pipeline wiring

**Files:**
- Modify: `crates/film-core/src/finish.rs` (add struct + apply fn; wire into the finish entry point before `color_grade`)
- Test: `crates/film-core/src/finish.rs`

**Interfaces:**
- Consumes: per-zone gains `[[f32;3];3]` (Task 6).
- Produces:
  ```rust
  pub struct PerZoneWb { pub enabled: bool, pub sh: [f32;3], pub mid: [f32;3], pub hi: [f32;3] }
  impl Default for PerZoneWb { /* enabled:true, all identity */ }
  pub fn apply_per_zone_wb(rgb: [f32; 3], pz: &PerZoneWb) -> [f32; 3];
  ```
- The function is called at the START of the finish stage (before `color_grade`) so the correction is in the same inverted-positive domain the estimator measured.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod per_zone_apply_tests {
    use super::*;

    #[test]
    fn identity_gains_are_noop() {
        let pz = PerZoneWb::default();
        let rgb = [0.2, 0.5, 0.8];
        let out = apply_per_zone_wb(rgb, &pz);
        for c in 0..3 { assert!((out[c] - rgb[c]).abs() < 1e-6, "noop ch{c}: {out:?}"); }
    }

    #[test]
    fn disabled_is_noop_even_with_gains() {
        let pz = PerZoneWb { enabled: false, sh: [1.2,1.0,0.8], mid: [1.1,1.0,0.9], hi: [0.8,1.2,0.9] };
        let rgb = [0.2, 0.5, 0.8];
        let out = apply_per_zone_wb(rgb, &pz);
        for c in 0..3 { assert!((out[c] - rgb[c]).abs() < 1e-6, "disabled ch{c}: {out:?}"); }
    }

    #[test]
    fn highlight_gain_affects_bright_pixel_not_dark() {
        // A highlight-only green boost must move a bright pixel's green but leave a
        // shadow pixel ~unchanged (luma-keyed weighting).
        let pz = PerZoneWb { enabled: true, sh: [1.0;3], mid: [1.0;3], hi: [1.0, 1.2, 1.0] };
        let bright = apply_per_zone_wb([0.9, 0.9, 0.9], &pz);
        let dark = apply_per_zone_wb([0.05, 0.05, 0.05], &pz);
        assert!(bright[1] > 0.9 + 1e-3, "highlight green not boosted: {bright:?}");
        assert!((dark[1] - 0.05).abs() < 1e-2, "shadow wrongly changed: {dark:?}");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core per_zone_apply 2>&1 | tail -20`
Expected: FAIL — `PerZoneWb` / `apply_per_zone_wb` not defined.

- [ ] **Step 3: Implement struct + apply fn** (add to `finish.rs`, reusing its existing `luma` and `smoothstep`)

```rust
/// Corrective per-zone white-balance gains (shadows/mids/highlights), applied to the
/// inverted positive BEFORE the creative color grade. Separate from `ColorGrade` so
/// it never overwrites the user's artistic toning. Identity gains + the disabled flag
/// both render as a no-op (back-compat for old edits).
#[derive(Debug, Clone, Copy)]
pub struct PerZoneWb {
    pub enabled: bool,
    pub sh: [f32; 3],
    pub mid: [f32; 3],
    pub hi: [f32; 3],
}

impl Default for PerZoneWb {
    fn default() -> Self {
        PerZoneWb { enabled: true, sh: [1.0; 3], mid: [1.0; 3], hi: [1.0; 3] }
    }
}

/// Edges/softness mirror the color-grade zones (this file's ColorGrade defaults).
const PZ_SH_EDGE: f32 = 0.33;
const PZ_HI_EDGE: f32 = 0.66;
const PZ_SOFT: f32 = 0.25;

/// Apply the per-zone WB correction: luma-keyed blend of the three zone gains, then a
/// per-channel multiply. Mirror in shaders.ts `applyPerZoneWb`.
pub fn apply_per_zone_wb(rgb: [f32; 3], pz: &PerZoneWb) -> [f32; 3] {
    if !pz.enabled {
        return rgb;
    }
    let l = luma(rgb);
    let w_sh = 1.0 - smoothstep(PZ_SH_EDGE - PZ_SOFT, PZ_SH_EDGE + PZ_SOFT, l);
    let w_hi = smoothstep(PZ_HI_EDGE - PZ_SOFT, PZ_HI_EDGE + PZ_SOFT, l);
    let w_mid = (1.0 - w_sh - w_hi).clamp(0.0, 1.0);
    std::array::from_fn(|c| {
        let gain = w_sh * pz.sh[c] + w_mid * pz.mid[c] + w_hi * pz.hi[c];
        (rgb[c] * gain).clamp(0.0, 1.0)
    })
}
```

- [ ] **Step 4: Wire into the finish pipeline before `color_grade`**

Find the finish entry point that applies the finishing chain (search `grep -n "color_grade(" crates/film-core/src/finish.rs`). Add a `PerZoneWb` to the finish params struct (`FinishParams` — confirm name with `grep -n "pub struct Finish" crates/film-core/src/finish.rs`) and call `apply_per_zone_wb(rgb, &fp.per_zone)` as the FIRST step of the per-pixel finish, before the `color_grade` call. Add a regression test that a default `PerZoneWb` leaves the finish output unchanged vs. the pre-feature path (capture a value, assert equality).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p film-core per_zone 2>&1 | tail -20 && cargo test -p film-core 2>&1 | tail -5`
Expected: PASS; full film-core suite green.

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/finish.rs
git commit -m "feat(wb): apply_per_zone_wb finish layer before creative color grade"
```

---

### Task 8: Params + GPU uniforms for per-zone WB

**Files:**
- Modify: `app/src-tauri/src/session.rs` (`InvertParams`: add `pz_enabled`, `pz_strength`, `pz_sh`, `pz_mid`, `pz_hi`)
- Modify: `app/src-tauri/src/gpu_upload.rs` (`ResolvedInversion` + `resolve_to_uniforms`)
- Modify: `app/src-tauri/src/commands.rs` (`build_params` / finish-params builder: map params → `PerZoneWb`)
- Modify: `app/src/lib/api.ts` (interface + `defaultParams`)
- Test: `app/src-tauri/src/session.rs`, `gpu_upload.rs`

**Interfaces:**
- Produces (Rust + TS params): `pz_enabled: bool` (default true), `pz_strength: f32` (default 0.7), `pz_sh/pz_mid/pz_hi: [f32;3]` (default identity).
- Produces (GPU): `ResolvedInversion.pz_enabled: u8`, `pz_sh/pz_mid/pz_hi: [f32;3]` packed for the shader.

- [ ] **Step 1: Write the failing test** (session.rs)

```rust
#[test]
fn per_zone_params_default_from_old_json() {
    let json = r#"{
        "mode":"d","stock":"none","exposure":0.0,"black":0.0,"gamma":0.4545,
        "auto_wb":true,"temp":5500.0,"tint":0.0,"wb_manual":false,
        "wb_mode":"gain","tone_mode":"faithful"
    }"#;
    let p: InvertParams = serde_json::from_str(json).unwrap();
    assert!(p.pz_enabled);
    assert_eq!(p.pz_sh, [1.0, 1.0, 1.0]);
    assert_eq!(p.pz_mid, [1.0, 1.0, 1.0]);
    assert_eq!(p.pz_hi, [1.0, 1.0, 1.0]);
    assert!((p.pz_strength - 0.7).abs() < 1e-6);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p app --lib per_zone_params_default 2>&1 | tail -20`
Expected: FAIL (no fields).

- [ ] **Step 3: Add the params with serde defaults** (session.rs)

```rust
    #[serde(default = "pz_default_enabled")]
    pub pz_enabled: bool,
    #[serde(default = "pz_default_strength")]
    pub pz_strength: f32,
    #[serde(default = "default_wb_baseline")]
    pub pz_sh: [f32; 3],
    #[serde(default = "default_wb_baseline")]
    pub pz_mid: [f32; 3],
    #[serde(default = "default_wb_baseline")]
    pub pz_hi: [f32; 3],
```

Helpers (near `default_wb_baseline`):

```rust
fn pz_default_enabled() -> bool { true }
fn pz_default_strength() -> f32 { 0.7 }
```

- [ ] **Step 4: Map params → `PerZoneWb` where the finish params are built**

In `commands.rs`, where `FinishParams` is assembled (search `grep -n "FinishParams\s*{" app/src-tauri/src/commands.rs`), set:

```rust
        per_zone: film_core::finish::PerZoneWb {
            enabled: p.pz_enabled,
            sh: p.pz_sh,
            mid: p.pz_mid,
            hi: p.pz_hi,
        },
```

(The estimator's `strength` is applied at estimate time in the `per_zone_wb` command, Task 9 — the gains stored in params are already damped, so the apply path needs only the gains.)

- [ ] **Step 5: Add GPU uniforms** (gpu_upload.rs `ResolvedInversion`)

```rust
    pub pz_enabled: u8,     // 0/1
    pub pz_sh: [f32; 3],
    pub pz_mid: [f32; 3],
    pub pz_hi: [f32; 3],
```

In `resolve_to_uniforms`, populate from `p`:

```rust
        pz_enabled: if p.pz_enabled { 1 } else { 0 },
        pz_sh: p.pz_sh,
        pz_mid: p.pz_mid,
        pz_hi: p.pz_hi,
```

- [ ] **Step 6: Mirror TS params** (api.ts interface + defaultParams)

```typescript
  pz_enabled: boolean;
  pz_strength: number;
  pz_sh: [number, number, number];
  pz_mid: [number, number, number];
  pz_hi: [number, number, number];
```

```typescript
  pz_enabled: true, pz_strength: 0.7,
  pz_sh: [1, 1, 1], pz_mid: [1, 1, 1], pz_hi: [1, 1, 1],
```

- [ ] **Step 7: Run tests + typecheck**

Run: `cargo test -p app --lib per_zone_params_default 2>&1 | tail -20` → PASS
Run: `cargo build -p app 2>&1 | tail -5` → builds (struct field coverage)
Run: `cd app && npm run check 2>&1 | tail -20` → no new errors

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs app/src/lib/api.ts
git commit -m "feat(wb): per-zone WB params + GPU uniforms (identity default)"
```

---

### Task 9: `per_zone_wb` command (estimate + store)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (new command, mirror `as_shot_wb` crop/orient handling)
- Modify: `app/src-tauri/src/lib.rs` (register the command in the handler list, next to `as_shot_wb` ~line 130)
- Modify: `app/src/lib/api.ts` (add `PerZoneWb` type + invoke wrapper)
- Test: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `per_zone_wb_gains(img, strength)` (Task 6), `resolve_params` (Task 2), the developed thumb + crop/orient args (same shape as `as_shot_wb`).
- Produces: `PerZoneWb { sh: [f32;3], mid: [f32;3], hi: [f32;3] }` (serialized), stored by the frontend into `pz_sh/pz_mid/pz_hi`.

- [ ] **Step 1: Write the failing test** (estimate helper, factored like `auto_seed_wb`)

```rust
#[test]
fn per_zone_seed_uniform_cast_matches_global_direction() {
    // Invert a synthetic uniformly-cast neutral ramp; the per-zone seed gains should
    // all push the same direction (faithfulness: agrees with a global gray-world).
    use film_core::Image;
    let mut pixels = Vec::new();
    for i in 0..300 {
        let s = 0.1 + 0.8 * (i as f32 / 299.0);
        pixels.push([0.6 * s, 0.5 * s, 0.45 * s]);
    }
    let src = Image { width: 300, height: 1, pixels, ir: None };
    let z = per_zone_seed(&src, 1.0);
    // Blue is the dimmest channel of the cast → blue gain > 1 in every populated zone.
    for zone in &z {
        if *zone != [1.0, 1.0, 1.0] {
            assert!(zone[2] >= zone[0], "blue should be boosted: {zone:?}");
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p app --lib per_zone_seed 2>&1 | tail -20`
Expected: FAIL — `per_zone_seed` not defined.

- [ ] **Step 3: Implement the seed helper + command**

Helper (near `auto_seed_wb`, ~1895):

```rust
/// Per-zone WB seed: invert `src` with the CURRENT resolved WB (baseline × slider),
/// then estimate residual per-zone gray-world gains. The estimate runs on the same
/// developed-thumb proxy as `auto_seed_wb`, so it inherits the noise-match invariant.
pub(crate) fn per_zone_seed(src: &film_core::Image, strength: f32) -> [[f32; 3]; 3] {
    film_core::calibrate::per_zone_wb_gains(src, strength)
}
```

Command (near `as_shot_wb`):

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct PerZoneWbResult {
    pub sh: [f32; 3],
    pub mid: [f32; 3],
    pub hi: [f32; 3],
}

#[tauri::command]
pub fn per_zone_wb(
    id: String,
    params: InvertParams,
    crop: Option<[f64; 4]>,
    rot90: Option<u8>,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
    angle: Option<f32>,
    session: State<Session>,
) -> Result<PerZoneWbResult, String> {
    ensure_resident(&session, &id)?;
    let (base, thumb, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (dev.base, dev.thumb.clone(), dev.d_max)
    };
    // Orient/crop exactly like as_shot_wb so the estimate matches the rendered region.
    let thumb = match crop {
        Some(nc) => {
            let geom = geom_base(&thumb, rot90.unwrap_or(0), flip_h.unwrap_or(false),
                                 flip_v.unwrap_or(false), angle.unwrap_or(0.0));
            let (x, y, w, h) = crop_px(nc, geom.width, geom.height);
            crate::convert::crop(&geom, x, y, w, h)
        }
        None => thumb,
    };
    // Invert with the CURRENT resolved WB so per-zone measures the RESIDUAL cast.
    let mut ip = resolve_params(&params, &thumb, effective_base(&params, base));
    ip.d_max = effective_dmax(&params, dev_dmax);
    let positive = invert_image(&thumb, &ip, mode_from(&params.mode));
    let z = per_zone_seed(&positive, params.pz_strength);
    Ok(PerZoneWbResult { sh: z[0], mid: z[1], hi: z[2] })
}
```

- [ ] **Step 4: Register the command** (lib.rs ~line 130)

```rust
            commands::per_zone_wb,
```

- [ ] **Step 5: Add the TS type + invoke wrapper** (api.ts)

```typescript
export interface PerZoneWbResult {
  sh: [number, number, number];
  mid: [number, number, number];
  hi: [number, number, number];
}
```

Add an invoke wrapper next to the existing `asShotWb` wrapper (find with `grep -n "as_shot_wb" app/src/lib/api.ts`).

- [ ] **Step 6: Run tests + build**

Run: `cargo test -p app --lib per_zone_seed 2>&1 | tail -20` → PASS
Run: `cargo build -p app 2>&1 | tail -5` → builds
Run: `cd app && npm run check 2>&1 | tail -20` → no new errors

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/lib/api.ts
git commit -m "feat(wb): per_zone_wb command estimates residual per-zone cast"
```

---

### Task 10: Mirror per-zone WB in the GLSL shader

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (add uniforms; add `applyPerZoneWb`; call it before `colorGrade`)
- Modify: the JS uniform-upload site (search `grep -rn "u_cg_sh_edge\|uniform.*u_wb" app/src/lib/viewport/gl`)
- Test: GPU↔CPU parity check (see Step 4)

**Interfaces:**
- Consumes: `ResolvedInversion.pz_enabled/pz_sh/pz_mid/pz_hi` (Task 8).
- Produces: GLSL output bit-matching `apply_per_zone_wb` (Task 7) for the same inputs.

- [ ] **Step 1: Add uniforms** (shaders.ts, near `u_cg_*` ~lines 27–29)

```glsl
uniform int u_pz_enabled;       // 0/1
uniform vec3 u_pz_sh, u_pz_mid, u_pz_hi;
```

- [ ] **Step 2: Add the mirror function** (near `colorGrade`, ~line 70)

```glsl
vec3 applyPerZoneWb(vec3 rgb) {
  if (u_pz_enabled == 0) return rgb;
  float L = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float wsh = 1.0 - smoothstep(0.33 - 0.25, 0.33 + 0.25, L);
  float whi = smoothstep(0.66 - 0.25, 0.66 + 0.25, L);
  float wmid = clamp(1.0 - wsh - whi, 0.0, 1.0);
  vec3 gain = wsh * u_pz_sh + wmid * u_pz_mid + whi * u_pz_hi;
  return clamp(rgb * gain, 0.0, 1.0);
}
```

(Confirm the shader already defines a `smoothstep` matching `t*t*(3-2t)`; GLSL's built-in `smoothstep` is exactly this, so use the built-in — it matches finish.rs.)

- [ ] **Step 3: Call it before `colorGrade`** (in the finish FRAG main, where `colorGrade(...)` is applied)

Change `vec3 c = colorGrade(rgb);` (or equivalent) to:

```glsl
vec3 c = colorGrade(applyPerZoneWb(rgb));
```

- [ ] **Step 4: Upload the uniforms in JS**

At the uniform-upload site (where `u_cg_sh_off` etc. are set from `ResolvedInversion`), add:

```javascript
gl.uniform1i(loc.u_pz_enabled, r.pz_enabled);
gl.uniform3fv(loc.u_pz_sh, r.pz_sh);
gl.uniform3fv(loc.u_pz_mid, r.pz_mid);
gl.uniform3fv(loc.u_pz_hi, r.pz_hi);
```

(Match the existing pattern for getting uniform locations — search how `u_cg_sh_off` is registered and replicate for the four new uniforms.)

- [ ] **Step 5: Parity check (manual numeric)**

Pick three RGB probes (a shadow `[0.05,0.05,0.05]`, a mid `[0.45,0.45,0.45]`, a highlight `[0.9,0.85,0.9]`) and a non-trivial gain set (`sh=[1,1,1]`, `mid=[1.05,1,0.95]`, `hi=[1,1.2,1]`). Hand-evaluate `apply_per_zone_wb` (Rust) for each and confirm the GLSL expression produces the same numbers (the weights and multiply are identical; built-in `smoothstep` matches). Document the three expected values in a comment next to `applyPerZoneWb` so a future shader edit can be checked.

- [ ] **Step 6: Typecheck + commit**

Run: `cd app && npm run check 2>&1 | tail -20` → no new errors

```bash
git add app/src/lib/viewport/gl/shaders.ts app/src/lib/viewport/gl
git commit -m "feat(wb): mirror per-zone WB correction in GLSL before color grade"
```

---

### Task 11: Per-zone UI (toggle + intensity) + invoke wiring

**Files:**
- Modify: the develop WB panel component (find with `grep -rln "Temp\|tint\|wb_mode" app/src/lib/develop app/src/routes`)
- Modify: `app/src/lib/develop/*` seed flow (invoke `per_zone_wb` when an image activates / when auto-WB runs, store the result into `pz_*`)

**Interfaces:**
- Consumes: `per_zone_wb` invoke wrapper + `PerZoneWbResult` (Task 9).
- Produces: a "Per-zone neutralize" toggle bound to `pz_enabled` and an intensity slider bound to `pz_strength`; on auto-WB/activate, `pz_sh/pz_mid/pz_hi` are populated from the command.

- [ ] **Step 1: Add the toggle + slider control** next to the existing WB (Temp/Tint) controls, bound to `params.pz_enabled` and `params.pz_strength` (0..1; label e.g. "Per-zone WB" + "Strength"). Follow the existing slider/toggle component pattern in the develop panel.

- [ ] **Step 2: Invoke `per_zone_wb` in the seed flow.** Where `applyAsShotWb` runs (Task 4), after setting the baseline, also call `per_zone_wb({ id, params, crop, rot90, flip_h, flip_v, angle })` and store `pz_sh/pz_mid/pz_hi`. Re-run it when `pz_strength` changes or the user re-triggers Auto.

- [ ] **Step 3: Changing `pz_strength` re-estimates** (since damping is applied at estimate time). Wire the slider's change handler to re-invoke `per_zone_wb`. Debounce to avoid a call per pixel of drag (match any existing debounced-recompute pattern in the panel).

- [ ] **Step 4: Verify typecheck**

Run: `cd app && npm run check 2>&1 | tail -20` → no new errors

- [ ] **Step 5: Commit**

```bash
git add app/src/lib app/src/routes
git commit -m "feat(wb): per-zone WB toggle + intensity UI, wired to per_zone_wb"
```

---

### Task 12: Phase 2a verification — full suites + GUI smoke

**Files:** none (verification only)

- [ ] **Step 1: Full suites**

Run: `cargo test -p film-core 2>&1 | tail -5 && cargo test -p app --lib 2>&1 | tail -5`
Expected: all green.

- [ ] **Step 2: GUI smoke on a problem roll** (the Phoenix roll / a pink-highlight frame)

- Open a frame with pink highlights → toggle Per-zone WB off/on: highlights should de-pink while midtones stay put.
- A correctly-developed neutral frame → per-zone makes little/no visible change (faithfulness).
- Strength slider scales the effect; at 0 it's identity.
- Deep-zoom and export the frame → no pink shift vs fit-view (noise-match invariant holds; the estimate runs on the proxy thumb).
- Open an old edit → unchanged (identity per-zone gains).

- [ ] **Step 3: Commit any fixes.**

---

## Self-Review

**Spec coverage:**
- Phase 1 re-zero (baseline + neutral sliders) → Tasks 1–4. ✓
- Phase 1 gray-point/recalibrate update baseline + reset sliders → Task 3 (gray_point_wb) + Task 4. ✓
- Phase 1 migration (old edits identical) → identity `wb_baseline` serde default, Task 1 test + Task 2 `neutral_baseline_equals_legacy_wb`. ✓ (Simpler than the spec's back-conversion formula because today's applied WB is already `wb_from_params(temp,tint)`; identity baseline + saved sliders reproduces it exactly. Noted as a refinement.)
- Phase 2a per-zone estimator (3 zones, reuse color-grade edges, zero-correction fallback, damp+clamp) → Task 6. ✓
- Phase 2a separate corrective layer (not creative color-grade) applied before color grade → Task 7 + Task 10. ✓
- Phase 2a faithfulness invariant (uniform cast ⇒ global) → Task 6 `uniform_cast_gives_equal_zone_gains`, Task 9 seed test. ✓
- Phase 2a noise-consistent sampling → estimate runs on `dev.thumb` proxy (Task 9), same buffer as `as_shot_wb`; documented in Global Constraints. ✓
- Phase 2a toggle + intensity, default on conservative → Tasks 8 (defaults) + 11 (UI). ✓
- CPU/GPU parity → Task 7 (Rust) + Task 10 (GLSL) + parity check. ✓
- Phase 2b → out of scope (stub in spec only). ✓

**Spec deviations (intentional, lower-risk):**
1. `wb_baseline` is **per-image** (a param field), not per-roll — matches the existing per-image `as_shot_wb`. The "all images land centered" UX is unaffected.
2. Migration needs **no back-conversion** — identity baseline + saved temp/tint is byte-identical to today.

**Placeholder scan:** No TBD/TODO. The few "find with grep" steps are unavoidable discovery in an unfamiliar UI tree and each gives the exact search + what to change; all engine/command/shader code is given in full.

**Type consistency:** `wb_baseline: [f32;3]`/`[number,…]`; `AsShotWb.gains`; `PerZoneWb { enabled, sh, mid, hi }` (engine) vs `PerZoneWbResult { sh, mid, hi }` (command wire) — distinct names by design (the wire result has no enabled/strength; those are separate params). `per_zone_wb_gains` (estimator) vs `per_zone_seed` (command helper) vs `per_zone_wb` (command) — distinct, referenced consistently. Defaults align: `pz_enabled=true`, `pz_strength=0.7`, gains identity, in both Rust serde defaults and TS `defaultParams`.
