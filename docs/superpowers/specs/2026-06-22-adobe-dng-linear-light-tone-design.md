# Linear-Light Exposure ("expose the negative like a TIFF") — Design

**Date:** 2026-06-22
**Status:** Implemented
**Scope:** Change the develop engine's **exposure** to a true linear-light gain, applied to
the reconstructed scene **before** the contrast curve. The inversion/tone core
(`gamma_shoulder` + `look_s`) is unchanged. Supersedes the exposure behaviour in
`2026-06-21-faithful-look-layer-sole-path-design.md`.

## Goal

Make the exposure slider behave photographically (like adjusting exposure on a positive /
TIFF in Lightroom) instead of the old behaviour, which **multiplied log-density by 2^EV** — a
contrast/gamma change, not an exposure. A scanned negative, once you compute
`d = log10(base/scan)`, **is already a log-inverted positive**: it can be exposed exactly like
any positive image — gain the linear scene by `2^EV`, then render.

## Context & the failed first attempt

A first pass replaced the *whole* tone path with Adobe's DNG `dng_function_exposure_tone`
(`2^EV` gain + quadratic shoulder, white pinned at 1) on a from-scratch density→linear
reconstruction with a fixed white anchor. That **clipped everywhere** (any density above the
fixed anchor hard-pinned to white) and discarded the calibrated `gamma_shoulder` rolloff — it
replaced the part that worked instead of just the exposure. Reverted.

The correction (user's framing): keep the calibrated positive render; apply exposure as a
**linear-light gain before the contrast curve**, and let the existing `gamma_shoulder` soft
shoulder do the highlight rolloff (no separate Adobe shoulder — that would double-roll-off and
is what caused the clipping).

## The change (per channel, `invert_d` Faithful arm ⇄ shaders.ts INVERT_FRAG)

```
d   = log10(base/scan)                 // density (unchanged); d = 0 at the film base = scene black
L   = 10^d − 1                         // BLACK-ANCHORED linear scene: d = 0 → L = 0
L'  = L · 2^(FAITHFUL_EXPO_K · EV)     // linear-light exposure gain (FAITHFUL_EXPO_K = 1.0 = 1 stop/EV)
d'  = log10(L' + 1)                    // back to density
t   = d' · FAITHFUL_SCALE              // fixed density scale (unchanged)
core = gamma_shoulder(t) [· wb | wb pre-curve for subtractive]   // unchanged contrast + soft shoulder
v    = look_s(core)   (SDR)  |  core  (HDR)                       // unchanged
```

Why this is correct:
- **`d' = d` at EV 0** (the `−1`/`+1` cancel), so the EV-0 render is **byte-identical** to the
  prior calibrated look. Only `EV ≠ 0` changes.
- **Linear gain, not density multiply.** `×2^EV` in linear = a proper exposure. The old
  `d·2^EV` stretched the log range around 0 (contrast).
- **Black pivots.** `L = 10^d − 1` puts scene black at `L = 0`, so `0·2^EV = 0` — black stays
  pure neutral black at every EV (no shadow lift/crush, no "yellow shadow" under WB).
- **No clipping.** Highlights ride up `gamma_shoulder`'s existing soft shoulder, which
  asymptotes to white — they roll off gracefully instead of hard-clamping.

WB, the look layer, HDR, auto-exposure, and the finish stage are all untouched.

## CPU/GPU parity

- CPU `(lit + 1.0).log10()` ⇄ GPU `log2(lit + 1.0) * LOG10` (`LOG10 = 1/log2(10)`, the existing
  shader constant) — identical within float precision, matching the existing `d` computation.
- CPU `10f32.powf(d)` ⇄ GPU `pow(vec3(10.0), d)`.
- No new constants; `FAITHFUL_EXPO_K`/`FAITHFUL_SCALE` reused, both already `MUST equal`-pinned.

## Catalog refresh

`ENGINE_VERSION 3 → 4` — edits with `exposure ≠ 0` re-render through the new gain (EV-0 edits are
identical). Existing thumbnails regenerate via the usual `thumb_stale` mechanism. No serde
migration (`tone_mode` stays force-Faithful).

## Reversibility

`git revert` restores the density-multiply exposure; the diff is two small arm bodies plus one
test (no constants added/removed, no dead code).

## Files changed

- `crates/film-core/src/engine.rs` — `ToneMode::Faithful` arm exposure (3 lines) + a new test
  `faithful_exposure_is_linear_gain_pivoting_black`.
- `app/src/lib/viewport/gl/shaders.ts` — mirrored faithful branch of `INVERT_FRAG`.
- `crates/film-core/src/lib.rs` — `ENGINE_VERSION 3 → 4`.
- `app/src/lib/viewport/gl/invert.test.ts` — fixtures get `wb_mode`/`tone_mode` (also fixes a
  pre-existing type error).

## Testing

- `faithful_exposure_is_linear_gain_pivoting_black`: +EV brightens / −EV darkens a midtone;
  scene black pivots at black at every EV.
- All restored exposure invariants pass: `faithful_exposure_is_photographic_strength`,
  `faithful_highlight_does_not_blow_at_default_d_max`, `faithful_is_independent_of_per_frame_d_max`,
  `exposure_does_not_shift_white_balance`, `black_anchored_under_any_exposure`,
  `lower_exposure_reseparates_blown_highlights`, `extreme_exposure_no_blowup` — `157` film-core
  tests; `312` frontend tests; typecheck clean.

## Calibration knobs / follow-ups

- `FAITHFUL_EXPO_K` (per-stop sensitivity; 1.0 = photographic) is the one feel knob.
- The contrast/look (`gamma_shoulder`, `look_s`, `FAITHFUL_SCALE`) is the prior calibration —
  untouched here; tune separately if desired.
- Re-confirm auto-exposure lands inside ±3 EV on real scans (the EV response is now a clean
  linear gain, so the secant solver's linear seed should be more accurate, not less).
