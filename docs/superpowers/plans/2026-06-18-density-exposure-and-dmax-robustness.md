# Density-domain exposure + d_max robustness (B3 + I1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Exposure slider drive the effective `d_max` (black-anchored) so lowering exposure re-separates blown highlights instead of graying them (I1), and make crop re-analysis robust + always revertible (B3) — one coherent engine change mirrored to GL.

**Architecture:** In the negative inversion, exposure stops modulate `eff_d_max = clamp(d_max·2^(−K·EV), LO, HI)` and the linear `print_exposure` gain is dropped from `print_lin`; EV=0 is byte-identical. The same formula is mirrored in the WebGL shader (no new uniforms — `EV` is derived from the existing `u_print_exposure`). B3 adds a density-spread guard in `analyze()` (reject range-destroying estimates) plus a one-click UI revert snapshot.

**Tech Stack:** Rust (`film-core` crate, `cargo test`), WebGL2 GLSL strings, Svelte/TypeScript frontend, Tauri commands.

## Global Constraints

- Work on `main` (no feature branch) — user preference.
- CPU (`crates/film-core/src/engine.rs`) and GL (`app/src/lib/viewport/gl/shaders.ts`) math MUST stay identical; the coupling constants `K_EXPO=0.5`, `EFF_DMAX_LO=0.5`, `EFF_DMAX_HI=6.0` are duplicated verbatim in both and are the source-of-truth pairing.
- Do NOT touch the Reinhard soft-clip curve or the `soft_clip` threshold (B1 owns clip detection, kept additive).
- EV=0 (`print_exposure=1.0`) default render MUST remain byte-identical; all existing `engine.rs` tests pass unchanged.
- `i18n` strings are generated: edit `/i18n-strings.csv` then run `scripts/gen-i18n.py`; never hand-edit `dict.ts`.
- Positive path (`develop_positive_px` / shader positive branch) is unchanged — `print_exposure` stays a linear gain there.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Engine — exposure drives effective `d_max` (Rust)

**Files:**
- Modify: `crates/film-core/src/engine.rs:68-73` (add coupling constants near `EPS`/`HDR_*`)
- Modify: `crates/film-core/src/engine.rs:100-138` (`invert_d` negative branch)
- Test: `crates/film-core/src/engine.rs` `#[cfg(test)] mod tests` (append)

**Interfaces:**
- Consumes: existing `InversionParams` (`base`, `d_max`, `print_exposure`, `paper_black`, `paper_grade`, `soft_clip`, `hdr`, `wb`). No signature change to `invert_d`.
- Produces: `invert_d` with new exposure→`eff_d_max` semantics. New module consts `EXPO_DMAX_K`, `EFF_DMAX_LO`, `EFF_DMAX_HI` (private to engine.rs).

- [ ] **Step 1: Write the failing tests** (append inside `mod tests`)

