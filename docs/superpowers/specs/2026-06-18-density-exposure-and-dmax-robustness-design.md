# Density-domain exposure + d_max robustness (B3 + I1)

**Date:** 2026-06-18
**Owns:** B3 ("re-analyze for crop crushes highlights") and I1 ("exposure isn't perceptually
linear; can't recover over-exposed-negative highlights") — co-owned because both are governed
by the same `d_max` + soft-clip math in `crates/film-core/src/engine.rs`.

**Coordinates with:** B1 (clip detection, told to stay additive). This change does **not** touch
the Reinhard soft-clip curve or the `soft_clip` threshold — B1's detection reads those unchanged.

---

## 1. Problem & the governing math

Per-channel negative transfer (`invert_d`, pb = paper_black, grade = paper_grade):

```
log_dens  = log10(I / base)                 ≤ 0     (bright scene = dense neg = very negative)
corrected = log_dens / d_max                ≤ 0
ten       = 10^corrected                     ∈ (0,1] (1 at base/shadow, →0 at brightest)
print_lin = print_exposure·(1+pb) − print_exposure·ten
out       = (print_lin · wb)^grade           then Reinhard soft-clip where out > soft_clip
```

with `print_exposure = 2^EV` (the Exposure slider).

**Why I1 happens.** Highlights of an over-exposed negative sit on the *flat tail* of
`10^(log_dens/d_max)`: `ten ≈ 0`, so they collapse to `print_lin ≈ print_exposure` **before**
`print_exposure` is applied. Since `print_exposure` is a *linear* gain, lowering it scales the
already-collapsed cluster down uniformly → dimmer + grayer, never re-separated. That is the
"brightness slider" feel.

**The mathematical truth (verified numerically).** Black must stay anchored (a pixel at base →
`ten=1` → `print_lin=0`) and `ten` must stay ≤ 1 (else `print_lin<0` clips midtones to black).
The only adjustment that re-separates blown highlights under those constraints is a **scale of
`log_dens` about the black pivot**, i.e. a change to the *effective `d_max`* (the slope):

```
d(out)/d(log_dens) ∝ (1/d_max)·10^(log_dens/d_max)
```

At the highlight tail the exponential dominates, so **raising `d_max` increases highlight
separation and pulls highlights down off white; lowering `d_max` crushes them.** A flat density
*offset* (the naive "add exposure to the negative pre-invert", à la Capture One) pushes midtones
past `ten=1` and crushes them to black — confirmed numerically, rejected.

**Why B3 is the same bug.** `analyze()` → `sample_dmax()` derives `d_max` from the 1st-percentile
transmission inside the crop. A crop lacking deep negative density (sky/highlights, or an
over-exposed frame) *lowers* the estimate → smaller `d_max` → highlights crush, exactly the curve
above going the wrong way. So I1's recovery lever and B3's regression are **one knob: effective
`d_max`.**

---

## 2. Design

### 2a. Engine: exposure drives effective `d_max` (black-anchored)  — I1

Replace `print_exposure` as a linear gain on the negative print with an **effective-`d_max`
modulation**, derived from the same EV the slider already produces. No new params, no new uniforms.

```
EV         = log2(print_exposure)                         // 0 at default → identical
eff_d_max  = clamp(d_max · 2^(−K_EXPO · EV), D_LO, D_HI)
corrected  = log_dens / max(eff_d_max, EPS)
ten        = 10^corrected
print_lin  = (1 + paper_black) − ten                      // linear print_exposure multiply DROPPED
out        = (print_lin · wb)^grade                       // soft-clip unchanged
```

Behavior:

| EV move | eff_d_max | result |
|---|---|---|
| EV = 0 (default) | `= d_max` | **byte-identical to today** (`print_exposure=1`, `print_lin = 1·(1+pb) − 1·ten`) |
| EV ↓ (lower exposure) | ↑ | flatter highlight slope → blown highlights **re-separate** + image darkens (filmic) |
| EV ↑ (raise exposure) | ↓ | steeper → brighter, highlights compress toward white |

- **Black stays anchored** for any EV: `log_dens=0 → ten=1 → print_lin=0`.
- **Brightest specular pins at white** for any EV (`ten→0 → print_lin→1+pb`); exposure
  *redistributes* rather than setting an absolute ceiling — this is the EV-control feel.
- **Tuning (TDD):** start `K_EXPO ≈ 0.5` (EV −2 → `d_max ×2`, the value that cleanly recovered the
  worked example), `D_LO ≈ 0.5`, `D_HI ≈ 6.0`. Finalize against assertions, not by eye.
- The Exposure slider range in `Basic.svelte` may need widening so the recovery span is reachable;
  decide during implementation against `K_EXPO`.

**Back-compat (accepted):** saved edits with non-zero exposure re-render with the new (filmic)
response. EV = 0 edits are unchanged.

**Positive path unchanged.** `develop_positive_px` keeps `print_exposure` as a linear gain
(positive sources have no density domain).

### 2b. GL parity — `app/src/lib/viewport/gl/shaders.ts` INVERT_FRAG (mode D)

Mirror exactly. `u_print_exposure` is already a uniform — derive `EV = log2(u_print_exposure)`,
compute `eff_d_max`, drop the `u_print_exposure *` from `print_lin`. Positive branch unchanged.
Constants `K_EXPO`, `D_LO`, `D_HI` duplicated as GLSL consts (kept in sync with Rust by the parity
discipline; documented as the source-of-truth pairing).

### 2c. Parity test — extend `crates/film-core/src/engine.rs:167-195`

The existing test only covers per-pixel order. Add CPU-side assertions that pin the new semantics
(GL mirrors the same formula by construction; parity is enforced by review + identical constants):

1. **EV=0 identity:** `print_exposure=1` output equals the pre-change formula on several probes
   (guards the "default unchanged" contract). Existing default-based tests already cover this and
   must still pass untouched.
2. **Lower exposure re-separates blown highlights:** on a synthetic over-exposed probe (two close,
   very-negative `log_dens` highlights), lowering EV *increases* the output gap between them and
   lowers both — the I1 acceptance, asserted in numbers.
3. **Black anchored under any EV:** base pixel → ~0 for EV ∈ {−3, 0, +3}.
4. **eff_d_max clamp:** extreme EV is bounded by `D_LO`/`D_HI` (no NaN/blowup).
5. Revisit `highlight_rolloff_retains_separation` (uses `print_exposure=2.0`) — update its
   expectations to the new semantics rather than deleting the coverage.

### 2d. B3 robustness — spread guard + revert

**Engine/calibrate (`calibrate.rs` `sample_dmax`, `commands.rs` `analyze`):** before overriding,
measure the crop's density spread (e.g. `log10(base/i_low) − log10(base/i_high)` per channel, max
across channels, on the same downscaled proxy). If the spread is below `MIN_SPREAD` (crop too flat
to estimate a real density range — the exact B3 trigger), **do not override**: return the prior
`d_max` (`effective_dmax(&params, dev.d_max)`) so re-analysis can never *destroy* range. `analyze`
gains access to the prior via `dev.d_max` + `params.d_max_override` (both already in scope).
`MIN_SPREAD` tuned by TDD (normal frames clear it; a sky/highlight-only crop does not).

