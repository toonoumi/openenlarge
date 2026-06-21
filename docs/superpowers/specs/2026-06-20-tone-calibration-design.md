# Tone Calibration (Measure + Recommend) — Design

**Date:** 2026-06-20
**Status:** Approved (design); implementation pending
**Scope:** First brick of the inversion redesign's *reconstruction core* (see
`memory/inversion-north-star.md`). Measurement only — does NOT change the engine.

## Goal

Measure our film-inversion engine's **tone transfer curve** against a calibrated
**digital-SDR reference** across the film's full latitude (~17.5 EV), then **fit and
recommend** the engine parameters (`d_max`, exposure, and the filmic curve constants)
that would make our output match that reference — and report the residual.

This answers, with data: *is the engine's tonal reproduction faithful, and if not, can
existing knobs make it so, or does the curve itself need to change?* It is the
prerequisite for the north-star plan: get the reconstruction core measurably faithful
**first**, add a film-pleasing look **later**.

This build changes **nothing** in the engine. It produces a verdict + recommended
parameters + a residual number we can later drive to zero in a separate, deliberate
engine change.

## Context

### The reference data (Eva / "EVA H-D V5.2" method)

A 10×10 (100-patch) grayscale wedge displayed on a calibrated sRGB LCD, photographed on
**C400 color negative** at three base exposures (+0 / +6 / +9 EV), then the negatives
re-photographed on a lightbox. Files (Fujifilm RAF, ~209 MB each), in
`/Users/mohaelder/Desktop/c400/`:

| file | base exposure |
|---|---|
| `Capture One Catalog8328.raf` | +0 EV |
| `Capture One Catalog8329.raf` | +6 EV |
| `Capture One Catalog8330.raf` | +9 EV |

Per-patch reference data is in `/Users/mohaelder/Desktop/C400 基准曝光数据.xlsx`:
- **`相对ev`** — the patch's relative scene EV (0 at the brightest patch → −8.57 at the
  darkest), rigorously computed (ISO 12232: `EV = log2((DN−BL)/(DN_mid−BL))`,
  `BL ≈ 512`). This is the **x-axis ground truth**. Confidence-tagged: error **< 0.05 EV**
  in the bright range, degrading to **> 0.3 EV** in the deep shadows.
- **`数值`** — the digital-SDR reference response per patch (what a calibrated digital
  sensor produced). This is the **y-axis target**. Its encoding (linear DN vs gamma) is
  not stated; the harness **infers** it (see "数值 encoding" below) and documents the
  assumption.

All three frames shoot the **same** physical wedge (same 100 relative EVs); they differ
only by base exposure, so a patch's absolute scene EV = `相对ev + base_offset`. The union
spans ~17.5 EV.

### Key facts that shape the design

- **Film is shadow-limited, digital is highlight-limited.** Below the film's density
  onset (~−5 EV, low-confidence patches), the negative genuinely holds little
  information — so deep-shadow deviation is partly the film, not our engine. Weight it
  down; do not chase it.
- **First throwaway measurement (default `d_max=1.5`)** showed our transfer ~2–3 stops
  too dark and over-crushed (brightest patch → L\*33, mid-gray never reached). This build
  formalizes that measurement and fits the correction.
- This is a **strength-matched** use of the data: the LCD-spectrum caveat makes Eva's set
  authoritative for **tone/density** (this build) but not absolute color (the
  ColorChecker work covers color separately).

## Approach decisions (locked in brainstorming)

1. **Measure + recommend only** — no engine/GPU/versioning changes.
2. **Target = digital-SDR** from `数值`; **x = scene EV** from `相对ev`.
3. **Fit `d_max` + exposure AND test the filmic curve constants** — comparing the best
   filmic-curve residual against a straight/gamma alternative settles the "filmic vs
   gamma" debate with data.
4. **Rank-pairing, not orientation mapping** — within each frame both our output and the
   reference are monotonic across the wedge, so sort-and-pair-by-rank avoids authoring
   (and mis-authoring) the grid's row/col orientation. We still author + overlay-verify
   the 4 grid corners per frame.
