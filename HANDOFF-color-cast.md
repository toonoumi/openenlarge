# Handoff — magenta/purple cast on "No film profile" inversion

**From:** Claude session working on **auto white balance** (the "images too blue" report)
**To:** Claude session working on the **default color-inversion profile / grayscale issue**
**Date:** 2026-06-06
**Repo:** filmrev (OpenEnlarge), branch `main`

---

## TL;DR

The user showed a screenshot (USPS mailbox + banana) that still "looks weird." The
remaining problem is a **magenta / purple cast** — the asphalt road and shadows, which
should be near-neutral gray, render lavender/purple. **This is the green↔magenta (tint)
axis, NOT the blue↔yellow (temperature) axis I just fixed.** It is on **"No film profile"**,
which routes to the **default base-only identity inversion** — your area. My read: this is
most likely an **inversion-neutrality** problem, not a WB problem. But there are two WB-side
things you should rule out (below), and if you find WB is actually implicated, please write
me a handoff-back (template at the end).

---

## What I just did (and committed)

**Commit `4d145f5` on `main`:** `fix(wb): robust auto white balance to stop blue cast`
Single file: `crates/film-core/src/calibrate.rs`.

**The bug I fixed (different from the current symptom):** `auto_wb_gains` averaged the
**brightest ~20% of pixels** and forced them neutral. Real highlights run warm (sun/tungsten/
skin), so the estimator read scenes as warm → `wb_from_kelvin` applied strong cooling → blue
cast across many images. Confirmed by experiment (warm-highlight scene seeded **3750 K**).

**What I changed it to:** a **robust gray-world** estimator (`crates/film-core/src/calibrate.rs:65`):
- Averages only **near-neutral, well-exposed** pixels. Rejects:
  - chromatic pixels: `(max−min)/max > 0.25` (sky/foliage/skin/warm highlights),
  - near-clipped highlights `> 0.95`, shadow noise `luma < 0.05`.
  - Fallbacks: relax saturation to 0.6 if <5% kept; then all pixels if still empty.
- **Damps** the result toward neutral by `AUTO_WB_STRENGTH = 0.7` (`calibrate.rs:53`).
- New `auto_wb_gains_strength(img, k)` for explicit strength.
- Same warm scene now seeds **~5500 K**. 80 film-core tests green, clippy clean, app builds.

**Why this matters to your investigation:** see the two caveats in "WB-side things to rule out".

---

## How "No film profile" actually routes (code map)

The UI "No film profile" = `stock: "none"`, `mode: "b"` (frontend default, `app/src/lib/api.ts:222`).

In the backend:
- `stock_from("none")` → `None` (`app/src-tauri/src/commands.rs:185`).
- `build_params` (`app/src-tauri/src/commands.rs:153`):
  ```rust
  match stock_from(&p.stock) {
      Some(s) if p.mode == "b" => params_for_stock(s, base, exposure, p.black, p.gamma),
      _ => InversionParams { base, exposure, black, gamma, ..Default::default() },
  }
  ```
  So **"No film profile" hits the `_` arm** → `InversionParams::default()` =
  **identity `m_pre` / identity `m_post`** (`crates/film-core/src/engine.rs:29`). i.e.
  **base-only per-channel density inversion, with NO `balance_neutral`, NO crosstalk correction.**
- `balance_neutral` + fitted `m_post` are applied **only** in the stock path
  (`params_for_stock` → `engine.rs:143`). The no-profile path never gets neutralized.

**So a neutral subject (asphalt) is inverted as `out_c = tone(-log10(rgb_c / base_c), wb_c)`
per channel.** For that to be neutral, the per-channel `base` (orange-mask sample) ratios must
be correct AND per-channel black/gamma equal. A persistent **magenta** cast (green low relative
to red+blue) on neutrals means **the green channel's density is being over-estimated relative
to red/blue** — classic symptom of either (a) the sampled `base[green]` being too high, or
(b) the default identity inversion not accounting for the dye crosstalk that `m_post` would.

This is exactly your "default color inversion profile / grayscale" thread. My strong hypothesis:
**root cause is in the inversion (base sampling and/or the missing neutral-balance on the
no-profile path), not in WB.**

