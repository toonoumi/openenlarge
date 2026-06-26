# Headroom tone recovery — design

**Date:** 2026-06-25
**Status:** Approved, pending implementation plan

## Problem

User feedback (verified still broken after a prior attempt):

> 我们的对比度与高光阴影黑白工具。只是对曝光。计算完成的已经被裁切过（高光阴影）的图像二次调整。比如我无法通过降低对比度或者降低白色与高光还原更多被切掉的白色细节。

Translation: the Contrast / Highlights / Shadows / Whites / Blacks tools only do a *secondary* adjustment on the already-computed, already-clipped image. Lowering Contrast or Whites/Highlights cannot recover clipped white detail.

### Root cause

The develop tone pipeline runs in two stages, in this order:

1. **INVERT** (`engine.rs::invert_d` Faithful path / `INVERT_FRAG` in `shaders.ts`) — inversion, exposure, then the `gamma_shoulder` highlight rolloff, `look_s` look layer, and a final **`clamp(v, 0.0, 1.0)`**. This is where highlight detail is compressed into the top sliver and pinned at white. The result is written to an RGBA16F FBO but already clamped to `[0,1]`.
2. **FINISH** (`finish.rs::tone_curve` / `FRAG` in `shaders.ts`) — Contrast, Highlights, Shadows, Whites, Blacks run here, and `tone_curve` *starts* with `clamp(v,0,1)`. They can only redistribute the already-display-clipped, shoulder-baked positive.

A prior fix (意见1) gave **negative Highlights → `hi_recovery`** and **negative Shadows → `lo_recovery`** (`commands.rs:268-269`), which widen the engine shoulder / soften the toe *pre-clamp*. But Whites and Contrast were never wired to any pre-clamp recovery, and the Highlights path is a separate, opaque second job on the same slider. The finish tone tools still operate purely post-clamp, so lowering Whites/Contrast recovers nothing — matching the user's report.

The slider math in `tone_curve` already has the right *shape* for recovery (`v += whites·0.20·v³` and the contrast gain both act hardest at the top end). The only thing stopping it is that its input is pre-clamped to `[0,1]`.

## Goal

True scene-referred recovery: lowering **any** of Whites / Highlights / Contrast (and symmetrically Shadows / Blacks at the dark end) pulls genuine blown-highlight (or crushed-shadow) detail back into range — Lightroom-like behaviour — through one clean mechanism.

## Design: super-white handoff + display finalizer

Split the Faithful display mapping. INVERT stops baking the highlight shoulder, look layer, and clamp; it outputs the **gamma body carrying super-white** (values > 1.0 where highlights are bright, held in the existing RGBA16F FBO). The shoulder + look layer + clamp move to the **end of `tone_curve`**, *after* the user's slider ops.

### Key identity: `gamma_shoulder` factorises

`gamma_shoulder(x, ceil, hr)` is `raw = pow(x, 1/γ)` followed by a shoulder rolloff. Split it:

- **`pow(te·wb, 1/γ)`** stays in INVERT (the body; unbounded → super-white).
- **`shoulder_only(raw, ceil, hr)`** (the rolloff above `FAITHFUL_KNEE`, identity below) joins the display finalizer.

So `gamma_shoulder(x, ceil, hr) == shoulder_only(pow(x, 1/γ), ceil, hr)` exactly.

### Recovery wiring retired

Per the design decision, the `hi_recovery` / `lo_recovery` slider wiring is **retired**: all five tone tools recover purely through the new headroom path. The finalizer's shoulder/toe become fixed (`hr = 0`, `lo = 0`). The HDR gain-map path is unaffected (it already passes `hr = 0` and uses `HDR_HEADROOM` instead of the look layer).

### Per-channel pipeline change

| Stage | Today | Proposed |
|---|---|---|
| INVERT Faithful SDR | `look_s(gamma_shoulder(te·wb, 1, hr), lo)` → **clamp[0,1]** | `pow(te·wb, 1/γ)` → **no clamp** (super-white) |
| finish `tone_curve` input | `clamp(v,0,1)` first | **no top clamp** — operate in headroom |
| finish `tone_curve` end | `clamp(v,0,1)` | apply **display finalizer** `look_s(shoulder_only(v, 1, 0), 0)` → [0,1] |
| per-zone WB (`apply_per_zone_wb`) | `(rgb·gain).clamp(0,1)` | clamp relaxed (headroom-safe) |
| saturation / LUT / grade / mixer / point color / texture | — | **unchanged** (still receive [0,1] from the finalizer) |

