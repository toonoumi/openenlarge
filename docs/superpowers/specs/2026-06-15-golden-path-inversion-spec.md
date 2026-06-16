# Golden-Path Color-Negative Inversion — Design Spec

**Date:** 2026-06-15
**Status:** agreed design, ready to decompose into plans
**Supersedes the open questions in:** `INVERSION-RESEARCH-HANDOFF.md`, `HANDOFF-color-cast.md`

---

## 1. Decision (locked)

The inversion is settled science. We commit to **one inversion model** and **one golden path per capture method**, with **no per-image "look" customization** in the core color pipeline. The only manual escape hatch is a neutral gray-point picker (which the science itself endorses, because no automatic base sample is perfect).

**The one model: Kodak Cineon / darktable `negadoctor` density inversion** — already implemented as `Mode::D` (`invert_d`) in `crates/film-core/src/engine.rs:127` and mirrored in the GPU shader (`app/src/lib/viewport/gl/shaders.ts:227`).

Per channel `c`:
1. `clamped = max(I_c, THRESHOLD)`
2. `log_dens = log10(clamped / Dmin_c)`   ← orange-mask removal, per-channel
3. `corrected = log_dens / D_max`          ← single scalar dynamic-range anchor
4. `print_lin = max(print_exposure·(1+paper_black) − print_exposure·10^corrected, 0)`
5. `out = (print_lin · wb_c)^paper_grade`  ← WB is a gain on the positive (keeps black neutral)
6. highlight soft-clip above `soft_clip`

The rebate `Dmin` sample is simultaneously the orange-mask removal **and** the digitization-light neutralization — so "base" and the *roll-level* part of WB stop being two fighting systems.

### White balance is two layers (do not conflate them)

Film scanning has two distinct things people both call "white balance"; only the first is roll-bound:

1. **Mask + digitization-light neutralization — ROLL-BOUND.** The orange mask (Dmin) is fixed by emulsion + development, identical for every frame on the roll. The scanner lamp / camera light table is the same rig all roll. The rebate `Dmin` sample neutralizes both and is locked **once per roll**.
2. **Scene white balance (Temp/Tint) — PER-FRAME, weather-driven.** Color-negative film is daylight-balanced (~5500K); a frame shot at noon vs open shade vs tungsten recorded a genuinely different scene-illuminant cast — exactly like a digital raw. The mask is a separable dye layer, so after mask removal the per-frame scene cast remains and needs per-frame correction.

So per-frame Temp/Tint is **legitimate and must persist**. What we kill is not per-frame WB but the **reseed storm** — the auto estimate silently re-running and clobbering the user's deliberate per-frame choice when an unrelated control changes. Correct behavior: auto-**seed** the scene WB once (so the user starts near neutral), then it is sticky and freely adjustable, with the gray-point picker as the "make this in *this* scene neutral" tool.

## 2. What we remove (the "fighting" layers)

Current pipeline stacks four color-setting layers, each compensating for the previous one's error (see `HANDOFF-color-cast.md`). We delete three of them:

- ❌ **Film-stock dropdown + spectral `m_post` matrices** (`spectral.rs`, `params_for_stock`, `fit_m_post`, `balance_neutral`, `generic_m_post`). This is a "look", not a correctness layer; darktable/Filmomat do excellent conversions without it.
- ❌ **Density/Cineon engine toggle** and **Mode B / Mode C / Naive** inversion paths. Cineon wins; one engine.
- ❌ **Damped gray-world auto-WB that re-seeds on every action** (the reseed storm in `Basic.svelte` `seed()`), replaced by a robust estimate run **once per roll**.
- ❌ **Per-channel-independent 95th-percentile base** over scene content (`sample_base(&working, None)`). Replaced by a single coherent clear-film color sampled in the rebate/crop.

We keep:
- ✅ Cineon inversion (Mode D) as the sole engine.
- ✅ One neutral **gray-point picker** (`gray_point_wb`) as the manual override.
- ✅ The existing **crop tool** (`app/src/lib/crop/`) — but analysis must now respect it.
- ✅ Creative finishing (tone curve, color grading, color mixer, point color) — these are downstream of inversion and are not part of the "science" core.

## 3. The two golden paths

Both paths run the **identical** Cineon inversion. They differ only in how clean inputs are obtained.

### 3a. Scanner (Epson V600/V850, Hasselblad Flextight, Nikon Coolscan)

1. **Capture:** scan *as positive* (no driver invert), linear/RAW, 16-bit, all auto-enhance off. (Epson→linear-DNG already satisfies this.)
2. **Base once per roll:** sample `Dmin` from a thin clear-rebate sliver as **one coherent R/G/B color** (mean, not 3 independent percentiles). Lock for the whole roll.
3. **Auto-derive `D_max`** from the roll's densest neutral, once.
4. **Invert** (Cineon) using that base + `D_max`.
5. **WB layer 1 (roll):** the rebate already neutralized the mask + scanner light → locked per roll, nothing to auto-chase.
6. **WB layer 2 (per-frame):** scene Temp/Tint auto-seeded once, then sticky and adjustable per frame for frames shot under different light (shade/tungsten/sunset). Gray-point picker for in-scene neutrals.

