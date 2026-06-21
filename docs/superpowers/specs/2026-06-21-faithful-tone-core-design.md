# Faithful Tone Core — Design

**Date:** 2026-06-21
**Status:** Approved (design); implementation pending
**Scope:** First engine sub-project of the inversion redesign's *reconstruction core*
(see `memory/inversion-north-star.md`). Builds a faithful display transfer + exposure
anchor as a SELECTABLE tone path; the filmic default is untouched.

## Goal

Give the engine a **faithful** tone path — one whose default render reproduces the scene
as measured against a calibrated digital-SDR reference, instead of baking a punchy filmic
S-curve (which crushes shadow detail) into reconstruction. This is the principle
"present the best inversion at the core; auto-exposure is a safeguard, not the
correctness mechanism."

It ships as a new `tone_mode` (`Filmic` | `Faithful`) with **`Filmic` remaining the
default**, so nothing changes for existing users/edits. The `Faithful` path is the
detail-preserving foundation the look layer will build on later.

## Context

- **Measured evidence (C400 wedge, per-frame, overlay-verified):** at correct exposure
  the filmic S-curve leaves rms ΔL\* ~13 vs the digital-SDR reference; a gamma transfer
  reaches **4.4**, and tuning the filmic constants drives the curve toward a near-straight
  line (contrast k 5.0 → 1.9). The data says the faithful curve is **much flatter** than
  today's filmic.
- **Visual confirmation:** rendering a real EKTAR scene with a gamma core vs the filmic
  core shows the gamma core preserves all shadow detail (open, scan-like) where the filmic
  core crushes it to black — detail that cannot be recovered later.
- **Auto-exposure already lands the faithful path well** (`auto_brightness`, 90th-pct →
  0.80): eff d_max 0.66 ≈ the optimal-exposure fit. But that is the safeguard doing the
  core's job; the core should be correctly exposed by default.
- C400 is the only calibrated wedge we have; we commit on this evidence + first principles
  (no second stock is coming).

## Approach decisions (locked in brainstorming)

1. **Selectable `tone_mode`**, `Filmic` default (zero breakage). Filmic untouched.
2. **Faithful curve = gamma body + gentle highlight shoulder** (not pure gamma): straight
   in log-density through shadows/mids; a smooth shoulder above a knee so speculars roll
   off gracefully (film has real highlight latitude) instead of hard-clipping.
3. **Include the core exposure anchor:** the Faithful default must be correctly exposed
   without auto-exposure.
4. **Measured, not asserted:** ship only if the harness confirms the ΔL\* drop on C400 and
   the EKTAR scene render looks right.
5. Filmic-as-a-look rework, full core/look separation, default flip, stock-specific looks
   are **out** (the grand plan, later).

## The faithful transfer

In the engine's normalized log-density domain (`t = d/d_max`, `d = log10(base/scan)`),
the Faithful display value is a **gamma body with a smooth asymptotic shoulder**:

```
raw   = t.max(0)^(1/GAMMA)                         // gamma body (straight in log-density)
disp  = raw                       if raw <= KNEE
disp  = KNEE + (1-KNEE)*(1 - exp(-(raw-KNEE)/(1-KNEE)))   if raw > KNEE   // soft shoulder → 1.0
```

- **C1-continuous at the knee** (both sides have slope 1 at `raw == KNEE`), monotonic,
  anchored `disp(0)=0`, `disp(∞)→1`.
- `GAMMA` and `KNEE` are **fit to the C400 reference** (start γ≈2.4). `KNEE` sets where the
  highlight rolloff begins so the wedge's brightest patches land correctly without clipping.
- **HDR:** when `hdr` is set, the shoulder asymptotes toward `HDR_HEADROOM` instead of 1.0
  (same structure, different ceiling), consistent with the existing HDR knee semantics.

This lives in `film-core/src/tone.rs` as a new `Transfer::GammaShoulder { gamma, knee }`
variant (the harness already uses `tone.rs::Transfer` to fit), and is mirrored in the
engine's `invert_d` for `tone_mode == Faithful`.

## The exposure anchor

The Faithful path must land correct exposure **by default** (no auto-exposure). The
engine keeps per-frame `d_max` (from `sample_dmax`) for adaptation, but the Faithful
density scale carries a **calibration constant** anchoring absolute level to the SOS
convention (18% mid-gray → sRGB 118 ≈ L\*50):