**UI (`app/src/lib/develop/Basic.svelte`):** `reanalyze()` snapshots the pre-reanalyze
`d_max_override` (and pin state) before applying, into a small store. Surface a **one-click
"Revert"** that restores the snapshot via `commitActive()` (lands in the normal undo scope). The
revert is always offered after any re-analyze (manual or crop-triggered), satisfying "there's
always a one-click revert to the pre-reanalyze state". Combined with the engine change, even an
accepted bad `d_max` is now recoverable by lowering exposure.

---

## 3. Acceptance

- **I1:** on a heavily-over-exposed Pro400H frame, lowering Exposure visibly **re-separates** blown
  highlights (gap grows) instead of graying them; Exposure feels like an EV control. Report
  before/after numbers on an over-exposed probe.
- **B3:** re-analyzing a normal frame never makes it worse; cropping into an all-highlight region
  does not collapse the tone scale (spread guard keeps prior `d_max`); a one-click revert to the
  pre-reanalyze state is always available.
- EV=0 default render is byte-identical; existing engine tests pass unchanged.
- CPU (`engine.rs`) and GL (`shaders.ts`) stay identical; parity test extended and green.

## 4. Out of scope

- Soft-clip curve / `soft_clip` threshold changes (B1 owns clip detection additively — untouched).
- WB / CMY grading (B4, R1). Auto-WB still re-runs after `d_max` changes via the existing hook.
- Tiled loading, texture, curve-editor (other tasks).
```