→ Whole roll shares base + `D_max` (layer 1) → consistent *starting point* by construction. Per-frame scene WB rides on top.

### 3b. Camera scan (mirrorless/DSLR + macro + light table) — GitHub issue #1

Identical inversion. Deltas, all about getting a clean frame in:

1. **Capture:** RAW, high-CRI (≥95) ~5000–5500K light.
2. **Crop to the image area first** — base + `D_max` + WB analyze **inside the crop only**. This is the fix for issue #1 / washed-out: the black surround and rebate never poison the analysis.
3. **Base per roll from the rebate** — same as scanner, sampled from a frame that deliberately includes a rebate strip.
4. *(Optional, camera-only)* **Flat-field correction** from a blank-light shot — inversion amplifies lens vignetting.
5. **Invert** (Cineon), same as scanner.

## 4. Root cause of GitHub issue #1 (camera scans wash out)

The crop tool already exists and crops are applied before inversion at render time (`render_view`, `bake_working`). But **base + auto-WB are sampled on the full uncropped `working`** at develop time (`commands.rs:491` `sample_base(&working, None)`; `as_shot_wb` runs gray-world on the whole inverted thumb). The crop the user draws never reaches the analyzer. Filmomat documents exactly this: *"Recalculating WITH border around the image will cause washed-out images."* Fix: analysis samples inside the persistent crop (Plan 2).

## 5. Decomposition into plans (each ships working software)

| Plan | Scope | Unblocks |
|---|---|---|
| **Plan 1 — One engine** | Make Cineon (`Mode::D`) the sole inversion path; auto-derive `D_max`; remove engine toggle + stock dropdown from UI; remove Mode B/C/Naive + spectral stock code. | Kills the "fighting engines/stocks"; consistent Cineon look for everyone. |
| **Plan 2 — Coherent base + crop-aware analysis** | Base = single mean clear-film color; sample base + `D_max` (+ WB) inside the persistent crop; per-roll propagation; "re-analyze after crop". | **Fixes GitHub issue #1**; removes per-channel-percentile cast. |
| **Plan 3 — Two-layer WB** | Layer 1 (roll): mask/light neutral locked from the rebate. Layer 2 (per-frame): robust scene-WB estimate (shades-of-gray p=6 / gray-edge) auto-seeded once, then **sticky** — kill the reseed storm so it never clobbers a deliberate per-frame choice; keep gray-point. | Roll-consistent starting point + legitimate per-frame scene WB; removes WB fighting. |
| **Plan 4 — Flat-field correction (camera)** | Optional blank-light frame divides out vignetting before inversion. | Camera-scan edge falloff. |

Dependency order: 1 → 2 → 3 → 4. Plan 1 is written in full at
`docs/superpowers/plans/2026-06-15-golden-path-plan1-one-engine.md`.

## 6. Key code references (current state, verified 2026-06-15)

- Engine + Cineon: `crates/film-core/src/engine.rs` (`invert_d:127`, `InversionParams:12`, defaults `d_max=2.0, print_exposure=1.0, paper_black=0.0, paper_grade=0.5, soft_clip=0.9`).
- Base sampling: `crates/film-core/src/calibrate.rs` (`sample_base:19`).
- Stock model (to remove): `crates/film-core/src/spectral.rs`, `calibrate.rs` (`fit_m_post:152`, `balance_neutral:194`, `generic_m_post:217`), `engine.rs` (`params_for_stock:183`).
- Param build / routing: `commands.rs` (`build_params:211`, `mode_from:203`, `stock_from:184`, `default_invert_params:97`, `resolve_params:244`, `effective_base:236`).
- Develop flow: `commands.rs` (`develop_heavy:477`, base sampled `:491`; `ensure_resident:673`; `render_view:701`).
- WB commands: `commands.rs` (`as_shot_wb:1030`, `gray_point_wb:1082`), `wb.rs` (`gains_to_cct`, `wb_from_kelvin`).
- GPU bridge: `app/src-tauri/src/gpu_upload.rs` (`ResolvedInversion:131`, `resolve_to_uniforms:150`), `app/src/lib/viewport/gl/invert.ts`, `shaders.ts` (`INVERT_FRAG:191`).
- UI: `app/src/lib/develop/Basic.svelte` (stock dropdown `:124`, engine toggle `:142`, seed storm `:71-85`), `Develop.svelte` (gray-pick `:236`), `base.ts` (`setFolderBase`, `withEffectiveBase`).
- Wire contract: `app/src-tauri/src/session.rs` (`InvertParams:49`), `app/src/lib/api.ts`.
- Issue: `chuckdries` GitHub openenlarge #1 (crop before inversion).
