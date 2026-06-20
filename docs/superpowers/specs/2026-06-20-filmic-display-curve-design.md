# Filmic display S-curve for the inversion engine

**Date:** 2026-06-20
**Status:** Approved, ready for implementation

## Problem

Users report the default look as 颜色淡 (pale/washed out), 影调过渡很硬 (hard tonal
transitions), and frequent loss of highlight and shadow detail. The cause is
structural in the Cineon/negadoctor display encode (`invert_d` in
`crates/film-core/src/engine.rs`, mirrored in `INVERT_FRAG` of
`app/src/lib/viewport/gl/shaders.ts`):

```
print_lin = (1 + paper_black) − 10^(−d/eff_d_max)   // d = negative density, ≥ 0
out       = (print_lin · wb)^paper_grade            // paper_grade ≈ 0.95
soft_clip rolloff above 0.9
```

Two structural flaws:

1. **White is capped at ~0.90.** At the densest negative (`d == eff_d_max`),
   `10^(−d/eff_d_max) = 0.1` *always*, so `print_lin = 0.90` regardless of
   `d_max`. With `d_max` auto-fit to the densest percentile, every image's
   brightest pixel lands at ~0.90 — there is no true white → flat/pale.
2. **Pure shoulder, no toe.** `1 − 10^(−x)` is a saturating exponential. Local
   gamma (contrast) measured across the range: ~2.3 in deep shadows (hard
   crush), ~0.5 in mids (flat), collapsing to ~0.06 in highlights (all bright
   tones jam together → lost separation). It is only the *shoulder* half of a
   film curve.

In darktable, negadoctor's density correction is followed by filmic's display
S-curve. filmrev shows the raw negadoctor output directly — the display
tone-rendering is missing.

## Approach

Add a **fixed internal filmic display S-curve** (no new UI). Keep the negadoctor
**density restoration** unchanged (base normalize → `log10` → `eff_d_max`
exposure coupling → THRESHOLD clamp). **Replace only** the paper→display encode
(`print_lin`, `^paper_grade`, `soft_clip`) with a filmic S-curve applied in the
**normalized log-density domain**, which is linear in scene stops — the correct
domain for a tone curve (operating on the already-compressed `print_lin` would
double-compress the shoulder).

### Per-channel math (replaces the paper encode)

```
t   = (d / eff_d_max) · wb[c]                 // normalized log-exposure; ·wb is a
                                              // log-domain SCALE, so t=0 → 0 and
                                              // black stays neutral
t   = max(t, 0.0)
out = filmicS(t)
```

### The curve

A logistic in normalized log-density, rescaled to exact anchors:

```
L(x)       = 1 / (1 + exp(−FILMIC_K · (x − FILMIC_PIVOT)))
filmicS(t) = clamp( (L(t) − L(0)) / (L(FILMIC_WHITE_T) − L(0)), 0, 1 )
```

Starting constants (final values tuned against real scans during
implementation, verified by the gamma-distribution test):

- `FILMIC_K = 5.0` — contrast / slope.
- `FILMIC_PIVOT = 0.5` — pivot (max-slope point) in normalized density.
- `FILMIC_WHITE_T = 1.05` — density (relative to `eff_d_max`) that maps to 1.0;
  slightly > 1 so the densest-percentile anchor renders ~0.97–1.0 with a touch of
  shoulder headroom above it.

Properties: `filmicS(0) = 0` exactly (neutral black), monotonic, gentle toe
(abs slope < 1 near black → shadow detail preserved), mid slope ~1 (punch),
gentle shoulder to true white (highlight separation). Single formula using only
`exp` — identical in Rust and GLSL.

### Parity contract

`FILMIC_K`, `FILMIC_PIVOT`, `FILMIC_WHITE_T` become shared constants defined in
both `engine.rs` and `shaders.ts` (`INVERT_FRAG`), exactly like the existing
`EXPO_DMAX_K` / `EFF_DMAX_LO` / `EFF_DMAX_HI`. CPU full-res export and GPU proxy
preview must produce the same curve.

### White balance

WB stays a **multiply on `t`** (log-domain scale). `t = 0 → 0` for every
channel, so deep shadows stay neutral black — this preserves the documented
"yellow-shadow" fix (the bug was a log-space *offset*, not a scale). WB > 1 on a
channel can push `t` past `FILMIC_WHITE_T`; the curve clamps it to 1.0 (the
boosted channel clips to white, as the old `soft_clip` did).

### Clip-warning overlay

`clipCode` in `shaders.ts` currently keys highlight loss off `u_soft_clip`
(0.9). With true white at 1.0:

- Highlight loss: `t ≳ FILMIC_WHITE_T` (output ≈ 1.0). Strict mode flags the
  onset (`t ≳ 1.0`, i.e. into the shoulder).
- Shadow loss: `t ≈ 0` (output crushed near black), as today.

Repoint the thresholds to the new anchors so the red/blue warnings stay accurate.
`u_soft_clip` may be repurposed to carry the white anchor, or a new uniform
added — decided in the plan.

### Deprecated fields

`paper_grade`, `paper_black`, `soft_clip` become inert. Keep the struct fields
(`InversionParams`), the IPC structs (`gpu_upload.rs`), the uniforms, and the
session JSON keys so nothing downstream breaks; stop reading them in the filmic
path and add a deprecation comment. They can be removed in a later cleanup.

### HDR path

`p.hdr` keeps its current behavior: expand `out` above `HDR_KNEE` (0.8) into
`[HDR_KNEE, HDR_HEADROOM]`. It now operates on the filmic `out` (which reaches
~1.0 at white) instead of the paper-grade `out`. Minimal change; existing HDR
tests (`invert_d_hdr_*`) must still pass (their thresholds may need a numeric
refresh against the new curve, but the contract — below-knee == SDR, above-knee
exceeds 1.0 and caps at headroom — holds).

## Testing

Rust unit tests in `engine.rs`:

- `filmicS(0) == 0` (neutral black).
- Monotonic over a dense `t` sweep `[0, 1.2]`.
- `filmicS(FILMIC_WHITE_T) ≈ 1.0`; white regression: densest neutral neg renders
  ≥ 0.98 (vs the old 0.905 cap).
- Gamma redistribution: abs toe slope < mid slope, and mid slope > 1.0 (replaces
  the old flat-mid / hard-toe profile).
- WB keeps black neutral: `t = 0` → `[0,0,0]` under a non-neutral `wb`.
- Existing `invert_d_hdr_*` and parity/exposure tests pass (refresh numerics
  where the curve legitimately changed them).

GLSL side is verified by the shared-constant parity contract plus a manual GUI
smoke test on real scans (the user confirms the look).

## Out of scope

- User-adjustable filmic parameters (sliders / UI / IPC). Fixed transform only;
  can be exposed later.
- Removing the deprecated `paper_*` / `soft_clip` fields.
- Reworking the existing Develop/Finish controls (they continue to operate on
  the filmic output).
```