```rust
    #[test]
    fn lower_exposure_reseparates_blown_highlights() {
        // Heavily over-exposed Pro400H-style: two close, very dense (bright-scene)
        // probes the default render collapses near white. Lowering exposure must
        // pull them DOWN off white AND widen the gap between them (re-separate),
        // not merely dim a collapsed cluster (the old linear-gain "brightness" feel).
        let base = [1.0, 1.0, 1.0];
        let hi_a = [3.2e-3, 3.2e-3, 3.2e-3];
        let hi_b = [5.0e-3, 5.0e-3, 5.0e-3];
        let at = |ev: f32, neg: [f32; 3]| {
            let p = InversionParams {
                base, d_max: 1.5, print_exposure: 2f32.powf(ev), ..Default::default()
            };
            invert_d(neg, &p)[0]
        };
        let gap0 = (at(0.0, hi_a) - at(0.0, hi_b)).abs();
        let gap_dn = (at(-2.0, hi_a) - at(-2.0, hi_b)).abs();
        eprintln!(
            "OVER-EXPOSED HIGHLIGHT before/after: gap@EV0={gap0:.4} gap@EV-2={gap_dn:.4}  \
             a:{:.4}->{:.4}  b:{:.4}->{:.4}",
            at(0.0, hi_a), at(-2.0, hi_a), at(0.0, hi_b), at(-2.0, hi_b)
        );
        assert!(at(-2.0, hi_a) < at(0.0, hi_a), "lower EV must darken the highlight");
        assert!(gap_dn > gap0 * 2.0, "separation must widen: {gap0} -> {gap_dn}");
    }

    #[test]
    fn black_anchored_under_any_exposure() {
        // A pixel AT the film base is the deepest shadow → must invert to ~black for
        // ANY exposure, because eff_d_max only changes the slope about the black pivot.
        let base = [0.7, 0.6, 0.5];
        for ev in [-3.0f32, 0.0, 3.0] {
            let p = InversionParams { base, print_exposure: 2f32.powf(ev), ..Default::default() };
            let out = invert_d(base, &p);
            for &v in &out { assert!(v.abs() < 1e-4, "base must be black at EV {ev}: {out:?}"); }
        }
    }

    #[test]
    fn eff_dmax_clamped_no_blowup() {
        // Extreme exposure is bounded by the clamp band — finite, in-range, no NaN.
        let base = [1.0, 1.0, 1.0];
        for ev in [-20.0f32, 20.0] {
            let p = InversionParams { base, print_exposure: 2f32.powf(ev), ..Default::default() };
            let out = invert_d([0.01, 0.01, 0.01], &p);
            for &v in &out { assert!(v.is_finite() && (0.0..=1.0001).contains(&v), "EV {ev}: {v}"); }
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd crates/film-core && cargo test lower_exposure_reseparates black_anchored eff_dmax_clamped`
Expected: COMPILE-PASS but `lower_exposure_reseparates_blown_highlights` FAILS (`separation must widen` — current linear gain keeps gap ~constant); the other two likely pass already. (If it won't compile, the consts in Step 3 aren't needed to compile the test — proceed.)

- [ ] **Step 3: Add coupling constants** after `engine.rs:73` (`const HDR_HEADROOM`)

```rust
/// Exposure → effective-d_max coupling. EV stops scale d_max by `2^(-K·EV)`:
/// lower EV → larger eff_d_max → flatter highlight slope (blown highlights
/// re-separate); EV=0 → identity. Mirrored verbatim in shaders.ts (INVERT_FRAG).
const EXPO_DMAX_K: f32 = 0.5;
const EFF_DMAX_LO: f32 = 0.5;
const EFF_DMAX_HI: f32 = 6.0;
```

- [ ] **Step 4: Rewrite the `invert_d` negative branch** — replace `engine.rs:104-137` (from `const THRESHOLD` through the closing `})` of `from_fn`) with:

```rust
    const THRESHOLD: f32 = 2.328_306_4e-10; // negadoctor's -32 EV floor
    // Exposure acts in the DENSITY domain, not as a linear print gain: EV stops
    // modulate the effective d_max about the black pivot. Lowering EV raises
    // eff_d_max → flatter highlight slope → blown highlights re-separate (I1);
    // EV=0 (print_exposure=1) → eff_d_max==d_max → byte-identical to before.
    let ev = p.print_exposure.max(EPS).log2();
    let eff_d_max =
        (p.d_max * 2f32.powf(-EXPO_DMAX_K * ev)).clamp(EFF_DMAX_LO, EFF_DMAX_HI);
    std::array::from_fn(|c| {
        let clamped = rgb[c].max(THRESHOLD);
        let dmin = p.base[c].max(EPS);
        let log_dens = (clamped / dmin).log10(); // = -log10(dmin/clamped)
        let corrected = log_dens / eff_d_max.max(EPS);
        let ten_to_x = 10f32.powf(corrected);
        // Linear print_exposure gain is DROPPED (folded into eff_d_max above) so the
        // white anchor stays put and exposure redistributes — not scales — highlights.
        let print_lin = ((1.0 + p.paper_black) - ten_to_x).max(0.0);
        // WB as a linear gain on the print; keeps black neutral (0·wb = 0).
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
            // Reciprocal (Reinhard-style) highlight rolloff. Matches the lower
            // branch's value AND slope at the knee, so nothing at or below
            // soft_clip changes — but it has a far longer tail than the old
            // exponential, so distinct bright highlights keep their separation
            // instead of all slamming to ~1.0. That preserved separation is the
            // latitude the Develop Highlights/Contrast sliders can then pull back.
            let comp = (1.0 - p.soft_clip).max(EPS);
            let u = (out - p.soft_clip) / comp;
            1.0 - comp / (1.0 + u)
        } else {
            out
        }
    })
```