```
t_faithful = (d / d_max) * FAITHFUL_ANCHOR
```

`FAITHFUL_ANCHOR` is calibrated once so the Faithful **default** render lands SOS mid-gray
on the C400 reference, and is **verified by the harness**: the Faithful default (no
exposure fit applied) must score near the fitted optimum — i.e. running `auto_brightness`
on it should change exposure only slightly (the safeguard barely moves it). `Filmic` mode
keeps its current `t = d/d_max` exactly (no anchor) so it is byte-identical to today.

## Wiring & CPU/GPU parity

- **`InversionParams.tone_mode: ToneMode { Filmic, Faithful }`** (serde, `#[serde(default)]`
  = `Filmic`), alongside the existing `wb_mode`. Plumbed through `app/src-tauri`
  (`session.rs` `InvertParams`, `commands.rs` `build_params`/`resolve_params`,
  `gpu_upload`) exactly as `wb_mode` was.
- **GPU parity (mandatory):** `shaders.ts` `INVERT_FRAG` mirrors the `GammaShoulder` curve
  + anchor verbatim, gated on a `u_tone_mode` uniform. The CPU and GPU paths must render
  identically (the project's standing parity contract).
- **Frontend:** a minimal `tone_mode` toggle (Filmic | Faithful) in the develop Basic
  panel + i18n (generated from `i18n-strings.csv`, never edit dict.ts directly), default
  Filmic. Wiring only — no look-layer UI.

## Measurement (the gate)

- Extend `film-bench tone`'s fit to include the `GammaShoulder` transfer and report the
  Faithful curve's residual vs Filmic on C400. **Ship criterion:** Faithful rms ΔL\* in
  the single digits and clearly below Filmic, AND the Faithful *default* (anchor applied,
  no fit) near-optimal (validates the exposure anchor).
- Render the EKTAR scene in Faithful vs Filmic for visual confirmation (open shadows,
  graceful highlights, no hard clip).

## Testing

- `tone.rs` unit tests: `GammaShoulder` anchors (`disp(0)=0`), monotonicity across the
  range, C1 continuity at the knee (slope ≈ 1 on both sides), shoulder asymptotes below
  1.0, and the anchor places a mid-gray density at ≈ L\*50.
- Engine: a CPU test that `tone_mode == Filmic` output is **unchanged** vs the pre-feature
  engine (byte-identical default), and that `Faithful` produces the gamma+shoulder curve.
- CPU↔GPU parity: extend the existing parity probe (`expo_cct`-style) so the Faithful
  curve's CPU output matches the documented GLSL formula at sampled densities.
- Harness regression: `film-bench tone` still runs; the new fit variant is covered.

## Architecture / file structure

- `film-core/src/tone.rs` — add `Transfer::GammaShoulder { gamma, knee }` + its
  `apply_transfer` arm + the fit mode; unit-tested.
- `film-core/src/engine.rs` — add `ToneMode` enum + `InversionParams.tone_mode`; in
  `invert_d`, branch the display transfer (Filmic = current; Faithful = gamma+shoulder with
  `FAITHFUL_ANCHOR`). Keep Filmic path byte-identical.
- `app/src-tauri/src/{session.rs,commands.rs,gpu_upload.rs}` — plumb `tone_mode`.
- `app/src/lib/.../shaders.ts` — GPU mirror + uniform.
- `app/src/lib/develop/Basic.svelte` (+ i18n csv) — the toggle.
- `crates/film-bench` — extend the tone fit/report for `GammaShoulder`.

## Scope boundaries (YAGNI)

**In:** the Faithful `tone_mode` (gamma+shoulder curve + exposure anchor), CPU+GPU+wire+UI,
fit/measured on C400, Filmic default untouched.

**Out (grand plan, later):** filmic reworked as a look layer; full core/look separation;
flipping the default to Faithful; stock-specific looks/profiles; color (ΔE) correction;
the multi-frame H-D curve analysis.

## Open items to confirm at review

- Final `GAMMA`/`KNEE`/`FAITHFUL_ANCHOR` values are fit during implementation; the spec
  fixes the *form* and the *acceptance criteria*, not the literals.
- `数值` encoding assumption (from the tone-calibration spec) still underlies the absolute
  L\* anchor; the curve *shape* and the relative Faithful-vs-Filmic improvement do not
  depend on it.
