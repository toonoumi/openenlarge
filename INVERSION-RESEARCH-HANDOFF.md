# Color-negative inversion — research & rebuild handoff

**Status:** the engine is back at the ORIGINAL behavior (all of this session's rework was
reverted). We are deciding on a *new, well-grounded* inversion pipeline before touching code
again. A `deep-research` report on the best algorithms is being generated (see "Deep research"
section — fill in when it lands).

**Goal:** a simple, fast color-negative → positive conversion that looks natural across many
rolls **without per-frame tuning**, validated on MORE than one scan before shipping.

---

## 0. Hard constraints / lessons from this session (READ FIRST)

- **Do NOT overfit to one frame.** This session built a "physically correct" power-law + auto-WB
  rework that looked great on ONE blue-dominated test frame, then regressed the user's whole
  library (too dark, "coffee" warm cast, slow develop). It was fully reverted. **Validate any new
  approach across several real rolls before committing.**
- **CPU and GPU must stay in parity.** Inversion runs in two places that must match:
  - CPU: `crates/film-core/src/engine.rs` (`tone`, `invert_b`, `invert_c`).
  - GPU (live viewport + export): `app/src/lib/viewport/gl/shaders.ts` (`INVERT_FRAG`'s `tone()`),
    fed by `app/src-tauri/src/gpu_upload.rs::resolve_to_uniforms` → `ResolvedInversion` →
    `invert.ts`/`renderer.ts` uniforms. Any param added to the engine must be threaded to the shader.
- **Preserve the user's concurrent WIP.** The working tree has uncommitted WIP from the user in
  `commands.rs`, `convert.rs`, `cache.rs`, `catalog.rs`, `encode.rs`, `exif_write.rs`,
  `metadata.rs`, `session.rs`, `tether.rs`. Do not `git checkout` those wholesale; edit surgically.
- **Develop-time cost matters.** Adding a full-image sort at develop (we added `sample_dmax`)
  noticeably slowed develop. Sampling already does one pass in `sample_base`; piggyback, don't add
  passes.

---

## 1. The scan we're working with (measured facts)

Test file: `/Volumes/Disk2/Film Scans/ny2026-3/Image 4 (3).dng` (USPS mailbox + banana on asphalt).
Decoded via `rawler`; metadata dumped this session:

- **Source:** EPSON Perfection V600 flatbed, saved as a **`LinearRaw` DNG**.
- **Linear:** `photometric=LinearRaw`, black level 0, white 65535 → genuinely linear data.
- **Color space:** the embedded `ColorMatrix[D65]` is the **standard XYZ→sRGB matrix**
  `[3.24 -1.54 -0.50; -0.97 1.88 0.04; 0.06 -0.20 1.06]`, and `wb_coeffs=[1,1,1]`. So the scanner
  data is already in **linear sRGB primaries** — there is **no camera profile to apply** (this was
  a red herring we chased; `cam_to_xyz` is NaN/absent for this file).
- **Orange mask base** (`sample_base`, 95th pct per channel) ≈ `[0.433, 0.194, 0.111]` (R>G>B,
  plausible orange mask). Corners agree → base sampling is robust on this frame.
- The frame is **blue-dominated** (blue USPS mailbox + a blue-leaning ground), which is exactly the
  hard case for any per-image auto white balance.

`decode_raw` deliberately skips WhiteBalance, the color matrix, and gamma — output is
linear camera/scanner-native RGB (here ≈ linear sRGB). See `crates/film-core/src/decode.rs`.

---

## 2. Current (reverted, original) pipeline

`crates/film-core/src/engine.rs`:
- `invert_b` (Mode B, the product path): `r = clamp(rgb/base, EPS, 1)` → `m_pre·r` (identity by
  default) → `density = -log10(...)` → `m_post·density` (identity for "no preset") → `tone`.
- `tone(density)` = `(density · exposure · wb − black)^gamma`, `gamma≈1/2.2`. **This raises DENSITY
  to a power — it is NOT a physical film inverse, and gives flat/washed ("too gray") tone.** This
  is the user's original complaint.
- No-preset = identity `m_post`. Named stocks (Portra etc.) fit a density-unmix matrix from spectral
  data (`spectral.rs`, `fit_m_post`, `balance_neutral`).

White balance: `as_shot_wb` inverts the thumb, runs **gray-world** `auto_wb_gains` (chromatic-pixel
rejection, damped 0.7), converts to (temp,tint) via `gains_to_cct`, seeds the Temp/Tint sliders;
render applies `wb_from_kelvin(temp,tint)` as `wb` (a per-channel gain) **inside `tone` (density
space)**.

Known quirks discovered this session:
- WB is applied in **density** space (`density·wb`), not linear light — multiplying density then
  `^gamma` is a power, not a linear gain. Suspect but unverified whether this matters perceptually.
- `auto_wb_gains` computes gains on the **gamma-encoded** positive but the gray-world assumption +
  damping make it gentle; `gains_to_cct`'s tint = `(1-gains[1])/0.5` conflates gray-normalization
  with the green/magenta axis (a real but small bug; a scale-invariant fix exists).
- A blackbody **(temp,tint) cannot represent strong per-channel gains** (e.g. R/B≈8.7) — they clamp
  at the 15000K search ceiling. So any auto-WB that needs strong correction must be applied as a
  **direct per-channel gain**, not round-tripped through temp/tint.

---

## 3. What we tried this session and why it failed (so you don't repeat it)

1. **Generic `m_post` for no-preset** (mean of all stock matrices) to fix "too gray" — added
   saturation but didn't address tone; reverted.
2. **Per-channel density-range WB** (`mean(Dmax_c)/Dmax_c`, the "standard" black+white-point
   equalization) — **desaturates dominant colors**: on this frame it crushed the blue mailbox to
   gray, because blue's Dmax is inflated *by the mailbox itself*. Per-channel white anchors are
   unsafe on color-dominated scenes.
3. **Power-law tone** `scene = 10^(contrast·(density − dmax))` with a global `dmax` anchor +
   `contrast=1.4` — physically correct, good contrast/depth on the test frame, but **too dark**
   across the library (the global anchor is a high percentile few pixels reach → midtones dark).
4. **Gray-edge auto WB** (achromatic-edge hypothesis) — genuinely robust to dominant colors (a flat
   object has no edges), the most promising WB idea. But at full strength it over-corrects
   (mailbox→gray); damped ~0.5–0.6 it preserved the blue. It must be applied in **linear** light and
   **directly** (not via temp/tint). Across the library it skewed "coffee"/warm → reverted.

Net: the *ideas* (Cineon-style tone, gray-edge WB) are sound in principle but our parameterization
(global dmax, contrast, damping) was tuned to one frame and didn't generalize. The next attempt
needs principled defaults + multi-roll validation.

---

## 4. How the reference tools do it (from their sites)

**NegBase** (`negbase.com`): **Cineon-based** film inversion. Two anchor points: **Dmin (film base
= black point)** and **Dmax (a neutral high-density area)**. 32-bit float, fully color-managed
preview, scopes (RGB parade/waveform/vectorscope). Auto OR manual anchor selection. Built-in
**print-film LUT** + custom LUTs. Post: exposure/contrast + **printer lights** + manual Dmin/Dmax.
→ The classic motion-picture pipeline: log/density inversion anchored on two points, then a print
emulation. Printer-lights = per-channel exposure offsets in log/printing-density space.

**Filmomat SmartConvert** (`filmomat.eu/smartconvert`): philosophy "preserve the essence of film,
**no LUTs, no effects, no Look emulation**." Three WB ways: **automatic white balance (default)**,
CMY manual buttons, or **click a neutral gray point**. **Flat-field correction** (shoot the light
source without film → removes vignette). AutoCrop. RAW/TIFF in (no JPG). → Emphasis on a clean
automatic neutral conversion + a manual gray-point escape hatch, no stock profiles.

Common threads worth adopting: (a) **two-anchor Dmin/Dmax** in density/log space is the
industry-standard inversion; (b) a **robust automatic** color step + a **manual gray-point** fallback;
(c) Filmomat's flat-field idea is orthogonal but nice for flatbed vignetting.

---

## 5. Deep research — recommended pipeline (CONFIRMED, cited)

Deep-research finished (23/25 claims verified 3-0). The field converges on the **Cineon
densitometry model**, and the **canonical open reference is darktable's `negadoctor`** — port its
exact math. NamiColor + Filmeon corroborate the log/density approach; NLP is look-emulation (scanner
profiles), less portable.

### 5a. The negadoctor (Kodak Cineon) inversion + print pipeline — EXACT math to port

Source of truth: `darktable/src/iop/negadoctor.c` + the dtdocs negadoctor page. Per pixel, per
channel `c`, with `Dmin[c]` = per-channel film base (orange mask), `D_max` = single scalar film
dynamic-range/white anchor:

```
1. clamped[c]      = max(linear_in[c], THRESHOLD)            # input is LINEAR transmittance
2. density[c]      = Dmin[c] / clamped[c]                    # per-channel mask removal, in LINEAR
3. log_density[c]  = -log10(density[c]) = log10(clamped[c]/Dmin[c])   # into density/log space
4. corrected[c]    = wb_high[c] * log_density[c] + offset[c] # per-channel CDL slope+offset (WB+black)
                       where wb_high[c] = WB_high_param[c] / D_max
                             offset[c]  = WB_high_param[c] * paper_black_offset * WB_low[c]
5. print_linear[c] = exposure[c] * 10^(corrected[c]) ... then paper emulation (ASC-CDL SOP):
   RGB_out[c]      = ( print_in[c] * print_exposure + paper_black )^paper_grade   # slope/offset/power
6. encode to display (sRGB / gamma) LAST.
```

Mapping to ASC-CDL: **print exposure = slope, paper black = offset, paper grade (gamma) = power.**
Constants: `LOG2_to_LOG10 = 0.3010299957`. **Two anchors only:** per-channel `Dmin` (R/G/B), single
`D_max`. WB lives as a **per-channel slope+offset in LOG space** (step 4) — this is the principled
place to balance, NOT a linear gain on the positive (which is what we wrongly tried).

Why this beats our reverted `density^gamma`: it converts density back to **linear print exposure**
(`10^`) and applies a real **paper tone curve** (exposure·x + black)^grade with highlight soft-clip,
instead of raising raw density to a display gamma (which flattened/grayed the tone).

### 5b. Robust automatic white balance — unified Minkowski / Gray-Edge framework

Sources: Finlayson & Trezzi "Shades of Gray and Colour Constancy" (CIC 2004); van de Weijer & Gevers
"Edge-Based Color Constancy" (TIP 2007); reference impl `general_cc.m`.

- **One parameterized estimator** covers Gray-World, Max-RGB, Shades-of-Gray, and Gray-Edge via 3
  params: differentiation order `n` (0=pixels, 1–2=edges), Minkowski norm `p`, Gaussian scale `σ`.
  - `n=0, p=1` → Gray-World; `n=0, p=∞` → Max-RGB; `n=0, p=6` → **Shades-of-Gray (best pixel-based)**;
  - `n=1` → **Gray-Edge (best overall, ~40% better than Max-RGB, resists dominant scene colors)**.
- **Gray-Edge resists dominant colors** because it averages color *derivatives* (edges), and "the
  average reflectance difference in a scene is achromatic" — a large flat blue object contributes no
  edges, so it can't bias the estimate. This is exactly our failure mode (blue mailbox). This session's
  hand-rolled gray-edge confirmed the intuition; the principled version adds the Minkowski `p` and a
  Gaussian-derivative `σ` (paper uses σ=3, tunable).
- **Apply the AWB as the per-channel `wb_high`/`offset` in negadoctor step 4 (log space)** — that's
  where negadoctor already puts WB. Open question whether to estimate before/after print emulation.

### 5c. Sources (primary, verified)

- negadoctor code: `https://raw.githubusercontent.com/darktable-org/darktable/master/src/iop/negadoctor.c`
- negadoctor docs: `https://docs.darktable.org/usermanual/4.8/en/module-reference/processing-modules/negadoctor/`
- NamiColor (density-domain rationale): `https://github.com/Wavechaser/NamiColor`
- Filmeon (Cineon anchors, γ=0.6, white D=1.18 / Pines mid-grey D=0.7→0.18): `https://github.com/helios1138/filmeon`
- Shades-of-Gray (p=6): `https://library.imaging.org/cic/articles/12/1/art00008`
- Gray-Edge / unified framework: `https://staff.science.uva.nl/th.gevers/pub/GeversTIP07.pdf`, `https://lear.inrialpes.fr/people/vandeweijer/papers/cr2542.pdf`
- general_cc.m (one routine, all AWB methods): `https://github.com/lynnprosper/Edge-Based-Color-Constancy/blob/master/general_cc.m`
- NLP color models / WB presets: `https://www.negativelabpro.com/guide/basics/`

### 5d. Open questions from the research (decide before/while implementing)

1. **D_max**: what value / auto-estimation for typical C-41 on the V600 — sample per-roll (like Dmin)
   or fix a sane constant? (Research recommends per-roll, matching the project's base-calibration-per-roll memory.)
2. **Where to run AWB**: linear scene-referred (after print emulation) vs log/density (step 4)? Test
   which is more natural across rolls.
3. **Default paper params** (print exposure / paper black / paper grade) for a pleasing out-of-box
   lab-print look — negadoctor ships these as sliders, not fixed defaults. Filmeon's classic Cineon
   anchors (γ≈0.6, film white at D≈1.18 above Dmin → E=1.0; Pines mid-grey D=0.7→0.18) are a starting point.
4. **Auto Dmin/rebate detection** on a flatbed scan, for hands-off per-roll base calibration.

---

## 6. Recommended implementation plan (CONFIRMED — port negadoctor, see §5a/§5b)

The research confirmed this shape. Concrete plan:
- **Port negadoctor's exact math (§5a)** into `engine.rs` `tone`/`invert_*` and mirror in
  `shaders.ts`. New `InversionParams` fields: per-channel `dmin` (already have as `base`), scalar
  `d_max`, per-channel `wb_high`/`wb_low`, `paper_black`, `print_exposure`, `paper_grade`. Thread
  `d_max` (+ any per-roll calibration) through `Developed` like `base`.
- **AWB (§5b):** implement the unified Minkowski/Gray-Edge estimator (start `n=1` gray-edge OR `p=6`
  shades-of-gray), feed it into the per-channel log-space `wb_high`/`offset`. Keep a **manual
  gray-point picker** as the reliable fallback (both NegBase and Filmomat have one).
- **Validate on ≥3–4 real rolls** before merging. Use the visual harness (decode → invert → PNG →
  look), not region stats.
- Keep CPU/GPU in parity and develop-time sampling cheap (piggyback on `sample_base`'s pass).

Original (pre-research) hypothesis, now subsumed by §5a:
1. Work in **linear** scan values (we already have linear sRGB).
2. **Per-channel Dmin** = film base (have it via `sample_base`).
3. Convert to **density**: `D_c = log10(base_c / rgb_c)` (orange mask removed per channel).
4. **Two-anchor normalize in density** with a **single global Dmax** for the white end (NOT
   per-channel — per-channel desaturates dominant colors), giving a per-channel-neutral density
   span. Printer-lights = small per-channel density **offsets** for color balance (this is the
   robust place to balance, vs a linear gain).
5. **Back to linear / print** and apply an **output tone curve** (film-gamma + display sRGB) —
   negadoctor uses paper black + print exposure + a power (grade). Pick a single sane film gamma.
6. **Robust auto color**: gray-point if the user clicks one; else a dominant-color-resistant auto
   (gray-edge or shades-of-gray p≈6) applied as **per-channel density offsets** (printer lights),
   **damped**, with the Temp/Tint sliders as fine-tune. Provide a manual **gray-point picker** as
   the reliable escape hatch (both NegBase and Filmomat offer this).
7. Keep it cheap: piggyback all sampling on the existing develop pass; no extra full-image sorts.

**Open decisions for the user:** how much "look"/print emulation vs neutral (Filmomat = neutral,
NegBase = print LUT); whether to add a manual gray-point picker UI; default film gamma/contrast.

---

## 7. Where things live (code map)

- `crates/film-core/src/engine.rs` — `InversionParams`, `tone`, `invert_b/c/naive`, `params_for_stock`.
- `crates/film-core/src/calibrate.rs` — `sample_base` (Dmin), `auto_wb_gains` (gray-world),
  `fit_m_post`/`balance_neutral`. (Also leftover-but-unused `generic_m_post`, `wb_from_density_range`
  committed in `4d145f5` — harmless; remove in a cleanup if desired.)
- `crates/film-core/src/decode.rs` — raw/tiff/ldr decode (linear, no color matrix).
- `crates/film-core/src/spectral.rs` — per-stock dye model for `m_post`.
- `app/src-tauri/src/commands.rs` — `build_params`, `resolve_params`, `as_shot_wb`, develop flow
  (`develop_image`/`ensure_resident` build `Developed{working,thumb,base}`).
- `app/src-tauri/src/gpu_upload.rs` — `ResolvedInversion`, `resolve_to_uniforms` (CPU↔GPU bridge).
- `app/src/lib/viewport/gl/shaders.ts` — GPU `INVERT_FRAG` (must mirror `engine.rs` tone math).
- `app/src/lib/develop/Basic.svelte` — seeds Temp/Tint from `as_shot_wb`; "Auto WB" button.

## 8. Verification commands

- `cargo test -p film-core` and `cargo test --manifest-path app/src-tauri/Cargo.toml`
- `cargo build --manifest-path app/src-tauri/Cargo.toml`
- Frontend: `cd app && npx vitest run src/lib/viewport/gl/ && npm run check` (expect 0 errors)
- Visual: decode the test DNG, run the candidate pipeline, write a PNG, and LOOK (region stats lie;
  e.g. our "asphalt" region was actually the blue mailbox). Validate on **multiple** rolls.
