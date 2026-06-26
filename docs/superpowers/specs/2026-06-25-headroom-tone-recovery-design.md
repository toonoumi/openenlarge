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

## Invariants (the safety contract)

1. **Sliders at 0 ⇒ bit-identical output to today.** `tone_curve` passes the body through untouched (no top clamp to alter it), and the finalizer `look_s(shoulder_only(body, 1, 0), 0)` reproduces the moved `look_s(gamma_shoulder(te·wb, 1, 0))` exactly. The default look does not move; only slider *movement* gains recovery.
2. **CPU/GPU parity.** `engine.rs` + `finish.rs` (CPU export) and `shaders.ts` `INVERT_FRAG`/`FRAG` (GPU preview) stay in lockstep — every constant, function, and order mirrored verbatim, as the existing parity tests require.
3. **Downstream untouched.** Everything after `tone_curve` still receives display `[0,1]`, so saturation / tone LUT / color grade / color mixer / point color / texture are byte-for-byte unchanged.
4. **Monotonic under extreme sliders, including headroom.** `tone_curve` must remain monotonic for inputs up to the realistic super-white ceiling (≈ 2.0), so opposing endpoint+region sliders cannot fold the curve.

## Components touched

- **`crates/film-core/src/engine.rs`**
  - `invert_d` Faithful SDR branch: output `pow(te·wb, 1/γ)` (split out of `gamma_shoulder`), no `look_s`, no clamp. HDR branch unchanged.
  - Factor `gamma_shoulder` into `pow(...)` + a new `shoulder_only(raw, ceil, hr)` helper (so both call sites share one definition).
  - `hi_recovery`/`lo_recovery` become inert for SDR (always 0 at the finalizer). Decide in the plan whether to delete the `InversionParams` fields or leave them zeroed for minimal churn — leaning zeroed/unused to keep the wire contract stable.
- **`crates/film-core/src/finish.rs`**
  - `tone_curve`: drop the leading `clamp`, run slider ops on headroom, append the display finalizer `look_s(shoulder_only(v, 1, 0), 0)`. Import the engine's `shoulder_only`/`look_s` (or re-host the shared curve in one module to avoid duplication).
  - `apply_per_zone_wb`: relax the `[0,1]` clamp.
- **`app/src/lib/viewport/gl/shaders.ts`**
  - `INVERT_FRAG` Faithful SDR: output `pow(te·wb, 1/γ)`, no shoulder/look/clamp.
  - `FRAG` `tone()`: drop the leading `clamp`, append the finalizer (`lookS(shoulderOnly(v))`). Mirror constants.
- **`app/src-tauri/src/commands.rs`**
  - `build_params`: remove the `hi_recovery: -p.highlights/100` / `lo_recovery: -p.shadows/100` wiring (set 0 / drop).
  - Update/remove the tests that assert the old recovery mapping (`commands.rs:3508-3522`).
- **`app/src/lib/viewport/gl/invert.ts` / `uniforms.ts` / `renderer.ts`** — drop or zero the `hi_recovery`/`lo_recovery` uniforms in step with the engine decision.

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
