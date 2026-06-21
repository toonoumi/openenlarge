# Inversion Benchmark Harness — Design

**Date:** 2026-06-20
**Status:** Approved (design); implementation pending
**Scope:** First sub-project of the "benchmark + fine-tune the inversion engine" effort.

## Goal

We received a calibrated test roll (a "goldmine") shot specifically to characterize
film + our inversion: known targets for resolution, density/tone, exposure latitude,
and color. Build an **objective, repeatable, GUI-free benchmark** that scores the
*current* inversion engine against this ground truth, so any subsequent tuning is
measured against a number instead of eyeballed against PNGs.

This sub-project builds **measurement only**. It does not change the engine. Whether
tuning later uses existing knobs or adds a new colorimetric stage is deferred — the
benchmark output is what informs that decision.

## Context

### The dataset

Per-stock rolls live under `/Users/mohaelder/Downloads/FILM/<STOCK>/`. We prototype on
the **EKTAR 100** roll (31 frames). Confirmed frame manifest (matches the shooter's
notes and the test-plan table):

| Frames | Content | Grounds |
|---|---|---|
| 01 | Leader / **d_max** (densest) | max density |
| 02 | Clear base / **d_min** (KODAK EKTAR 100 rebate) | per-channel film base (orange mask) |
| 03–05 | USAF + wedge + **SFR** targets | resolution / MTF (out of scope here) |
| 06–09 | **Step wedge** (EVA-10S, ~1 EV/cell, 4 base exposures) | tone transfer curve |
| 10–24 | **24-patch ColorChecker**, exposure-bracketed + a few rotations | color accuracy + exposure latitude |
| 25–31 | Real scenes (figure art, landscape) | perceptual sanity only |

The exposure scale is ~1 EV/cell at ±0.2 EV precision. The most-overexposed wedge step
may be unreliable (multi-second exposure → reciprocity failure); the harness must
tolerate dropping flagged steps.

### The engine fact that shapes the design

The inversion core (`crates/film-core/src/engine.rs`) has **no colorimetry**: it runs
per-channel Kodak Cineon density → a fixed filmic S-curve → white-balance *gains*,
treating R/G/B independently. It never reads the DNG ColorMatrix and has no
camera→working-space transform. Two identity-default matrix hooks exist
(`InversionParams.m_pre`, `.m_post`) as natural future insertion points. Today, color
accuracy is "whatever falls out of the per-channel math + auto-WB." The benchmark's job
is to quantify exactly that.

### Decisions locked during brainstorming

1. First deliverable = **benchmark harness** (this doc). Tune afterward.
2. Invasiveness of tuning = **decide after** seeing the measured error.
3. Tuning target = **universal default + optional per-stock** (so the harness is
   stock-agnostic, driven by a manifest + reference, not hard-coded to EKTAR).
4. Patch localization = **assisted ROI manifest** (hand-authored corners, not CV
   auto-detect, not in-app picker).
5. Corner marking = **I draft, user verifies via overlay PNGs**.

## Architecture

Measurement logic lives in **new, unit-tested library modules** in `film-core`; a thin
example orchestrates. This keeps the math testable and the runner disposable.

```
crates/film-core/
  src/
    color.rs     # sRGB EOTF <-> XYZ <-> Lab, Bradford adapt, ΔE2000   (unit-tested)
    chart.rs     # ROI sampling: corners -> 6x4 patch grid + gray ramp (unit-tested)
    bench.rs     # color ΔE protocol + tone-transfer fit + metrics structs
  examples/
    bench.rs     # orchestrator: roll dir + manifest + reference -> outputs
  benchdata/
    ektar.roi.json          # per-frame manifest (corners, frame roles)
    colorchecker24.json     # reference Lab (ColorChecker Classic 24)
```

### Components

- **`color.rs`** — Self-contained color math. No new heavy dependency (no `palette`).
  Functions: `srgb_to_linear` / `linear_to_srgb`, `linear_rgb_to_xyz` (sRGB/D65
  primaries), `xyz_to_lab` (selectable white), `bradford_adapt`, `delta_e_2000`.
  Unit tests verify sRGB→Lab against published ColorChecker values and ΔE2000 against
  the Sharma et al. reference test vectors.

- **`chart.rs`** — Given 4 chart-corner pixel coords (TL, TR, BR, BL of the 24-patch
  grid) and a grid spec (6×4, gutter fraction), bilinearly interpolate each patch
  center, sample an inset window per patch with a **trimmed mean** (reject the brightest
  and darkest fraction to kill dust/scratches/edge bleed). Also samples the gray ramp by
  its own corner set. Emits an **overlay image** (input frame downscaled + drawn sample
  windows + patch indices) for human verification. Unit tests cover interpolation and
  trimmed-mean on synthetic patches.