### Why it recovers

A bright highlight now arrives at `tone_curve` as e.g. `1.3` instead of pre-clamped to `1.0`. The existing slider ops act on it:

- **Whites** `v += whites·0.20·v³` — at `v=1.3`, `whites=-1` ⇒ `v -= 0.20·2.197 = 0.44` → `v=0.86`. Strongest pull-down exactly at the super-white end.
- **Contrast** `v = 0.5 + (v-0.5)·(1+contrast)` — lowering contrast pulls `1.3` toward `0.5`.

Both compress super-white *below the shoulder knee* before the finalizer maps to display, so the previously-flat white blob re-separates into detail. Same logic mirrored at the dark end for Shadows/Blacks.

### Confinement: `invert_d` is shared, so split body vs. display

`invert_image`/`invert_d` is consumed well beyond the display path —
`auto_wb_gains`, the gray-point picker, `color_match.rs`, the proxy
noise-match calibration (`convert.rs:678`), and direct pixel reads all expect
the display-referred positive in `[0,1]`. Changing `invert_d`'s output domain
globally would silently drift those. So confine the change:

- **`invert_d_core(px, p)`** — NEW. Returns the **super-white body** for the
  Faithful SDR path (`pow(te·wb, 1/γ)`, no shoulder/look/clamp); returns the
  current display value unchanged for every other mode (Filmic, HDR, naive,
  B/C). HDR keeps its `HDR_HEADROOM` expansion inside core.
- **`invert_d(px, p)`** — UNCHANGED signature/behaviour. Defined as
  `if Faithful && !hdr { core.map(display_finalize) } else { core }`, so it is
  byte-identical to today. **All existing analysis / back-compat callers stay
  on `invert_d` / `invert_image` and are untouched.**
- **`invert_image_core(img, p)`** — NEW. `invert_d_core` mapped over the image.
- **Display path only** switches to the body: the seven `invert_image → finish_image`
  pairings in `commands.rs` (`1202→1221`, `1241→1248`, `1426→1444`,
  `1509→1517`, `2091→2092`, `2181→2182`, `3048→3049`) use `invert_image_core`;
  `finish_image`/`finish_pixel` apply `display_finalize` at the end of
  `tone_curve`. The GPU path is display-only already.

`display_finalize(v) = look_s(shoulder_only(v, 1.0, 0.0), 0.0)`, where
`shoulder_only` is `gamma_shoulder` minus its internal `pow` (now `gamma_body`,
in core). `gamma_shoulder(x,ceil,hr) ≡ shoulder_only(gamma_body(x),ceil,hr)` —
refactor it to call both so the HDR caller is unchanged.

**Self-checking:** if a display site is left on `invert_image` by mistake,
`finish` double-applies `display_finalize` → visibly wrong → the identity test
(below) fails. The dangerous direction (an analysis site switched to core) is
avoided by only touching the seven finish-paired sites.

### Production WB mode caveat (gain)

Production default is **gain** WB (subtractive is opt-in, `api.ts:405`). In gain
mode WB multiplies *after* today's shoulder (`gamma_shoulder(te)·wb`); the split
folds WB into the body (`gamma_body(te)·wb`) and applies the shoulder in the
finalizer. Below the shoulder knee `shoulder_only` is identity, so output is
**bit-identical** there; only highlight channels above the knee differ — WB now
precedes the rolloff (no post-WB clip), the intended improvement. Subtractive
mode is exact everywhere (WB lives inside `te`, pre-`gamma_body`).

## Invariants (the safety contract)

1. **Sliders at 0 ⇒ output identical to today** (subtractive: bit-identical everywhere; gain: bit-identical below the shoulder knee, with the intended highlight change above it — see the gain caveat). `tone_curve` passes the body through untouched (no top clamp to alter it), and the finalizer reproduces the moved `look_s(gamma_shoulder(…))`. The default look does not move (outside gain highlights); only slider *movement* gains recovery.
2. **CPU/GPU parity.** `engine.rs` + `finish.rs` (CPU export) and `shaders.ts` `INVERT_FRAG`/`FRAG` (GPU preview) stay in lockstep — every constant, function, and order mirrored verbatim, as the existing parity tests require.
3. **Downstream untouched.** Everything after `tone_curve` still receives display `[0,1]`, so saturation / tone LUT / color grade / color mixer / point color / texture are byte-for-byte unchanged.
4. **Monotonic under extreme sliders, including headroom.** `tone_curve` must remain monotonic for inputs up to the realistic super-white ceiling (≈ 2.0), so opposing endpoint+region sliders cannot fold the curve.