- [ ] **Step 5: Refresh the comment on the existing `highlight_rolloff_retains_separation` test** — it still passes, but its rationale wording is stale. Edit `engine.rs:295-300`, replacing the doc comment lines (keep all `assert!`s and the `print_exposure: 2.0` param **unchanged**) with:

```rust
        // Raise exposure (print_exposure 2.0): eff_d_max shrinks, so highlights move
        // toward white but the SDR rolloff still keeps them *below* white with a
        // visible gap between distinct luminances — latitude survives into Develop.
```

- [ ] **Step 6: Run the full engine test suite**

Run: `cd crates/film-core && cargo test --lib -- --nocapture 2>&1 | tail -30`
Expected: PASS — including the new three (note the printed `OVER-EXPOSED HIGHLIGHT before/after` line) and all pre-existing tests (`positive_false_matches_today`, `mode_d_*`, `highlight_rolloff_*`, etc.) unchanged.

- [ ] **Step 7: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): exposure drives effective d_max, re-separating blown highlights (I1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: GL parity — mirror in `shaders.ts` INVERT_FRAG (mode D)

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts:232-233` (add GLSL consts near `EPS`/`LOG10`)
- Modify: `app/src/lib/viewport/gl/shaders.ts:246-267` (mode D branch)

**Interfaces:**
- Consumes: existing uniforms `u_d_max`, `u_print_exposure`, `u_paper_black`, `u_paper_grade`, `u_soft_clip`, `u_wb`, `u_base`. No new uniforms.
- Produces: shader mode-D output numerically matching `invert_d` (Task 1).

- [ ] **Step 1: Add GLSL coupling constants** after `shaders.ts:233` (`const float LOG10 = ...;`)

```glsl
// Exposure → eff_d_max coupling — MUST equal engine.rs EXPO_DMAX_K/EFF_DMAX_LO/HI.
const float EXPO_DMAX_K = 0.5;
const float EFF_DMAX_LO = 0.5;
const float EFF_DMAX_HI = 6.0;
```

- [ ] **Step 2: Rewrite the mode-D body** — replace `shaders.ts:255-259` (the `corrected`/`ten`/`print_lin`/`outc` lines) with:

```glsl
    // Exposure acts in the density domain: EV stops modulate eff_d_max about the
    // black pivot (mirrors engine.rs invert_d). EV=0 → eff_d_max==u_d_max.
    float ev = log2(max(u_print_exposure, EPS));
    float eff_d_max = clamp(u_d_max * exp2(-EXPO_DMAX_K * ev), EFF_DMAX_LO, EFF_DMAX_HI);
    vec3 corrected = log_dens / max(eff_d_max, EPS);
    vec3 ten = exp2(corrected / LOG10);                    // 10^corrected
    // Linear print_exposure gain DROPPED (folded into eff_d_max); white anchor fixed.
    vec3 print_lin = max(vec3(1.0 + u_paper_black) - ten, vec3(0.0));
    vec3 outc = pow(print_lin * u_wb, vec3(u_paper_grade)); // WB as a linear gain; 0*wb=0 keeps black neutral
```

(Leave the surrounding `log_dens` line above and the soft-clip block below `shaders.ts:260-267` unchanged.)

- [ ] **Step 3: Verify it builds**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5 && npm run build 2>&1 | tail -8`
Expected: type-check + Vite build succeed (GLSL is a template string, so this confirms no JS/TS breakage; numeric parity is enforced by the identical formula + Task 3).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts
git commit -m "feat(gl): mirror density-domain exposure / eff_d_max in INVERT_FRAG (I1 parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Extend the engine parity test (engine.rs:167-195)

**Files:**
- Modify: `crates/film-core/src/engine.rs:165-194` (`invert_image_is_per_pixel_and_order_preserving`)

**Interfaces:**
- Consumes: `invert_image`, `invert_d` (Task 1).
- Produces: per-pixel parity coverage that includes a non-default `print_exposure` (the new semantics path), so the parallel `invert_image` is pinned to the scalar `invert_d` under exposure.

- [ ] **Step 1: Extend the existing parity test** — replace the `let p = InversionParams { base: [...], ..Default::default() };` at `engine.rs:169-172` with a non-default exposure so the new `eff_d_max` path is exercised by the order-preservation guard:

```rust
        // Non-default print_exposure exercises the eff_d_max path so the parallel
        // invert_image stays pinned to the scalar invert_d under the new semantics.
        let p = InversionParams {
            base: [0.8, 0.6, 0.4],
            print_exposure: 2f32.powf(-1.5),
            ..Default::default()
        };
```

- [ ] **Step 2: Run the test**

Run: `cd crates/film-core && cargo test invert_image_is_per_pixel_and_order_preserving`
Expected: PASS (every pixel of `invert_image` equals `invert_d` under exposure −1.5).

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "test(engine): pin invert_image parity under non-default exposure (eff_d_max path)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: B3 — density-spread guard in calibrate

**Files:**
- Modify: `crates/film-core/src/calibrate.rs:227-259` (`sample_dmax` → delegate; add `sample_dmax_spread`)
- Test: `crates/film-core/src/calibrate.rs` test module (append)

**Interfaces:**
- Consumes: `Image`, `Rect`, `downscale_for_detect`, `scaled_rect`, `SAMPLE_CAP` (all already in calibrate.rs).
- Produces: `pub fn sample_dmax_spread(img: &Image, base: [f32;3], rect: Option<Rect>) -> (f32, f32)` returning `(d_max, density_spread)`; `pub fn sample_dmax(...) -> f32` delegating to `.0`.

- [ ] **Step 1: Write the failing test** (append to calibrate.rs test module)

```rust
    #[test]
    fn flat_crop_has_low_density_spread_ranged_has_high() {
        let base = [1.0, 1.0, 1.0];
        // No real blacks (the B3 trigger: crop into sky/highlights) → tiny spread.
        let flat = Image { width: 8, height: 8, pixels: vec![[0.85, 0.85, 0.85]; 64], ir: None };
        let (_d, spread) = sample_dmax_spread(&flat, base, None);
        assert!(spread < 0.1, "flat crop spread should be tiny: {spread}");
        // Spans blacks → brights → substantial density range.
        let mut px = vec![[0.9, 0.9, 0.9]; 32];
        px.extend(vec![[0.02, 0.02, 0.02]; 32]);
        let ranged = Image { width: 8, height: 8, pixels: px, ir: None };
        let (_d2, spread2) = sample_dmax_spread(&ranged, base, None);
        assert!(spread2 > 0.5, "ranged crop spread should be substantial: {spread2}");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd crates/film-core && cargo test flat_crop_has_low_density_spread`
Expected: FAIL to compile — `sample_dmax_spread` not found.

- [ ] **Step 3: Implement** — replace the body of `sample_dmax` (`calibrate.rs:232-259`) with a delegating wrapper plus the new function:

```rust
pub fn sample_dmax(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32 {
    sample_dmax_spread(img, base, rect).0
}

/// Like [`sample_dmax`] but also returns the crop's **density spread**: the max
/// across channels of `log10(i_high / i_low)` (99th vs 1st percentile transmission).
/// A flat crop (no real blacks — e.g. cropping into sky/highlights, the B3 trigger)
/// yields a tiny spread; callers use it to reject a range-destroying d_max estimate.
pub fn sample_dmax_spread(img: &Image, base: [f32; 3], rect: Option<Rect>) -> (f32, f32) {
    const LOW_PCT: f32 = 0.01; // 1st percentile transmission (densest neg)
    const HIGH_PCT: f32 = 0.99; // 99th percentile (brightest transmission = base-ish)
    let small = downscale_for_detect(img, SAMPLE_CAP);
    let r = scaled_rect(rect, img, &small);
    let mut chans: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for yy in r.y..(r.y + r.h).min(small.height) {
        for xx in r.x..(r.x + r.w).min(small.width) {
            let px = small.pixels[yy * small.width + xx];
            for c in 0..3 {
                chans[c].push(px[c]);
            }
        }
    }
    let mut d_max = 1.0f32;
    let mut spread = 0.0f32;
    for c in 0..3 {
        if chans[c].is_empty() || base[c] <= 1e-6 {
            continue;
        }
        chans[c].sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = chans[c].len();
        let lo = chans[c][((n as f32 * LOW_PCT) as usize).min(n - 1)].max(1e-5);
        let hi = chans[c][((n as f32 * HIGH_PCT) as usize).min(n - 1)].max(1e-5);
        d_max = d_max.max((base[c] / lo).log10());
        spread = spread.max((hi / lo).log10());
    }
    (d_max.clamp(1.0, 4.0), spread)
}
```

- [ ] **Step 4: Run the new test + the existing d_max tests**

Run: `cd crates/film-core && cargo test sample_dmax flat_crop_has_low_density 2>&1 | tail -20`
Expected: PASS — new spread test passes and the pre-existing `sample_dmax` clamp tests (floor 1.0 / ceil 4.0) still pass via the delegating wrapper.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(calibrate): sample_dmax_spread reports crop density range (B3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: B3 — apply the guard in `analyze()`

**Files:**
- Modify: `app/src-tauri/src/commands.rs:299-315` (`sample_dmax_oriented` → return `(f32, f32)`)
- Modify: `app/src-tauri/src/commands.rs:2139,2142` (flip-test callers take `.0`)
- Modify: `app/src-tauri/src/commands.rs:2036-2066` (`analyze` applies the guard)
- Add + Test: a pure `guard_dmax` helper near `effective_dmax` (`commands.rs:207-211`)

**Interfaces:**
- Consumes: `sample_dmax_spread` (Task 4), `effective_dmax`, `Developed.d_max`, `InvertParams.d_max_override`.
- Produces: `pub(crate) fn guard_dmax(estimate: f32, spread: f32, prior: f32) -> f32`; `analyze` returns the guarded `d_max`.

- [ ] **Step 1: Write the failing test** (append to the commands.rs `#[cfg(test)] mod tests`; if none exists in this file, add `#[cfg(test)] mod guard_tests { use super::*;` wrapping it)

```rust
    #[test]
    fn guard_dmax_keeps_prior_when_crop_is_flat() {
        // Flat crop (spread below MIN) → keep prior d_max, never destroy range (B3).
        assert_eq!(guard_dmax(1.05, 0.05, 2.4), 2.4, "flat crop must keep prior");
        // Real density range → accept the fresh estimate.
        assert_eq!(guard_dmax(1.8, 1.20, 2.4), 1.8, "ranged crop applies estimate");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app/src-tauri && cargo test guard_dmax_keeps_prior`
Expected: FAIL to compile — `guard_dmax` not found.

- [ ] **Step 3: Add the `guard_dmax` helper** after `effective_dmax` (`commands.rs:211`)

```rust
/// Decide the d_max to apply after a crop re-analysis (B3): a crop that lacks real
/// blacks (density `spread` below `MIN_SPREAD`) gives an unreliable, range-destroying
/// estimate, so keep `prior`; otherwise take the fresh `estimate`. Tuned so normal
/// frames clear the bar and a sky-/highlight-only crop does not.
pub(crate) fn guard_dmax(estimate: f32, spread: f32, prior: f32) -> f32 {
    const MIN_SPREAD: f32 = 0.35;
    if spread < MIN_SPREAD { prior } else { estimate }
}
```

- [ ] **Step 4: Change `sample_dmax_oriented` to return `(f32, f32)`** — edit `commands.rs:299-315`: change the return type `-> f32` to `-> (f32, f32)`, the `use` to `sample_dmax_spread`, and the final line `sample_dmax(&geom, base, rect)` to `sample_dmax_spread(&geom, base, rect)`.

- [ ] **Step 5: Update the two flip-test callers** at `commands.rs:2139` and `:2142` — append `.0` so they keep using just the d_max:

```rust
        let unflipped = sample_dmax_oriented(&img, base, left_half, 0, false, false, 0.0).0;
        // ... and:
        let flipped = sample_dmax_oriented(&img, base, left_half, 0, true, false, 0.0).0;
```

- [ ] **Step 6: Apply the guard in `analyze`** — replace the `Ok(Analysis { d_max: sample_dmax_oriented(...) })` block at `commands.rs:2055-2065` with:

```rust
    let prior = effective_dmax(&params, dev.d_max);
    let (estimate, spread) = sample_dmax_oriented(
        &dev.working,
        base,
        crop,
        rot90.unwrap_or(0),
        flip_h.unwrap_or(false),
        flip_v.unwrap_or(false),
        angle.unwrap_or(0.0),
    );
    Ok(Analysis {
        d_max: guard_dmax(estimate, spread, prior),
    })
```

- [ ] **Step 7: Run tests + build the backend**

Run: `cd app/src-tauri && cargo test guard_dmax 2>&1 | tail -10 && cargo build 2>&1 | tail -8`
Expected: `guard_dmax_keeps_prior_when_crop_is_flat` PASS; backend compiles (flip-test callers fixed).

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(analyze): density-spread guard keeps prior d_max on flat crops (B3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: B3 — one-click revert to pre-reanalyze state (UI)

**Files:**
- Modify: `app/src/lib/store.ts:198-199` (add `preReanalyze` store near `sampledDmax`)
- Modify: `app/src/lib/develop/Basic.svelte:4` (import `preReanalyze`), `:65` (clear on image change), `:139-151` (snapshot in `reanalyze`, add `revertReanalyze`), `:222` (Revert button)
- Modify: `/i18n-strings.csv` (add `base.revertReanalyze`) then regenerate

**Interfaces:**
- Consumes: `params`, `activeId`, `commitActive`, `whitePointPinned` (via `isPinned`/`setPinned`), `api.analyze`.
- Produces: `export const preReanalyze` store; `revertReanalyze()`; a conditional Revert button.

- [ ] **Step 1: Add the snapshot store** — after `app/src/lib/store.ts:199` (`whitePointPinned`):

```ts
// Pre-reanalyze snapshot: the d_max_override + pin state captured immediately
// before a crop re-analysis, so B3's re-analyze is always one-click revertible.
export const preReanalyze = writable<{ id: string; d_max_override: number | null; pinned: boolean } | null>(null);
```

- [ ] **Step 2: Import it in Basic.svelte** — add `preReanalyze` to the store import at `app/src/lib/develop/Basic.svelte:4`.

- [ ] **Step 3: Snapshot inside `reanalyze()` and add `revertReanalyze()`** — replace `reanalyze()` (`Basic.svelte:139-147`) with:

```ts
  async function reanalyze() {
    const id = get(activeId); if (!id) return;
    // Snapshot the pre-reanalyze state so this is always one-click revertible (B3).
    preReanalyze.set({ id, d_max_override: get(params).d_max_override ?? null, pinned: isPinned(id) });
    try {
      const { d_max } = await api.analyze(id, withEffectiveBase(get(params), dir), imageCrop, geom);
      params.update((p) => ({ ...p, d_max_override: d_max }));
      commitActive();
      autoWb();
    } catch { preReanalyze.set(null); /* not developed yet */ }
  }
  // Restore the d_max_override + pin captured before the last re-analyze (B3).
  function revertReanalyze() {
    const snap = get(preReanalyze); if (!snap) return;
    const id = get(activeId);
    if (id && id === snap.id) {
      setPinned(id, snap.pinned);
      params.update((p) => ({ ...p, d_max_override: snap.d_max_override }));
      commitActive();
    }
    preReanalyze.set(null);
  }
```

- [ ] **Step 4: Clear the snapshot on image change** — at `Basic.svelte:65`, add `preReanalyze.set(null);` to the existing active-image reset block:

```ts
  $: { $activeId; sampledBase.set(null); baseSampling.set(false); sampledDmax.set(null); preReanalyze.set(null); }
```

- [ ] **Step 5: Add the Revert button** — after the reanalyze button at `Basic.svelte:222`:

```svelte
        <button class="recal reanalyze" on:click={manualReanalyze}>{$t('base.reanalyze')}</button>
        {#if $preReanalyze && $preReanalyze.id === $activeId}
          <button class="recal revert" on:click={revertReanalyze}>{$t('base.revertReanalyze')}</button>
        {/if}
```

- [ ] **Step 6: Add the i18n string + regenerate**

Add a row to `/i18n-strings.csv` for key `base.revertReanalyze` (English e.g. `Revert re-analyze`, mirror the other languages' style; copy the Chinese from the feedback tone, e.g. `撤销重新分析`). Then:

Run: `cd /Users/mohaelder/Repos/filmrev && python3 scripts/gen-i18n.py && cd app && npx tsc --noEmit 2>&1 | tail -5`
Expected: `dict.ts` regenerated with the new key; type-check clean.

- [ ] **Step 7: Build the frontend**

Run: `cd app && npm run build 2>&1 | tail -8`
Expected: Vite build succeeds.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/develop/Basic.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): one-click revert to pre-reanalyze d_max state (B3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Whole-suite verification + before/after report

**Files:** none (verification only)

- [ ] **Step 1: Full Rust test suite**

Run: `cd /Users/mohaelder/Repos/filmrev && cargo test --workspace 2>&1 | tail -25`
Expected: all green.

- [ ] **Step 2: Capture the I1 before/after numbers**

Run: `cd crates/film-core && cargo test lower_exposure_reseparates_blown_highlights -- --nocapture 2>&1 | grep "OVER-EXPOSED"`
Expected: a line like `OVER-EXPOSED HIGHLIGHT before/after: gap@EV0=0.00xx gap@EV-2=0.0xx ...` — record it in the final report (gap should widen ~5–10× and both highlights drop off white).

- [ ] **Step 3: Frontend type-check + build**

Run: `cd app && npx tsc --noEmit 2>&1 | tail -5 && npm run build 2>&1 | tail -8`
Expected: clean.

- [ ] **Step 4: Confirm no soft-clip / B1 collision**

Run: `cd /Users/mohaelder/Repos/filmrev && git diff main --stat -- crates/film-core/src/engine.rs app/src/lib/viewport/gl/shaders.ts` and visually confirm the soft-clip block + `soft_clip`/`u_soft_clip` threshold are untouched (only the pre-soft-clip `print_lin`/`eff_d_max` lines changed).

---

## Self-Review

**Spec coverage:**
- §2a (exposure → eff_d_max, Rust) → Task 1 ✓
- §2b (GL parity) → Task 2 ✓
- §2c (extend parity test 167-195; revisit highlight_rolloff) → Task 3 + Task 1 Step 5 ✓
- §2d (spread guard + revert) → Tasks 4, 5 (guard) + Task 6 (revert) ✓
- §3 acceptance (I1 re-separation numbers, B3 never-worse + revert, EV=0 identity, CPU/GL parity) → Tasks 1/3/7 ✓
- "no new uniforms" → Task 2 uses existing `u_print_exposure` ✓
- B1 non-collision → Task 7 Step 4 ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; commands have expected output. The one judgement call (i18n translations in Task 6 Step 6) names the key, English string, and a Chinese example — acceptable as it follows the existing CSV pattern.

**Type consistency:** `sample_dmax_spread -> (f32,f32)` (Task 4) consumed as `(estimate, spread)` (Task 5) ✓; `guard_dmax(estimate, spread, prior)` signature matches its test + call site ✓; `sample_dmax_oriented -> (f32,f32)` with `.0` at the flip-test callers ✓; `preReanalyze` shape `{id, d_max_override, pinned}` identical in store + snapshot + revert ✓; constants `EXPO_DMAX_K/EFF_DMAX_LO/EFF_DMAX_HI` identical in engine.rs + shaders.ts ✓.
```
