# Faithful highlight / shadow recovery (意见1)

**Date:** 2026-06-23
**Status:** Design — pending implementation plan
**Path scope:** Faithful tone path only (the sole develop path; Filmic dormant)

## Problem

The Basic tone tools (Contrast, Highlights, Shadows, Whites, Blacks) run in the
**finish pass**, which operates on data the **inversion pass has already clamped to
`[0,1]`**. Highlight/shadow detail is compressed and clipped *inside the engine*,
before any of those sliders see it. So lowering Highlights / Whites / Contrast cannot
"reopen" blown whites — the distinct bright densities were already collapsed.

Pipeline today (CPU `engine.rs` mirrored by GPU `shaders.ts`, two separate passes):

```
INVERT pass (invert_d / INVERT_FRAG):
  d = log10(base/scan)              # raw density ≥ 0
  l = 10^d − 1                      # linear scene light
  lit = l · 2^(EXPO_K·EV)           # exposure (linear-light gain)
  t_eff = log10(lit+1) · FAITHFUL_SCALE
  core = gamma_shoulder(t_eff, 1.0) · wb     # ← shoulder asymptotes to 1.0: highlights crushed
  v = look_s(core)                            # ← tanh S, CLAMPED [0,1]
  → output [0,1] texture
FINISH pass (finish_pixel / finishAt):
  v.clamp(0,1) → tone_curve(contrast/hi/sh/whites/blacks) → saturation → LUT → grade
```

`gamma_shoulder` (engine.rs:211) bends everything above the knee asymptotically toward
`1.0`; `look_s` (engine.rs:146) then clamps. Two distinct highlight densities both
land at ~1.0 *in the engine*. The finish sliders only remap what survives in `[0,1]`.
(The finish-pass smoothstep highlight/shadow weights at finish.rs:514–515 were already
widened to reach the extremes for exactly this complaint — but they can't recover what
the engine already destroyed.)

The HDR path already demonstrates the fix in miniature: it raises the ceiling to
`HDR_HEADROOM = 2.5` and *expands* highlights above the knee instead of crushing them
(engine.rs:317–326). We want that recovery available in SDR, driven by the existing
sliders.

## Goal

Make **lowering Highlights** genuinely recover clipped *white* detail, and **lowering
Shadows** genuinely recover crushed *black* detail — by doing the recovery in the
**inversion pass, before the shoulder/toe compression and the clamp**, not in finish.

## Decisions (from brainstorming)

- **Approach A — engine-side recovery, clamp only at the end of the inversion pass.**
  Recovery happens inside `invert_d` / `INVERT_FRAG` (pre-clamp). The finish pass and
  its `[0,1]` assumptions (LUT sampling, OKLab gamut compression) are **untouched**.
- **Driven by the existing sliders' negative direction** — no new UI:
  - `hi_recovery = max(0, −highlights)  ∈ [0,1]`
  - `lo_recovery = max(0, −shadows)     ∈ [0,1]`
- **Both ends** (highlights + shadows).
- **Per-direction meaning** (no double-action): the *negative* half of Highlights /
  Shadows drives **engine recovery**; in that negative range the finish-pass
  highlight/shadow weight for that slider is **suppressed**. The *positive* half is
  unchanged finish behavior (`hi_recovery = lo_recovery = 0`). One clear meaning per
  direction; recovery and the old cosmetic pull never stack.

## Architecture

### Data flow

The inversion pass currently does not receive the Highlights/Shadows values (they live
in `FinishParams`, applied in the finish pass). We thread two derived scalars into the
inversion pass:

1. `InversionParams` gains `hi_recovery: f32` and `lo_recovery: f32` (both default
   `0.0` → exact current behavior).
2. `INVERT_FRAG` gains `uniform float u_hi_recovery, u_lo_recovery;`.
3. The develop orchestration (wherever the engine + finish params are built from UI
   state) derives `hi_recovery`/`lo_recovery` from the finish `highlights`/`shadows`
   sliders, sets them on the inversion params/uniforms, and zeroes the finish-side
   negative-half weight for those two sliders.

### Recovery math (Faithful core, applied per channel before the clamp)

Two mechanisms, each targeting the actual compressor for its end. Both are **identity
at recovery = 0** (pixel-exact to today) and **gamut-safe** (output stays in `[0,1]`;
no headroom carried into finish).

