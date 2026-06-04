# Film Negative Inversion — POC Design

**Date:** 2026-06-03
**Status:** Approved (design phase)
**Goal of this POC:** Prove that a density-domain (Beer-Lambert) inversion engine produces
visibly cleaner, more correct color than a naive flip, on real test files. This is the
"is our physics groundwork actually good?" test. UI is intentionally bare.

---

## 1. Background & Theory

A developed color negative is three stacked dye layers — Cyan, Magenta, Yellow — over an
orange acetate base. The physics of how a scan is produced (the forward model):

```
I_i = ∫ L(λ) · S_i(λ) · 10^(−D(λ)) dλ          (forward model)
D(λ) = D_min(λ) + Σ_{j=C,M,Y} C_j · D_j(λ)      (Beer-Lambert: density linear in dye conc.)
```

Two physical laws stacked: **Beer-Lambert** (film is non-scattering → transmittance is
`10^(−D)`, and total density is a concentration-weighted *linear* sum of dye densities plus
base) and **spectral integration** (illuminant × dye transmission × sensor sensitivity,
integrated over wavelength). Key insight: **density is linear in dye concentration;
transmittance is not** — which is why a naive invert-and-flip looks wrong.

### The two industry approaches

- **Path 1 (image-processing):** Negative Lab Pro, Grain2Pixel — treat the scan as a generic
  digital image; per-pixel, per-channel RGB tone curves + white-balance heuristics. NLP's
  "MAGIC" engine auto-generates up to 42 R/G/B curve points fed into Lightroom. No density
  model. Strong because the heuristics are well-tuned, not because it's physically correct.
- **Path 2 (physical/density):** darktable negadoctor (Cineon per-channel log-density),
  Filmeon (H-D curves + two 3×3 matrices), negicc (Status-M densitometry ICC profiles),
  academic (Trumpy et al., MDPI Heritage 2023) and patent US6633408B1 (full spectral model).

**Strategic finding from research:** "More scientific" is well-established and feasible.
"Demonstrably better output than NLP" is **not** proven — inversion is partly aesthetic.
Therefore our product strategy is **Path-2 physical core + Path-1-style creative finishing
on top** (they are sequential stages, not rivals). This POC validates the core.

---

## 2. Engine Strategy (decided)

Three candidate engines were considered:

- **A — Full spectral model** (the forward integral above). North star, but needs per-stock
  dye spectral densities `D_j(λ)`, illuminant `L(λ)`, sensor `S_i(λ)`; underdetermined from
  3 RGB channels. **Out of scope for POC**, documented as future direction.
- **B — Density-domain matrix inversion** (CHOSEN). The tractable realization of the same
  physics: `Ĉ = M_post · log10(M_pre · (I₀/I))`. This is what Filmeon and the academic
  paper actually ship.
- **C — Naive per-channel (Cineon/negadoctor-style).** Per-channel log-density, no
  cross-channel matrix. **Built in as the baseline to beat** — the POC win condition is "B
  visibly beats C."

**Decision:** Build **B** as the engine, ship **C** as a built-in comparison mode, structure
code so **A** can slot in later.

---

## 3. Architecture

Rust workspace with a hard split between engine (testable, no UI) and shell:

```
filmrev/
├── crates/
│   ├── film-core/        Pure Rust lib — NO UI deps. The product.
│   │   ├── decode/       RAF/DNG/TIFF → f32 linear RGB (+IR set aside)
│   │   ├── engine/       B (density matrix) + C (naive) inversions
│   │   ├── calibrate/    D_min sampling, matrix defaults / fitting
│   │   └── export/       f32 → 16-bit TIFF
│   └── film-cli/         Headless: `film-cli invert in.dng -o out.tiff --mode b`
└── app/                  Tauri shell (web UI) — added AFTER core is proven
```

The **CLI exists from day one** — it is how we run the physics on real files and diff B-vs-C
without UI. Tauri wraps the *same* `film-core` once color is validated.