## Components touched

- **`crates/film-core/src/engine.rs`**
  - Add `gamma_body(x)` (`x.max(0).powf(1/γ)`) and `shoulder_only(raw, ceil, hr)`; refactor `gamma_shoulder` to `shoulder_only(gamma_body(x), ceil, hr)` (HDR caller unchanged).
  - Add `display_finalize(v)` = `look_s(shoulder_only(v, 1.0, 0.0), 0.0)` (`pub(crate)`).
  - Add `invert_d_core` (Faithful SDR → body via `gamma_body`, no shoulder/look/clamp; other modes unchanged) and `invert_image_core`. Redefine `invert_d` = `if Faithful && !hdr { core.map(display_finalize) } else { core }` so it stays byte-identical.
  - Make `look_s` / `shoulder_only` / `display_finalize` `pub(crate)` so `finish.rs` can call them.
  - `hi_recovery`/`lo_recovery` retired: leave the `InversionParams` fields in place (zeroed) to keep the wire contract stable; remove the engine recovery tests (`hi_recovery_separates_highlights` etc.) that assert the old SDR shoulder-widening, since the finalizer is now fixed at `hr=lo=0`.
- **`crates/film-core/src/finish.rs`**
  - `tone_curve`: drop the leading `clamp`, run slider ops on the headroom value, append `engine::display_finalize(v)` (use `crate::engine::display_finalize`).
  - `apply_per_zone_wb`: relax the `[0,1]` clamp (headroom-safe).
- **`app/src/lib/viewport/gl/shaders.ts`**
  - `INVERT_FRAG` Faithful SDR: output `gammaBody(te·wb)` (gain: `gammaBody(te)·wb`), no shoulder/look/clamp. Add a `gammaBody()` GLSL helper.
  - `FRAG`: add `shoulderOnly()` + `lookS()` helpers (FRAG is a separate program from INVERT_FRAG and lacks them); `tone()` drops its leading `clamp`, appends `lookS(shoulderOnly(v,1.0,0.0),0.0)`. Mirror all constants.
  - Clip overlay: `clipCode` currently reads `u_src` (the inverted positive), which is now the super-white body. Switch it to test the **finished display color** `c` from `finishAt` (display `[0,1]`, thresholds `CLIP_HI`/`CLIP_LO` unchanged). Preview-only; no CPU parity needed.
- **`app/src-tauri/src/commands.rs`**
  - `build_params`: set `hi_recovery`/`lo_recovery` to `0.0` (remove the `-p.highlights/100` wiring).
  - Switch the seven display-path `invert_image(...)` calls that feed `finish_image` to `invert_image_core(...)` (`1202`, `1241`, `1426`, `1509`, `2091`, `2181`, `3048`). Leave all other `invert_image` calls (analysis/seed/bake) untouched.
  - Update/remove the tests asserting the old recovery mapping (`commands.rs:3508-3522`).
- **GPU uniform plumbing** (`invert.ts` / `uniforms.ts` / `renderer.ts`): the `hi_recovery`/`lo_recovery` uniforms stay wired but are always `0` (the engine zeroes them); no structural change required.

## Testing

- **Parity:** existing CPU-vs-GPU and `finish_image_matches_scalar_per_pixel` tests must still pass.
- **Identity:** new test — with all tone sliders at 0, `finish(invert(scan))` equals the pre-change output for a representative scan (golden buffer or direct equality against a recomputed reference).
- **Recovery:** new test — a synthetic super-white channel (body > 1.0) fed through `tone_curve` with `whites < 0` (and separately `contrast < 0`) yields a *lower, distinct* value than at sliders 0, i.e. detail re-separates rather than staying clamped.
- **Monotonicity:** extend `tone_curve_monotonic_under_extreme_sliders` to sample inputs up to ≈ 2.0 under opposing endpoint+region+contrast sliders.
- **No regression** in the look at defaults: covered by the identity test.

## Out of scope / YAGNI

- No re-tuning of the default look, `FAITHFUL_*`, `LOOK_K`, or saturation/LUT constants.
- No new UI controls — the existing five tone sliders gain the new behaviour.
- No change to the Filmic path (dormant), HDR headroom path, positive passthrough, or raw modes.