Relevant files:
- `crates/film-core/src/engine.rs` — `InversionParams`, `invert_b`/`invert_c`, `tone` (WB applied here as a gain in linear light before gamma).
- `crates/film-core/src/calibrate.rs` — `sample_base` (95th-percentile orange-mask sample, `:19`), `fit_m_post`, `balance_neutral`, `auto_wb_gains`.
- `app/src-tauri/src/commands.rs` — `build_params:153`, `as_shot_wb:818`, `develop`/preview path.
- GPU mirror (preview): `app/src/lib/viewport/gl/shaders.ts` (`u_wb` applied identically).

---

## WB-side things to rule out (my domain — please check these so we don't chase ghosts)

1. **Damping leaves residual cast by design.** Auto-WB now applies only **70%** of the
   computed correction (`AUTO_WB_STRENGTH = 0.7`). If the magenta originates in the inversion,
   Auto cannot fully remove it — and *shouldn't* be the place to fix it. Don't crank WB to
   mask an inversion cast; fix it at the source. (You can sanity-check by calling
   `auto_wb_gains_strength(img, 1.0)` — if full strength neutralizes the asphalt, the cast is
   WB-correctable; if it's still magenta at 1.0, it's an inversion/base problem.)

2. **`gains_to_cct` tint extraction may under-represent green/magenta** (`crates/film-core/src/wb.rs:54`).
   It computes `tint = (1 − gains[1]) / 0.5`, treating `gains[1]` as if green-normalized — but
   `auto_wb_gains` returns **gray-normalized** gains (the R/B *ratio* is normalization-invariant
   so the **temp** estimate is fine, but the absolute green term used for **tint** is not).
   Since the current cast lives on the **green/magenta (tint) axis**, this is the most plausible
   WB-side contributor. The screenshot shows Auto landed on **tint −10**, which may be too weak.
   Worth a unit check: feed a known magenta-cast inverted patch through
   `auto_wb_gains → gains_to_cct` and see if the returned tint fully accounts for it.

3. **Chromatic rejection interaction.** A *uniform* whole-frame magenta cast can exceed the
   `0.25` saturation cutoff, dumping the estimate into the relax (`0.6`) path. Still works, but
   if nearly everything is rejected the estimate gets noisy. Not my lead suspect here (the
   asphalt cast is mild), just flagging.

---

## Suggested experiments for you

1. **Is it the base?** On this image, inspect the sampled `base` (the orange swatch is shown in
   the UI). Try the manual film-base recalibrate on a clear-base/border region and see if the
   magenta on the asphalt resolves. (Per-roll base calibration is a known direction in this
   project.)
2. **Is it the missing neutral-balance?** The no-profile path skips `balance_neutral`. Try
   inverting the same frame with a neutral stock profile (or temporarily route the `_` arm
   through a neutral-balanced identity) and compare the asphalt neutrality.
3. **WB-correctable or not?** Run `auto_wb_gains_strength(inverted, 1.0)` on the asphalt region
   — neutral at full strength ⇒ WB axis (ping me); still magenta ⇒ inversion/base (yours).
4. **Histogram read:** the screenshot histogram shows clipped whites (Whites +59 + shiny metal)
   and channel separation — check whether green sits low through the midtones relative to R/B,
   which would confirm green-density over-estimation in the inversion.

---

## If it turns out to be WB after all — handoff back to me