---

## 4. The Engine (Approach B) — exact stages

Operating on f32 linear RGB, per pixel:

1. **Sample base** `I₀` — auto-detect film-base/border region (or user picks a rectangle) →
   per-channel value ≈ orange mask.
2. **Normalize** `r = I₀ / I` — removes orange cast (the `D_min` step).
3. **M_pre** (3×3, linear space) — corrects sensor↔dye spectral crosstalk. Default =
   identity; refined later via reference patches.
4. **log10** — into Beer-Lambert density space (linear in dye concentration).
5. **M_post** (3×3, density space) — unmix to clean neutral RGB.
6. **Tone/output** — exposure + black/white point → sRGB/Display gamma for export.

**Mode C** = steps 1, 2, 4, 6 only (per-channel, no matrices) — the negadoctor-style baseline.

---

## 5. Data Flow & Large-File Strategy

```
File ─► decode ─► f32 linear RGB (full res, in memory once)
                      │
          ┌───────────┴───────────┐
   downscaled PROXY (~2–4MP)   FULL RES
   for live preview/sliders    only on export
```

Sliders re-run the engine on the **proxy** (instant, even for 102MP / ~200MB GFX files);
**export** runs full-res once. Keeps the POC responsive **without GPU**; `wgpu` real-time is
a later optimization, not a POC dependency.

**Decode paths (both converge to one f32 linear RGB buffer):**
- Scanner **linear DNG/TIFF** (Epson V600 + SilverFast): read via the `tiff` crate — no
  demosaic, preserves 16-bit RGB **and the IR channel** (set aside for future dust removal).
- Camera **RAF/DNG** (Bayer, e.g. GFX100RF): `rawler` → demosaic → linear RGB.

**Decode priority for POC:** SilverFast linear DNG first, then GFX RAF.

---

## 6. Minimal UI (Tauri, after core is proven)

Load button · **side-by-side B vs C (vs naive flip)** · base-sample picker · ~4 sliders
(exposure, black point, WB/temp, contrast) · export. Bare, in service of *seeing* whether the
color is right.

---

## 7. Testing / How We Prove "Color Is Right"

- **Unit tests** in `film-core`: synthetic dye patches (eq. 8 reference set) through the
  engine; assert recovered values within RMS tolerance. Deterministic.
- **Golden-image test:** real V600 DNG + GFX RAF → CLI → committed reference output;
  regressions caught by diff.
- **Validation deliverable:** CLI emits B, C, and naive-flip side by side. "Win" = visual +
  neutral-patch measurement (gray stays gray).

---

## 8. Out of Scope for POC (hooked for later)

Full spectral model (A) · ICC / Status-M calibration · IR dust removal (channel preserved,
unused) · AI color correction · per-stock dye database · `wgpu` real-time preview. None block
the POC; each has a clear seam.

---

## 9. Assumptions to Verify

1. **SilverFast DNG is the raw un-inverted negative**, not an already-inverted positive. The
   engine needs the orange-masked linear scan. If SilverFast outputs an inverted positive,
   user must re-export the raw/HDR linear scan. (User described it as "64-bit positive" — to
   confirm at first-file test.)
2. The "64-bit" V600 DNG is **16-bit × 4 channels**, the 4th being the infrared (iSRD)
   channel. To confirm on decode.
3. GFX100RF files (102MP) represent the ~200MB upper bound for performance targets.

---

## 10. Tech Stack Summary

- **Core language:** Rust (one shared engine; `wgpu` available later for GPU preview).
- **UI:** Tauri (Rust backend + web frontend) for consumer polish, cross-platform Mac/Windows.
- **Decode:** `tiff` crate (linear DNG/TIFF), `rawler` (Bayer RAF/DNG).
- **Export:** 16-bit TIFF via `tiff` crate.
- **Future AI (dust/color):** ONNX runtime seam; IR channel preserved from decode.