5. **`数值` encoding inferred** and documented.
6. Baseline being measured = the app's **real develop path** (auto `d_max` + clearfilm
   base), not throwaway defaults.

## Architecture

Pure curve/metric/fit math lives in a new, unit-tested `film-core` module; IO, xlsx
parsing, manifest, and orchestration live in `film-bench`.

```
crates/film-core/
  src/
    tone.rs        # pure: filmic curve eval, density→output, transfer metrics,
                   #       confidence-weighted deviation, d_max/exposure/curve fit
crates/film-bench/
  src/
    wedge.rs       # serde wedge manifest (frames, base offsets, corners) + xlsx ingest
    tone_run.rs    # orchestrator: decode → invert → sample → stitch → measure → fit
  benchdata/
    c400.wedge.json    # the wedge manifest (corners, frame base offsets)
```

### Components

- **`film-core/src/tone.rs`** (pure, tested):
  - `filmic(t, k, pivot, white_t) -> f32` — the engine's logistic curve, parameterized
    so the fit can vary the constants (default `K=5.0, PIVOT=0.44, WHITE_T=1.05`).
  - `output_lstar(scan, base, d_max, expo_ev, curve) -> f32` — replicate the engine's
    per-channel density → `t = (d/d_max)·2^(EXPO_K·ev)` → `filmic` → L\* (so the fit
    runs on sampled patches without re-inverting the 100 MP frame).
  - `transfer_metrics(points, target, weights)` — confidence-weighted RMS/max ΔL\*,
    mid-gray placement, shadow/highlight clip points, monotonicity.
  - `fit_tone(points, target, weights, mode)` — coordinate-descent fit returning the
    best params + residual. `mode` selects which knobs vary: `{d_max,expo}` or
    `{d_max,expo,curve}` or a straight/gamma alternative transfer.

- **`film-bench/src/wedge.rs`**: `WedgeManifest { dir, frames: [{file, base_ev, corners}] }`
  (serde); `load_reference(xlsx_path) -> Vec<RefPatch{ev, value, confidence}>` parsing
  the xlsx via the existing stdlib-zip/XML approach (no new dep); `infer_target_lstar`
  applying the documented `数值` encoding + anchor.

- **`film-bench/src/tone_run.rs`**: for each frame — decode via `decode_raw`, derive base
  via `sample_base_clearfilm`, sample the 100 patches (`chart::sample_grid`, 10×10),
  rank-pair against the reference EVs, add `base_ev` → absolute-EV points; stitch all
  three; run `transfer_metrics` + `fit_tone` for each mode; write outputs; emit an
  overlay per frame for corner verification.

### `数值` encoding (inferred, documented)

`数值` ranges 10664→1048 while `相对ev` spans 0→−8.57. Since `数值` is *not* ∝ `2^EV`
(that would span ~380×, not ~10×), `数值` is a **compressed/encoded** reference response,
not linear DN. The harness treats `数值` as the digital reference's display-referred
response: normalize `(数值−BL)/(数值_max−BL)` with `BL≈512`, then derive target L\* with
the mid-gray anchored to the SOS convention (18% gray → 118/255 sRGB). The exact encoding
assumption is written into `wedge.rs` as a single documented function so it is trivial to
correct if the user later specifies `数值`'s true definition. **Only the absolute L\*
anchor depends on this; the curve *shape* comparison does not.**

## Data flow

```
xlsx ──► load_reference ──► [RefPatch{ev, value, confidence}]×100 ──► target L*(ev)
                                                                         │
3 RAF frames ──► decode_raw ──► sample_base_clearfilm ──► sample_grid(10×10)
   │                                                          │
   └─ per frame: rank-pair patches↔ref EVs, +base_ev ─────────┘
                          │
                          ▼
        stitched [(abs_ev, our_output, confidence)] over ~17.5 EV
                          │
              ┌───────────┴───────────┐
       transfer_metrics            fit_tone (3 modes)
       (deviation now)        (recommended params + residual)
                          │
                          ▼
    tone_report.json + transfer_curve.csv + overlay_*.png + stderr headline
```

## Outputs

