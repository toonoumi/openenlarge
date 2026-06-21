# Per-Stock Color Matrix (EKTAR proof) Design

**Status:** Approved design — ready for implementation plan. Written 2026-06-21.

**Goal:** Fit one white-preserving 3×3 color matrix into the engine's existing
`m_post` (density-space) slot from the EKTAR ColorChecker frame, minimizing mean
ΔE2000 over the chromatic patches, and apply it as the engine default — dropping
the ~ΔE 27 neutralized chroma error toward a much lower value, making the Faithful
core's *color* as faithful as its tone already is.

**Sub-project context:** This is sub-project **B** of the WB/film-stock work, and
the v1 ("prove on EKTAR") slice of the eventual per-stock color profile system.
Sub-project A (roll-base anchor) shipped 2026-06-21. Sub-project C (ML-WB spike)
is parked. This spec is the proof-of-concept; v2 (other stocks + stock selection
UI) is explicitly out of scope.

---

## Problem

The Faithful core reconstructs *tone* faithfully (Cineon densitometry fit to C400
H–D data, fixed density scale) and now reconstructs *neutrals* consistently (WB
freeze + roll-base anchor). But it applies **no color matrix** — the engine's
`m_post` is identity — so *saturated* colors are only approximately reconstructed.
The last film-bench measurement put EKTAR's neutralized chroma error at **~ΔE 27**:
even with perfect WB, the 18 chromatic ColorChecker patches land far from their
sRGB reference. WB fixes neutrals; only a color matrix fixes saturated hue/chroma.

## What already exists (reused, not built)

- **`m_pre` / `m_post` 3×3 matrix slots** in the engine, both identity today:
  `engine.rs:38,40` (`Matrix3<f32>`), wired through GPU as `u_m_pre` / `u_m_post`
  (`shaders.ts:366-367,530,533`, column-major `mat3`). `m_post` is the
  **post-log density-space unmix** — physically the right place for film dye
  crosstalk (multiplicative in transmittance = additive in density).
- **film-bench `score_color`** (`crates/film-core/src/bench.rs`): inverts the
  ColorChecker frame, samples 24 patches, converts to Lab, scores ΔE2000 —
  emitting `neutralized`, `neutralized_chroma_only`, and `as_shipped` means.
  `NEUTRAL_INDICES` marks the 6 gray patches; `classic24_lab()` is the D65
  reference.
- **`benchdata/ektar.roi.json`** — the EKTAR ColorChecker corners. The frames
  live in the user's local `/FILM/EKTAR 100` (01/02/07 calibration, 13 = chart).
- **The GammaShoulder fit pattern** (faithful-tone-core): a film-bench fit mode
  that optimizes constants on a calibration frame and records them for baking
  into the engine. This matrix fit mirrors it.
- **`ENGINE_VERSION` + eager `sweepStale` catalog re-bake** on entry — the
  standard migration path for an engine change.

## Design

### The matrix

- A **3×3 matrix in the `m_post` density-space slot**, replacing identity.
- **White-preserving:** each row sums to 1, so a neutral (equal-density across
  R/G/B after WB) maps to itself. The gray axis — and therefore all WB,
  roll-base, and freeze behavior — is untouched. The matrix corrects only
  chromatic dye crosstalk. This leaves **6 free parameters** (3 rows × 2 free,
  the third per row fixed by the sum-to-1 constraint).
- Stored behind a `stock_matrix(stock) -> Matrix3` lookup whose **default returns
  the EKTAR fit**. v1 fills only the default; v2 adds per-stock entries. No
  selection UI in v1 — the fitted matrix applies to every develop as the engine
  default.

### The offline fitter (film-bench fit mode)

A new fit mode in `film-bench` (mirrors the GammaShoulder fit), driven by an
EKTAR manifest pointing at `/FILM/EKTAR 100` with the `ektar.roi.json` corners:

1. Decode the EKTAR ColorChecker frame; sample its film base (as `score_color`'s
   `neutralized` path does).
2. Invert at the base, WB-neutralized on the 6 gray patches (so neutrals are
   locked — exactly the `neutralized` scoring condition).
3. Optimize the 6 free parameters of a white-preserving `m_post` to minimize
   **mean ΔE2000 over the 18 chromatic patches**, running the **full render
   end-to-end** (m_post → tone curve → look layer → sRGB → Lab) so the curve's
   nonlinearity is accounted for in the fit. A derivative-free optimizer
   (e.g. Nelder–Mead / coordinate descent) over 6 params on 18 patches is
   well-constrained.
4. Output: the 9 matrix constants (column-major) + before/after ΔE (per-patch
   and mean), confirming the chromatic mean drops and the 6 neutrals stay ~0.

The fitter is offline tooling; its output (the constants) is baked into the
engine, not run at app time.

### Engine integration (CPU/GPU parity)

- Bake the fitted matrix as a constant (alongside `FAITHFUL_GAMMA` etc.).
  `build_params` sets `m_post` from `stock_matrix(...)` (default = EKTAR fit).
- Both engines already apply `m_post`: CPU `engine.rs` (nalgebra), GPU
  `shaders.ts` (`u_m_post`). Supply the constant in both and add a **parity
  test** asserting the CPU matrix equals the GPU uniform (column-major) and that
  a sample render matches CPU↔GPU — the same parity discipline the Faithful look
  layer used.
- White-preserving ⇒ no WB/neutral behavior changes.

### Migration & validation

- **`ENGINE_VERSION` bump + catalog re-bake** via the existing eager `sweepStale`
  refresh-on-entry (every render changes). Saved per-image edits are preserved
  (the matrix is an engine default, not a per-image param).
- **film-bench gate:** neutralized chroma ΔE drops materially from the ~27
  baseline with **no neutral-patch regression** (white-preserving guarantees the
  latter; the test asserts both). Report before/after means.
- **Visual check (user GUI smoke):** EKTAR looks more faithful; spot-check a
  couple of other stocks (Portra, etc.) to confirm the universal EKTAR matrix is
  a net improvement, not a regression.

## Scope

**In scope (v1):**
- One EKTAR-fitted white-preserving `m_post`, applied as the universal engine
  default.
- The offline film-bench fit mode + the EKTAR manifest.
- CPU/GPU parity test.
- `ENGINE_VERSION` bump + re-bake migration.
- film-bench before/after ΔE gate.

**Out of scope:**
- Fitting other stocks (more manifests) — v2.
- Reviving the `stock` field with a selection UI or auto-detect — v2.
- `m_pre`, or a linear-RGB CCM alternative to `m_post`.
- The ML-WB spike (sub-project C).

## Risks

- **EKTAR matrix on other stocks may be imperfect.** Mitigated: white-preserving
  keeps neutrals safe on every stock, and a dye-crosstalk correction fit on a
  neutral C-41 stock generalizes reasonably to similar C-41 stocks. The user's
  visual spot-check is the gate; v2 makes it per-stock.
- **`m_post` is pre-tone-curve (density space), so it could nudge tone.**
  Mitigated: the fit is end-to-end through the curve and targets chromatic
  patches only; the bench's neutral + tone metrics catch any drift. If drift
  appears, the white-preserving constraint already pins the neutral axis.
- **Fit instability / overfit.** 6 params on 18 patches is well-constrained;
  report per-patch residuals so a single patch can't hide a bad fit.