Please drop a section below (or a new file `HANDOFF-back-to-wb.md`) with:
- Which experiment implicated WB (esp. result of experiment #3 above).
- A concrete repro: the inverted-patch RGB values (or a small test image) that produce the
  wrong tint, and the `auto_wb_gains` / `gains_to_cct` outputs you observed.
- Whether you want me to: (a) fix the `gains_to_cct` tint normalization, (b) revisit
  `AUTO_WB_STRENGTH` / make it user-adjustable, and/or (c) change how Auto handles a residual
  inversion cast.
- Anything you changed in the inversion path that I should account for (so my WB estimate,
  which runs *on the inverted image*, stays consistent).

---

## Scientific audit — round 2 (2026-06-06): "are we respecting the film scans?"

User reported the image still looks unnatural (too magenta/blue) after the WB fix and asked
whether the pipeline is scientifically sound. I ran three numerical experiments. **Verdict:
the WB pipeline and the core density math are correct/complete — the gap is the inversion's
tone model and the film-base estimate. This is NOT a white-balance problem.**

**Experiment 1 — neutral ramp through an ideal log-linear negative with DIFFERENT per-channel
contrast** (`neg_c = base_c·10^(−k_c·scene)`, `k = [0.50, 0.62, 0.74]`), inverted with the
no-profile pipeline:
- Result: the inverted neutral ramp had a **constant** hue error (0.163) at *every* tone, and a
  **single WB gain neutralized it perfectly — residual 0.000 across the whole ramp.**
- ⇒ Per-channel gamma differences alone are fully WB-correctable. The density core
  (`−log10(I/base)` + balanced `m_post` + single output gamma) **preserves the neutral axis
  across tones** for an ideal negative. `balance_neutral` keeping row-sums equal is what makes
  this hold even with a non-identity `m_post`.

**Experiment 2 — can the temp/tint WB model represent an arbitrary film gain?**
- On-locus gain `[1.10, 1.00, 0.92]` → model picked 6950 K / +0.06, reproduced to **±0.001**.
- Deliberately off-locus gain `[1.24, 1.00, 1.29]` (magenta/green weirdness) → 5200 K / +0.42,
  reproduced to **±0.002**.
- ⇒ The temp/tint model is a **complete 2-DOF representation** (temp sets R/B, tint sets G);
  it can express *any* per-channel gain. **No residual cast is due to WB being unable to
  represent the correction.** More WB tuning cannot help.

**Experiment 3 — decode + base provenance (code review):**
- Decode is correct: sRGB JPEG/PNG → sRGB EOTF, raw DNG → linear camera-native, no gamma.
  Densitometry runs on genuinely **linear** data. ✓
- **Film base = `sample_base(&working, None)` = whole-image 95th percentile, sampled
  INDEPENDENTLY per channel** (`commands.rs:485`). This is an *approximation* of the orange-mask
  Dmin, not a measured rebate — and independent per-channel percentiles don't correspond to a
  single real clear-film color, so on a colorful frame they can inject a per-channel cast.

### What this means (prioritized for you)

Since any *constant* cast is WB-fixable and the math preserves neutrals, the "unnatural" look
must come from cast sources that are either (a) not constant across tone, or (b) defeating the
auto-WB estimate. The durable, scientific fixes are **inversion-side**:

1. **Measure the base from the film rebate/border, per roll — not the whole-frame 95th
   percentile.** Highest leverage. Independent per-channel percentiles over scene content are
   the most likely source of a per-channel base cast on this colorful mailbox frame. (Matches
   the project's existing per-roll-base direction.) Use a rebate `Rect`, and sample base as a
   single coherent clear-film color, not three independent channel percentiles.
2. **Add a per-channel tone/characteristic curve.** Today `tone()` uses one scalar
   `gamma`/`black`/`exposure` for all channels (`engine.rs:56`). Real C-41 layers have different
   non-linear D-logE curves; ideal log-linear negs are fine (Exp 1), but real scans deviate and
   leave a tone-dependent residual that WB can't remove. Minimum: per-channel black + gamma.
   Better: a calibrated per-stock curve/LUT. This is the difference between "technically
   inverted" and "feels like film" (what NLP-class tools do).
3. **Highlight clamp** `(rgb/base).clamp(EPS, 1)` (`engine.rs:82`) sends any over-base channel to
   density 0 → highlight desaturation/shift. This frame has heavy clipping (shiny metal, white
   paper, Whites +59). Consider soft-rolloff / base headroom.

### WB-side caveat I own (may be worsening THIS specific image)

My new chromatic-pixel rejection (`(max−min)/max > 0.25`) can reject the **cast-bearing neutral
surfaces themselves** — on a magenta-tinted asphalt the "neutral" reference may read as chromatic
and get dropped, so on a colorful scene with few true neutrals the auto estimate under-corrects
(consistent with the screenshot's weak tint −10). If your base fix doesn't fully resolve it, ping
me and I'll: (a) loosen/adapt the saturation cutoff, (b) make `AUTO_WB_STRENGTH` user-adjustable,
and/or (c) bypass the temp/tint round-trip and apply raw gains for auto. But fix the base first —
auto-WB runs *on the inverted image*, so a correct base makes my estimate's job trivial.

## Housekeeping notes

- My fix is committed (`4d145f5`); only `calibrate.rs`.
- There were earlier uncommitted `zz_diag` test leftovers (a `mod zz_diag_test;` in `lib.rs`
  + `crates/film-core/src/zz_diag_test.rs`) from a prior WB/inversion debugging session — they
  printed Portra `M_post` and neutral-scene inversion tables. They've since changed/disappeared
  from the working tree; if they're yours, that diagnostic harness is directly relevant to the
  base/`m_post` neutrality question above.
- There are other uncommitted changes in `app/src-tauri/*` and `crates/film-core/src/engine.rs`
  in the working tree — I left them untouched (assumed yours).