**Highlight recovery — widen the shoulder rolloff.** The asymptotic shoulder
(engine.rs:218) is currently
`s(raw) = k + (1−k)·(1 − exp(−(raw−k)/(1−k)))`.
Replace the rolloff scale with a recovery-widened one:
`scale_h = (1−k)·(1 + REC_H_GAIN · hi_recovery)`,
`s(raw) = k + (1−k)·(1 − exp(−(raw−k)/scale_h))`.
The asymptote stays `1.0` (coefficient `(1−k)` unchanged), so output never leaves
`[0,1]`; a gentler rolloff just maps the brightest finite densities further below
`1.0`, re-separating what was a flat white plateau.

**Shadow recovery — soften the look_s toe.** The Faithful core body (`raw ≤ knee`) is a
gamma `< 1` power that *lifts* shadows (no crush); the shadow compression is
`look_s`'s tanh toe. Generalize `look_s` to an asymmetric S with independent toe/shoulder
strength, and reduce the toe strength by `lo_recovery`:
toe slope `K_toe = LOOK_K·(1 − REC_S_GAIN · lo_recovery)`, shoulder strength unchanged.
At `lo_recovery = 0`, `K_toe = LOOK_K` → identity. A softer toe re-separates crushed
darks without lifting black off `0`.

`REC_H_GAIN` / `REC_S_GAIN` are visual-tuning constants (see [[faithful-exposure-hue-stable]]
— Faithful tone is an aesthetic target, tuned by eye on real frames, not a formula).

### Hue stability (hard constraint)

A neutral highlight must stay neutral, and a neutral shadow must stay neutral, at every
recovery setting. Per-channel shoulder/toe tweaks risk a highlight color cast (the same
failure class that sank the per-channel exposure rework, [[faithful-exposure-hue-stable]]).
Mitigation: drive each per-channel remap from the **post-WB neutral reference** (the
recovery amount/threshold is computed so equal-luma neutral channels receive an equal
remap), so neutrals stay neutral. The acceptance test below enforces this; if a simple
per-channel form fails it, fall back to a luminance-referenced compression (tone-map on
luma, preserve chroma ratios) inside the inversion pass.

### CPU/GPU parity

`engine.rs` and `shaders.ts` INVERT_FRAG must stay verbatim mirrors (the repo's standing
invariant). Both `gamma_shoulder` and `look_s` are duplicated in both files and both get
the recovery parameters and identical math.

## Components

1. **`crates/film-core/src/engine.rs`** — add `hi_recovery`/`lo_recovery` to
   `InversionParams` (+ `Default`); widen `gamma_shoulder` shoulder scale by
   `hi_recovery`; generalize `look_s` toe by `lo_recovery`; wire both into the Faithful
   branch of `invert_d`. SDR only (HDR path already expands highlights).
2. **`app/src/lib/viewport/gl/shaders.ts`** — `u_hi_recovery`/`u_lo_recovery` uniforms;
   mirror the `gamma_shoulder`/`look_s` changes in INVERT_FRAG; set the uniforms where
   the other invert uniforms are set.
3. **Develop orchestration** (TS state → engine/uniform params) — derive
   `hi_recovery = max(0,−highlights)`, `lo_recovery = max(0,−shadows)`; set on inversion
   params; suppress the finish-side negative-half weight for Highlights/Shadows.

## Testing

- **Identity at 0:** `hi_recovery = lo_recovery = 0` ⇒ `invert_d` output is pixel-exact
  to current `invert_d` over a representative density sweep (regression guard — the
  current look must not move).
- **Monotonic:** output stays monotonic in input density for the full recovery range
  (no folds/inversions).
- **Recovery works:** for a synthetic blown-highlight density sweep, increasing
  `hi_recovery` strictly increases the output spread (variance) in the highlight region
  vs. the clamped baseline; symmetric test for `lo_recovery` in shadows.
- **Hue stability:** a neutral (gray-ramp) highlight and a neutral shadow keep
  ΔHue ≈ 0 (within tolerance) across the full recovery range.
- **Gamut-safe:** output stays within `[0,1]` for all inputs and recovery settings.
- **CPU/GPU parity:** pin a few `(density, recovery)` samples and assert `engine.rs`
  and the GLSL produce the same values (extend the existing pinned-value tests, e.g.
  `look_s_anchors_and_pins`).
- **Manual GUI smoke:** on a real over-exposed frame, dragging Highlights negative
  visibly reopens blown sky/specular detail; dragging Shadows negative reopens crushed
  blacks; positive direction unchanged.

## Out of scope

- Filmic path (dormant).
- Whites/Blacks/Contrast as recovery drivers (Highlights/Shadows only this round).
- Carrying super-white headroom through the finish pass (rejected approach B —
  invasive, breaks finish's `[0,1]` assumptions).
- HDR rendition (already expands highlights via `HDR_HEADROOM`).