- **`bench.rs`** — Pulls patch RGBs from `chart.rs`, runs the engine, computes the two
  color scores and the tone curve (protocols below). Returns plain metric structs;
  serialization to JSON happens in the example.

- **`examples/bench.rs`** — Reads the manifest + reference, decodes each needed frame
  (reusing the existing `decode_raw` path — including the type-13 SubIFD fix), runs the
  metrics, writes all outputs, prints a headline summary to stderr.

- **`benchdata/*.json`** — Committed data. The ROI manifest format is stock-agnostic:
  per-frame entries tag a `role` (`d_min`, `d_max`, `wedge`, `color`, `scene`,
  `resolution`), and `color`/`wedge` frames carry corner coordinates and a `flags` list
  (e.g. `unreliable` for the reciprocity-failed wedge step). A top-level field names the
  reference chart so the harness loads the right Lab table.

## Color protocol & metrics

For each manifest-tagged correct-exposure `color` frame:

1. Decode the negative, run the engine to a positive (display sRGB), sample the 24
   patches + 6-step gray ramp via `chart.rs`.
2. Compute **two** ΔE2000 scores:
   - **Neutralized ΔE** — fit per-channel WB gains so the gray ramp reads neutral, then
     score. Isolates the engine's *chroma rendering* (the quantity a color-matrix stage
     would attack).
   - **As-shipped ΔE** — the engine's default auto-WB output (what the user sees).
3. Report: mean / max / 95th-percentile ΔE; the **18 chromatic patches scored
   separately from the 6 neutrals**; a per-patch table; and a contact sheet (rendered
   patch swatch vs reference swatch with per-patch ΔE heat).

**Measurement space:** engine output is treated as sRGB-encoded display values
(that is how it is shown on screen) → linearize → XYZ (sRGB/D65 primaries) → Lab.
The ColorChecker reference Lab is D50; it is Bradford-adapted D50→D65 so both sides
share one white. This is documented in `color.rs` so the convention is unambiguous.

## Tone protocol & metrics

Primary probe is the **step wedge** (frames 06–09, ~1 EV/cell); the ColorChecker gray
ramp is a cross-check.

1. Sample each wedge step's neutral output (mean of R,G,B → L*) vs its known relative
   exposure (EV), skipping steps flagged `unreliable`.
2. Fit / tabulate the **transfer curve** (output L* vs scene EV).
3. Scalar metrics: **18% mid-gray placement** (output L* at the mid-gray step),
   **shadow latitude** (EV below mid where the toe crushes, slope < threshold),
   **highlight latitude** (EV above mid where the shoulder clips), **mid-tone slope**
   (contrast), and **monotonicity** (flag reversals).

d_min (frame 02) supplies the per-channel base; d_max (frame 01) the max density. These
are reported as context (and feed the existing base sampling), not scored.

## Outputs

A single run writes, to an output dir:

- `metrics.json` — every score (color + tone + base/d_max context), machine-readable so
  this doubles as a regression baseline for the tuning sub-project.
- `contactsheet.png` — rendered vs reference patch swatches with ΔE heat.
- `overlay_<frame>.png` — sampling-window verification overlays.
- `tone_curve.csv` and `tone_curve.png` — the transfer curve.
- Headline summary to stderr (mean neutralized ΔE, mean as-shipped ΔE, mid-gray L*,
  shadow/highlight latitude).

## Scope boundaries (YAGNI)

**In:** color ΔE + tone-transfer measurement on the EKTAR roll, with a stock-agnostic
manifest format.

**Out (noted as future):**
- Resolution / MTF from the SFR/USAF/wedge targets (that is decode/demosaic quality, not
  inversion tuning).
- GPU-shader (`shaders.ts`) parity — only relevant once we tune.
- The tuning itself (color matrix vs existing knobs) — separate sub-project, decided
  from this benchmark's output.
- Multi-stock fitting — the harness reads any roll given a manifest + reference, but we
  only author the EKTAR manifest here.

## Open items to confirm at spec review

- **Chart identity:** assumed **ColorChecker Classic 24**. If it is a SpyderCheckr,
  Calibrite Digital SG, or other layout, the reference table and grid spec change.
- The shooter's metering was incident with a new meter at ±0.2 EV; we treat the wedge EV
  labels as ground truth within that tolerance and do not attempt sub-0.2 EV claims.

## Testing

- `color.rs`: unit tests vs published ColorChecker sRGB→Lab and Sharma ΔE2000 vectors.
- `chart.rs`: unit tests for grid interpolation and trimmed-mean on synthetic frames;
  human verification of real frames via overlay PNGs.
- `bench.rs`: a small end-to-end test on one EKTAR color frame asserting the metric
  structs populate and ΔE is finite/in-range; the overlay confirms sampling alignment.
