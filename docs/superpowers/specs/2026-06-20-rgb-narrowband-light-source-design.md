# RGB Narrowband Light-Source Support — design

**Date:** 2026-06-20
**Status:** design approved in brainstorming; implementation of the *correction values* gated on real vendor scans.
**Scope:** A + B (single-shot RGB-lit scans + per-vendor wavelength preset). C (three-light synthesis) and D (hardware capture) are explicitly out of scope.

---

## 1. Motivation

Hardware vendors (e.g. **FILMSCIENCE**) and makers (e.g. "我是一只凯文猫") are shipping **narrowband RGB LED** light sources for camera-scanning color negatives. FILMSCIENCE asked whether OpenEnlarge can do clean orange-mask removal (**去色罩**) for their light source, and provided their LED peaks:

- **Red:** 660–665 nm
- **Green:** 520–525 nm
- **Blue:** 445–450 nm

They noted peak wavelengths **differ by manufacturer**, and asked whether we calibrate per wavelength.

### Why narrowband light helps (physics)

A color negative has three dye layers (C/M/Y) with **overlapping** spectral absorptions, plus an integral **orange mask**. Under broadband white light through a Bayer camera, each channel reads a *broad integral* that mixes all three dyes → crosstalk. Narrowband illumination at ~660/520/445 nm (near each dye's absorption peak, where the others contribute least) means the only light passing through the negative is in three narrow bands, so each channel reading is *dominated by one dye* → cleaner separation, cleaner 去色罩, more saturation, less per-frame guesswork.

**The optical benefit is baked into the RAW at capture time.** Software's job is to (a) not throw it away, and (b) model it correctly. It is not software's job to *create* the separation.

---

## 2. Key insight: the current engine is already well-matched to narrowband

The current inversion engine (`crates/film-core/src/engine.rs::invert_d`) is **matrix-free**:

1. per-channel base division: `log_dens = log10(clamped / base[c])` (orange-mask removal),
2. Cineon tone: `corrected = log_dens / eff_d_max`; `print_lin = (1 + paper_black) − 10^corrected`,
3. linear per-channel **WB gain**: `out = (print_lin · wb[c])^paper_grade`.

There is **no cross-channel unmix matrix in effect.** `InversionParams.m_post` exists in the struct and is threaded to the GPU shader, but it is **always identity** — nothing populates it from `stock`. The `stock` field (`none|portra400|…`) is **vestigial**: `build_params` documents `stock`/`mode`/`black`/`gamma` as "kept in the wire contract for back-compat, no longer read"; `stock` survives only as a WB-reseed cache key. The per-stock unmix-matrix path was removed in an earlier revert.

The cross-channel matrix existed to correct **dye crosstalk under broadband white light**. **Narrowband RGB light removes that crosstalk in hardware** — it does optically what the matrix tried to do in software. Therefore the current matrix-free engine is arguably *better* matched to narrowband scans than to white-light scans.

**Consequence:** we do **not** speculatively resurrect the dead `m_post` machinery. We expect the existing per-channel base + WB pipeline to already produce clean 去色罩 on narrowband files, and we let real files decide whether *any* further correction is warranted.

---

## 3. Design

### 3.1 Light source as a new axis (separate from film stock)

Conceptually: **stock = which dyes; light source = what illuminated them.** A scan is `(stock, light_source)`. These are orthogonal (any stock can be shot under any light), so light source is its own axis rather than a stock entry.

We introduce a **`light_source`** selector. Values:

- **`white`** (default) — today's behavior, identity correction. **Zero regression risk** for existing users.
- **`rgb_narrowband`** — the first narrowband preset (FILMSCIENCE).

Future vendors with different peaks = additional entries, same machinery.

### 3.2 Part A — engine: likely little or no change

Under narrowband light the orange-mask base simply has a different R:G:B ratio; the existing per-channel `base[c]` division still removes it, and the linear WB gain still balances it. So Part A is expected to be **"confirm the current engine already does clean 去色罩 on narrowband files,"** not "add new math."

Any engine change is **contingent on measured residual error** (§3.4) and, if needed, chosen in the least-invasive order in §3.5. If a change is made, **CPU/GPU parity is mandatory** (`engine.rs` ↔ `app/src/lib/viewport/gl/shaders.ts` `INVERT_FRAG`, via `gpu_upload.rs::resolve_to_uniforms`).

### 3.3 Part B — a preset whose *form is decided by the data*

A light-source preset is a small record:

```
LightSourcePreset {
  id:        string        // "white" | "rgb_narrowband"
  label:     string        // i18n key
  peaks_nm:  [R, G, B]     // e.g. [662, 522, 447]; provenance/debug + future C
  correction: Correction   // None for `white`; TBD for narrowband (see §3.5)
  notes:     string
}
```

`peaks_nm` is metadata for provenance and future three-light synthesis; it does **not** drive pixel math in A+B (the per-channel base division is wavelength-agnostic in effect). The `correction` is filled from measurement (§3.4), not guessed.

### 3.4 Measurement harness (the calibration procedure)

Run **once per vendor**, when files arrive. Inputs requested from the vendor (see §6):

1. **Flat-field / clear-base shot** → verify base behavior under their light; characterize the LED.
2. **Gray-card / color-checker frame** (through the rig) → the known neutral against which residual error is measured.
3. **2–3 rolls across different stocks, varied scenes** → multi-roll validation (anti-overfit).

Procedure:

1. Run the vendor's files through the **current (unmodified) engine** with auto base + WB.
2. **Measure residual error:** how far the gray card lands from neutral after auto-WB; any systematic cross-channel contamination; consistency across rolls/stocks.
3. If residual error is negligible → `correction = None`; the narrowband preset ships as essentially "white + correct base/WB defaults." Done.
4. If residual error is meaningful → add the **least-invasive** correction that removes it (§3.5), then re-validate across all rolls.

### 3.5 Correction priority order (least invasive first)

Only if §3.4 shows a need, and chosen in this order:

1. **Fixed WB seed / per-channel linear gain** baked into the preset.
2. **Per-channel black / offset** tweak.
3. **Last resort:** re-enable a *gentle, near-identity* `m_post` (the field still exists end-to-end CPU↔GPU) — only if base+WB provably cannot reach neutral. Any matrix is validated across all rolls before shipping.

This ordering keeps us aligned with the engine's current matrix-free philosophy and avoids reintroducing the abandoned per-stock-matrix complexity unless the data forces it.

### 3.6 UI

A **Light source** picker alongside the existing develop controls (Basic.svelte / confirm-develop). Default = "White / standard." New entry: "RGB narrowband (FILMSCIENCE)." Labels added via **`i18n-strings.csv` → `scripts/gen-i18n.py`** — never edit `dict.ts` directly (regeneration wipes hand-added keys).

The selection persists per image/roll like other develop params and mirrors to the roll via the existing copy/apply machinery (add `light_source` to the copied-key lists in `copySettings.ts` / `roll/apply.ts`).

### 3.7 Camera-agnostic by design

Presets are keyed on the **light source (wavelengths), not the camera.** Under narrowband light, camera-to-camera variation collapses to the sensor response at three wavelengths (second-order), and two pipeline steps absorb it: **per-roll base sampling** (self-calibrates Dmin per scan/camera) and the **neutral/WB step**. So one `rgb_narrowband` preset works across users' different color-CMOS bodies. Camera identity is debug metadata only (carried in the RAW for free). Distinct presets are warranted only for wildly different sensors (mono, heavy IR-cut differences) — that is C/edge-case territory.

---

## 4. Validation gate (lesson from `INVERSION-RESEARCH-HANDOFF.md`)

A previous "physically correct" rework was tuned to one blue-dominated frame, regressed the whole library, and was reverted. **No shipping on one frame.**

- **Buildable before files arrive:** the light-source axis (wire field + UI + `white` default + `rgb_narrowband` entry with `correction = None`). This is pure plumbing and cannot regress existing users (default unchanged).
- **Blocked on files:** the narrowband `correction` values — they stay a TODO until measured against the flat-field + gray-card + multi-roll set and validated across **all** provided rolls.

---

## 5. Out of scope

- **C — three-light-source synthesis (三光源合成):** merge three per-color exposures into one negative. Future phase; reuses this preset's color math, swaps the ingest. Pays off mainly with a **monochrome sensor** + a **synced LED controller** (couples to D). Not built here.
- **D — hardware capture automation:** Sony SDK tethering, UART/SPI auto-advance, whole-roll auto-shoot. Separate hardware/partnership track.
- **Export speed:** Kevin-cat's 25-min/roll export complaint is real but a separate performance issue, not this spec.

---

## 6. Vendor data request (paste to FILMSCIENCE / Kevin-cat)

1. **RAW files** (not JPEG/TIFF) — several frames across **2–3 rolls/stocks**, **varied scenes** (not all one dominant color). ~6–10 frames to start.
2. **Flat-field shot** — the RGB light source with **no film**, plus a frame of **clear unexposed film base / roll leader**.
3. **LED data sheet** — peak wavelengths plus, if available, spectral width (FWHM) and relative R/G/B intensity. (Peaks already given: 660–665 / 520–525 / 445–450.)
4. *Nice to have:* one frame with a **gray card / color checker** in front of the light (no film) to validate WB/unmix.

(The camera body is **not** required — it's carried in the RAW metadata and the design is camera-agnostic.)

---

## 7. Open questions

- None blocking. The single unknown — *does narrowband need any correction beyond base + WB?* — is answered by §3.4 once files arrive, and the design handles both outcomes.
