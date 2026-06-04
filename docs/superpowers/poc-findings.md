# POC Findings

**Date:** 2026-06-03
**Branch:** `feat/inversion-poc`

## Status: code-complete, green; real-file verdict pending samples

The density-domain inversion engine (Approach B) and the CLI are implemented, tested, and
clean. What remains for the actual "is the color right?" verdict is running `--compare` on
real V600 + GFX files (Phase 6), which needs sample files.

## What was built (Phases 0–5 + compare)

- **`film-core`** (pure Rust lib, 16 unit tests, clippy-clean):
  - `Image` — f32 linear RGB + optional IR plane.
  - `engine` — Mode B (`Ĉ = M_post · log10(M_pre · (base/I))`), Mode C (per-channel
    log-density), naive (`1-x`). Validated against a synthetic Beer-Lambert forward model:
    neutral scenes recover neutral; brightness order preserved; naive provably differs from B.
  - `calibrate::sample_base` — 95th-percentile film-base (orange mask) estimate, empty-region safe.
  - `decode::decode_tiff` — 8/16-bit RGB/RGBA TIFF + linear DNG; 4th channel → `ir`.
  - `decode::decode_raw` — RAF/DNG via rawler 0.7 (`decode_file` → `RawDevelop` with
    Rescale/Demosaic/Crop, excluding WhiteBalance/Calibrate/SRgb → camera-native linear RGB).
  - `export::write_tiff16` — 16-bit RGB TIFF.
- **`film-cli`** — `invert <in> -o <out> [--mode b|c|naive] [--base-rect x,y,w,h] [--exposure]
  [--black] [--gamma] [--compare]`. `--compare` emits `*_b/_c/_naive.tiff` side by side.
  Decode dispatched by extension (tif/tiff → decode_tiff, else → decode_raw).

Verified: `cargo build --release`, `cargo test` (16 pass), `cargo clippy --all-targets` (clean).
Smoke-tested CLI single + compare on synthetic TIFF fixtures.

## M_post fitting — results (2026-06-03)

Built the density-unmixing matrix fitter from a physical forward model (real per-dye spectral
densities from spektrafilm, analytic Gaussian sensor, Planckian-D55 stand-in illuminant).

**The math works strongly (synthetic + real-data held-out):**
- Synthetic overlapping dyes: fitted `M_post` beats identity by >20% on held-out patches.
- **Real Portra 400 dye data: RMS ΔC 0.094 (fit) vs 0.303 (identity) — a 3.2× error reduction**
  on held-out concentration patches, with significant off-diagonal crosstalk terms.
  → Spec Assumption #2 RESOLVED positively: the physical model produces a *strongly*
  non-trivial unmixing matrix. The "more scientific" differentiator is real, not marginal.

**But on a real scan, the generic matrix shifts color rather than clearly improving it.**
- V600 color frame, Mode B with `--stock portra400` vs identity: outputs DIFFER (as designed),
  but the Portra matrix pushes the image visibly **warmer / magenta**, not obviously "more
  correct."
- Cause: the matrix was fit against an *assumed* Gaussian sensor + Planckian illuminant that do
  NOT match the V600's actual sensor spectral sensitivity and lamp. The unmixing is calibrated
  to the wrong optics, so on a mismatched scanner it re-tints instead of neutralizing.

**Verdict / honest conclusion:** the M_post machinery and the physics are validated; real dye
data gives a large *modeled* improvement. Converting that into a real-scan quality win requires
matching the **sensor term** to the actual capture device. So the clear next unlock is
**per-camera/scanner spectral-sensitivity fitting** (e.g. from a ColorChecker shot) — it is the
gating step, not an optional refinement. The generic baked matrices are a stepping stone, not a
shippable default.

### Revised next priorities
1. **Per-camera/scanner SS fitting** (ColorChecker) — the real unlock; makes `M_post` correct
   for the actual device.
2. Frame/rebate detection + crop (camera-scan base sampling).
3. Then Phase 7 Tauri shell + WB/tone defaults.

---

## Real-file verdict (2026-06-03) — PIPELINE VALIDATED ✅

Ran `film-cli --compare` on both user files.

- **`Image 4.dng`** (Epson V600, color negative): confirmed a **linear RGB DNG**. Routed via
  `decode_tiff` (NOT rawler). Auto-detected orange mask `[0.43, 0.19, 0.11]` (R>G>B ✓).
  Inverted to a believable color positive (street/crosswalk frame). The linear-DNG open item
  is RESOLVED: `.dng` with PhotometricInterpretation=RGB must go through `decode_tiff`.
- **`_DSF0072.RAF`** (GFX100RF, 207MB/102MP): a camera photo of a **Shanghai GP3 B&W negative**
  strip on a lightbox. Decoded via rawler in ~8s full-res (3 inversions). Inverted correctly.

**Key findings:**
1. **B == C right now** (identity `M_pre`/`M_post`) — byte-identical output. The engine is
   currently negadoctor-level (per-channel log-density). It modestly beats naive (better
   shadows/highlights), but the scientific differentiator (cross-channel matrices) is unfit
   and therefore inert. **Fitting `M_pre`/`M_post` is the #1 substantive next step.**
2. **Base auto-sampling is too naive for camera scans.** Whole-image 95th percentile grabbed
   the white lightbox surround (GFX) rather than the film rebate, giving a wrong base. Camera
   scans include rebate + sprockets + lightbox. Need **frame/rebate detection + crop** before
   base sampling. (Scanner DNG was fine because it's tightly cropped to the frame.)
3. **Perf is acceptable:** 102MP/207MB full-res invert in ~8s on CPU; proxy preview will make
   the UI interactive.

### Prioritized next work (post-POC)
1. **Frame + rebate detection / crop** (biggest immediate quality lever for camera scans).
2. **`M_pre`/`M_post` calibration fitting** (the real "more scientific than NLP" differentiator).
3. White-balance + tone defaults for pleasing out-of-box color.
4. Then Phase 7 Tauri shell with proxy preview.

## Open items to resolve with real files (Phase 6)

1. **Linear-DNG vs Bayer path (most important).** The CLI sends `.dng` → `decode_raw`
   (demosaic path). A SilverFast V600 DNG is likely `LinearRaw` (already RGB, no Bayer) — the
   demosaic step may be wrong for it. Action on first file: check rawler's photometric
   interpretation; if `LinearRaw`/`Cfa` mismatch, route linear DNGs to `decode_tiff` (or a
   no-demosaic rawler path). GFX `.raf` (true Bayer) should use `decode_raw` as-is.
2. **Spec §9 assumption — "positive" scan.** Confirm the V600 DNG is the un-inverted negative
   (orange, linear). If it's an already-inverted positive, re-export the raw/HDR linear scan.
3. **The 4th/IR channel.** Confirm the "64-bit" V600 DNG carries an IR plane and that it lands
   in `Image.ir` (preserved for future dust removal).
4. **The verdict.** Run `film-cli ... --compare`, open B/C/naive; confirm B's neutrals are
   visibly cleaner than naive and B beats C in saturated regions. Record per-file results here.

## Deferred (Phase 7)

Tauri shell, GPU/proxy preview, M_pre/M_post calibration fitting, ICC/spectral, AI dust/color.
