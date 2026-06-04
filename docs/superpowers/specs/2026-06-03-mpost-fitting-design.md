# M_post Matrix Fitting — Design

**Date:** 2026-06-03
**Status:** Approved (design phase)
**Depends on:** the POC engine (`docs/superpowers/specs/2026-06-03-film-inversion-poc-design.md`)

## Goal

Fit the density-space unmixing matrix `M_post` from a physical forward model built on **real**
digitized film dye spectral densities, so Mode B performs genuine cross-channel dye unmixing
and diverges from Mode C (today they are identical because `M_post = identity`). This is the
project's core "more scientific than NLP" differentiator.

Scope: **`M_post` only** (keep `M_pre = identity`). Closed-form linear least squares — no
optimizer dependency. `M_pre` and per-camera sensor fitting are explicitly later.

## Theory

Forward model (discretized form of the project's spectral equation, 380–730nm @ 5nm):

```
D(λ)  = D_min(λ) + Σ_{j∈{C,M,Y}} c_j · D_j(λ)        # Beer-Lambert: density linear in conc.
I_i   = Σ_λ  L(λ) · S_i(λ) · 10^(−D(λ))               # sensor readout, channel i∈{R,G,B}
base_i = I_i at c=(0,0,0)                              # clear-film response (D = D_min)
```

Inversion fit: with `density_i = −log10(I_i / base_i)`, solve for the 3×3 `M_post` minimizing
recovery error of the **known** concentrations over a patch set:

```
min_{M_post}  Σ_patches  ‖ M_post · density(patch) − c(patch) ‖²
```

Because real dyes have overlapping/secondary absorptions, `density` mixes the three
concentrations; `M_post` unmixes them. If the dyes were perfectly separated, `M_post` would be
diagonal and B would still equal C — so realistic overlap in the dye data is essential (real
datasheet curves provide it).

## Data sources & licensing

Bundled under `crates/film-core/data/`, each converted to a simple CSV we own, with a
`data/DATA_SOURCES.md` recording origin + license + attribution:

| Data | Source | License | Notes |
|------|--------|---------|-------|
| Dye spectral densities `D_j(λ)`, `D_min` for **Portra 400** + **Fuji C200** | `spectral_film_lut` (github JanLohse) | **MIT** | digitized from Kodak/Fuji datasheets; commercial-safe with attribution |
| Illuminant `L(λ)` = **D55** | `colour-science` (`SDS_ILLUMINANTS['D55']`) | BSD-3 | numeric values only |
| Sensor `S_i(λ)` = **representative analytic Gaussian RGB** | defined by us (below) | n/a | open; per-camera SS fitting is future work |

We deliberately do NOT use the Jiang 2013 camera-SS DB (CC BY-NC-SA, non-commercial; no
Fujifilm body). The generic Gaussian sensor is acknowledged as approximate — it captures the
dominant **dye** crosstalk structure; per-camera fitting later refines the sensor term.

**Representative sensor model** (analytic, 380–730nm): three Gaussians approximating a typical
camera, normalized to unit peak —
- R: center 600nm, σ 30nm
- G: center 540nm, σ 30nm
- B: center 460nm, σ 30nm
(Camera-like: narrower and less-overlapping than CIE CMFs. Parameters live in one place,
swappable for a fitted real SS later.)

## Architecture / new units

```
crates/film-core/
├── data/
│   ├── DATA_SOURCES.md
│   ├── dye_portra400.csv      # wavelength, D_C, D_M, D_Y, D_min   (one row per 5nm)
│   ├── dye_fujic200.csv
│   └── illuminant_d55.csv     # wavelength, power
└── src/
    ├── spectral.rs            # NEW: load curves; sensor model; forward model
    └── calibrate.rs           # EXTEND: fit_m_post()
```

- **`spectral.rs`** (one clear job: the physical forward model):
  - `struct SpectralData { wavelengths: Vec<f32>, dye: [Vec<f32>;3], d_min: Vec<f32>, illuminant: Vec<f32>, sensor: [Vec<f32>;3] }`
  - `fn load_stock(stock: Stock) -> SpectralData` — reads the bundled CSVs (dye + d_min per
    stock) + shared D55 illuminant; builds the analytic Gaussian sensor on the same grid.
  - `enum Stock { Portra400, FujiC200 }`
  - `fn simulate(&self, c: [f32;3]) -> [f32;3]` — the forward model → sensor RGB.
  - `fn base(&self) -> [f32;3]` — `simulate([0,0,0])`.
- **`calibrate::fit_m_post`**:
  - `fn fit_m_post(data: &SpectralData) -> nalgebra::Matrix3<f32>`
  - Build patch grid `c_j ∈ {0,0.4,0.8,1.2,1.6,2.0}³` (216 patches); for each, `simulate` → RGB
    → `density = −log10(I/base)`. Stack `D` (216×3) and `C` (216×3); solve
    `M_post = (DᵀD)⁻¹ Dᵀ C` then transpose appropriately (via nalgebra SVD lstsq).

## Integration into the engine / CLI

- `engine::InversionParams` already has `m_post`. No struct change.
- New helper `engine::params_for_stock(stock, base, exposure, black, gamma) -> InversionParams`
  that sets `m_post = fit_m_post(&load_stock(stock))` (and `m_pre = identity`).
- CLI: `--stock <portra400|fujic200|none>` (default `none` = identity = current behavior).
  When set, Mode B uses the fitted `M_post`. Mode C/naive ignore it.

## Testing / validation

- **Round-trip generalization (the core proof):** fit `M_post` on the 216-patch grid; evaluate
  on a **held-out** offset grid (e.g. `c_j ∈ {0.2,0.6,1.0,1.4,1.8}³`, none shared with the fit
  set). Assert **RMS ΔC < tolerance** (target ≈ 0.1, mirroring the paper's Table 1). Proves the
  matrix generalizes, not memorizes.
- **Non-triviality:** assert the fitted `M_post` has significant off-diagonal terms (e.g. max
  off-diagonal magnitude > 0.1) and that B-output ≠ C-output on a mixed patch — proving there
  was real crosstalk corrected.
- **Loader tests:** CSV parsing yields expected grid length and monotonic wavelengths.
- **Real-file check (manual):** re-run the V600 color frame with `--stock portra400`; record
  B-vs-C divergence and neutrality in `poc-findings.md`.

## Out of scope (next steps)

`M_pre` fitting; per-camera sensor-SS fitting from a ColorChecker; IT8 physical-target path;
additional stocks; mapping recovered concentration → display color management (XYZ/sRGB via
CMFs); AI features. The `SpectralData.sensor` field is the seam for per-camera SS.

## Assumptions to verify

1. `spectral_film_lut` dye curves for Portra 400 / Fuji C200 are usable as `D_j(λ)` + `D_min`
   over ~380–730nm; gaps interpolated onto the 5nm grid. (Confirm on data conversion.)
2. The generic Gaussian sensor yields a non-trivial, well-conditioned `M_post` (if the fit is
   near-identity, revisit sensor/dye overlap before claiming the differentiator works).
3. Applying a CMF/Gaussian-fitted `M_post` to real camera-native RGB is approximate; the real
   gain is validated by the held-out RMS ΔC, with the real-file check as a qualitative sanity
   pass only.