- **`tone_report.json`** — baseline deviation (RMS/max ΔL\*, mid-gray L\*, shadow/highlight
  clip EV, monotonic), plus, per fit mode (`d_max+expo`, `+curve`, `straight/gamma`): the
  recommended parameters and residual. A headline verdict: *can existing knobs make us
  faithful, or does the curve need to change?*
- **`transfer_curve.csv`** — `abs_ev, our_output, target, confidence, fitted_output` for
  plotting (our-vs-target before and after fit).
- **`overlay_<frame>.png`** — sampling-window verification (the human checkpoint).
- Headline summary to stderr.

## Error handling

- Missing RAF / xlsx → clear error, non-zero exit.
- A frame whose corners are unset → error naming the frame.
- Deep-shadow patches below the film's density onset contribute near-zero weight
  (confidence tier), so they cannot dominate the fit.
- `数值` anchor is isolated in one function; a wrong assumption shifts only the absolute
  L\* offset, not the shape verdict.

## Testing

- `tone.rs` unit tests: `filmic` matches the engine's constants at sample points;
  `output_lstar` on a synthetic ramp reproduces a known monotonic curve; `fit_tone`
  recovers a known `d_max` from synthetic data generated at that `d_max`;
  `transfer_metrics` flags a non-monotonic input.
- `wedge.rs`: parse a minimal inline xlsx-shaped fixture; `数值` anchor function pinned by
  a unit test.
- `tone_run`: end-to-end on the real C400 frames is a **human-verified** step (overlays
  confirm sampling; the headline numbers are the deliverable), mirroring the color
  benchmark's Task-8 checkpoint.

## Scope boundaries (YAGNI)

**In:** the tone measurement + fit/recommend on the C400 data, as a `film-bench` mode.

**Out (deliberate):**
- Any engine change (`engine.rs`, GPU `shaders.ts`, versioning) — a separate follow-up
  once the residual proves the fit.
- The film-pleasing look curve — the *later* layer.
- Color (ΔE / matrix) — a separate axis already covered by the ColorChecker benchmark.
- Generalizing beyond C400 — the methodology is universal but we only author the C400
  manifest here.

## Open item to confirm at review

- `数值`'s true encoding (linear DN vs gamma vs display code). The build proceeds on the
  documented inference; confirming it only sharpens the absolute L\* anchor.

## Amendment (post-build human checkpoint, 2026-06-21)

The original design stitched all 3 frames into one ~17.5 EV transfer. The checkpoint found
this conflates two goals: the 3 frames are the SAME wedge at different camera exposures
(+0/+6/+9), so the digital-SDR target (a function of the monitor patch / relative EV) is the
same set for every frame — stitching by absolute EV makes it sawtooth/non-monotonic, and one
fixed inversion cannot map a patch's three different negative densities to its single target.

**Resolution (user-approved):** measure tone fidelity **per frame** (each frame independently:
its 100 patches' output L\* vs the digital-SDR target). The 17.5 EV film **H-D curve** (density
domain, exposure-normalized) is a **separate, deferred** analysis. The runner now reports
per-frame baseline + fits.

**Per-frame C400 result (overlay-verified):**
| frame | baseline rms ΔL\* | fit d_max only | +filmic curve | gamma |
|---|---|---|---|---|
| +0 EV (correct exposure) | 34.6 | 12.6 | 7.3 | **4.4** |
| +6 EV | 24.0 | 11.9 | 6.9 | 8.0 |
| +9 EV | 32.5 | 14.2 | 10.0 | 8.8 |

**Findings:** (1) the engine is ~2.5 stops too dark on the correctly-exposed frame (target
L\*95 vs our 38), confirmed against calibrated truth; (2) it is very fixable (d_max alone
34.6→12.6; +curve →7.3); (3) **a plain gamma transfer beats the filmic S-curve on the +0
frame (4.4 vs 7.3)** — strong evidence the reconstruction core should use ~gamma, but mixed on
the over-exposed frames → **verify on more frames/stocks before any engine change** (and the
filmic shoulder may still belong in the optional film-look layer). No engine change in this
build (measurement only).
