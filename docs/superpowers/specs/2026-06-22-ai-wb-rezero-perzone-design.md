# AI White Balance: Re-zero + Per-Zone Neutralizer — Design

**Date:** 2026-06-22
**Status:** Approved for planning
**Scope:** Phase 1 (re-zero WB sliders) + Phase 2a (classical per-zone neutralizer). Phase 2b (trained model) is a documented stub only.

## Problem

Today's auto-WB is a single **global gray-world** correction computed on the inverted image
(`calibrate.rs:auto_wb_gains_strength`): low-saturation pixel gate → per-channel trimmed mean →
`gain = gray / channel_mean` → damped by `AUTO_WB_STRENGTH = 0.7`. The temp/tint sliders are
back-derived from those gains via blackbody CCT inversion (`wb.rs:gains_to_cct`).

This produces two distinct user-facing problems:

- **Problem A — non-uniform cast.** A single set of RGB gains cannot fix a cast that differs by
  tonal zone (e.g. pink highlights but neutral midtones). Gray-world structurally either fixes the
  highlights and tints the mids, or vice versa.
- **Problem B — extreme landing, no tuning headroom.** Gray-world drags the scene average to gray
  regardless of whether the frame is a legitimately-warm "good" frame or a "too pink" bad one. At
  strength 0.7 that is a large shove, and because the result is shown as an *absolute* Kelvin value,
  the slider lands far off-center (e.g. 7200K jammed near the warm end) with little room to push
  further.

**Related context (commit a08d1f2):** a pink-on-zoom/export bug was traced to noise × convex
inversion — `d = log10(base/scan)` is convex, so per-pixel noise inflates per-channel mean density
(Jensen's inequality), worst on low-base/low-red channels. This proves a cast can be a *pipeline
artifact*, not film, and motivates keeping our corrections gentle and noise-consistent. See
`match_proxy_noise` and the noise-match invariant.

## Goals

1. **Re-zero (Problem B):** after auto-WB, the temp/tint sliders sit at center (0/0) with symmetric
   headroom, regardless of how large the underlying correction is. The image stays corrected.
2. **Per-zone neutralize (Problem A):** correct tonal-zone-dependent casts (pink highlights / green
   midtones) without an aggressive "AI-processed" look, reusing the existing color-grade zone edges
   and render infrastructure.
3. **Faithfulness:** a uniform-cast frame must collapse to the same answer as today's global WB.
   Per-zone correction only diverges when zones genuinely differ.

## Non-Goals

- Trained neural model (Phase 2b) — stub only; specified later.
- Changing the inversion math, base calibration, exposure anchoring, or tone curves.
- Touching the creative 3-wheel color-grade behavior. The per-zone neutralizer is a *separate
  corrective layer*; it must never write into the user's creative `cg_*` settings.

---

## Phase 1 — Re-zero WB sliders (offset model)

### Behavior

- `auto_wb_gains_strength` continues to compute exactly as today, but its result is stored as a
  hidden **`wb_baseline`** (per-roll, alongside the per-roll base calibration).
- `temp` / `tint` params become **offsets relative to `wb_baseline`**, defaulting to 0/0 (UI
  center). Final WB applied to the engine:

  ```
  wb_final = wb_baseline ∘ wb_from_offset(temp, tint)
  ```

  where `wb_from_offset` reuses the existing Kelvin/tint → gain math, interpreted as a delta around
  the baseline rather than an absolute target.
- **Gray-point picker** (`commands.rs:gray_point_temp_tint` / `gray_point_wb`): clicking a neutral
  patch *redefines* `wb_baseline` so that patch becomes gray, then resets the offset sliders to 0/0.
  Semantics preserved ("make this gray"), user left centered.
- **Manual recalibrate** (per-roll): same as gray-point — updates `wb_baseline`, resets offsets.

### Migration

Existing saved edits store *absolute* temp/tint. On load, back-convert to the offset model so old
edits render identically:

```
offset = stored_absolute_wb ∘ inverse(wb_baseline)
```

This places the slider exactly where the saved edit truly was — no silent shift. A schema/version
marker distinguishes pre- and post-migration edits so conversion runs once.

### Files (Phase 1)

- `crates/film-core/src/wb.rs` — add `wb_from_offset` (delta interpretation); keep absolute path for
  migration back-conversion.
- `app/src-tauri/src/commands.rs` — store/propagate `wb_baseline`; update gray-point & recalibrate to
  rewrite baseline + zero offsets; migration on edit load.
- `app/src/lib/api.ts` + develop UI — temp/tint sliders default 0/0, labeled as offsets.
- `app/src/lib/viewport/gl/shaders.ts` + `gpu_upload.rs` — receive `wb_final` (composed), no new
  shader math (composition happens before upload).

### Tests (Phase 1)

- Composition: `wb_baseline ∘ wb_from_offset(0,0) == wb_baseline` (centered = pure auto).
- Migration round-trip: a stored absolute WB back-converts to an offset that recomposes to the same
  `wb_final` (within float tolerance).
- Gray-point: picking a patch makes it neutral AND leaves offsets at 0/0.

---

## Phase 2a — Per-zone neutralizer (classical)

### Behavior

A new **corrective** layer (distinct from creative color-grade) that estimates and gently
neutralizes the cast *independently within shadows / midtones / highlights*.

1. **Sample** using the existing low-saturation pixel gate from `auto_wb_gains_strength`.
2. **Bin** survivors into 3 luma zones using the **same zone edges** the color-grade split-toning
   already defines (`finish.rs` shadow/mid/highlight crossovers) so zones are consistent across the
   app.
3. **Per zone:** compute a gray-world gain from that zone's neutral-ish pixels only.
   - If a zone has too few neutral pixels (below a threshold), it contributes **zero correction** —
     never invent a cast.
4. **Damp + clamp** each zone independently (per-zone strength analogous to `AUTO_WB_STRENGTH`; hard
   clamp on max per-zone swing). This preserves the faithful look and prevents the AI-processed
   appearance.
5. **Apply** via the new corrective layer in the Rust engine and GPU shader (mirrored, like all
   existing engine math). Exposed as **one toggle + one intensity slider**, default **on** but
   conservative.

### Faithfulness invariant

When all three zones report the same cast, the per-zone result must equal the global WB result.
A uniform-cast frame is therefore unchanged relative to today; per-zone only diverges on genuinely
zone-dependent casts.

### Interaction with noise-matching (a08d1f2)

The per-zone estimator's per-channel means are exactly the noise-sensitive operation behind the
pink-on-zoom bug. Therefore:

- The per-zone cast estimate **must sample from the 2560 proxy (or a `match_proxy_noise`'d buffer)** —
  the same reference the fit-view inversion uses — so the correction is identical across
  fit / zoom / export.
- Phase 2a rides the existing inversion (adds no new decode→invert path), so it inherits the
  invariant for free. Do **not** undo `match_proxy_noise`; the slight 100% softening is the cast
  staying gone (chroma-only smoothing is the documented follow-up if grain loss bites).

### Files (Phase 2a)

- `crates/film-core/src/calibrate.rs` — per-zone binning + per-zone gray-world estimate (reuse
  existing gate); zero-correction fallback; damp/clamp.
- `crates/film-core/src/engine.rs` — new corrective per-zone WB layer in `invert_d` pipeline,
  applied separately from creative color-grade.
- `app/src/lib/viewport/gl/shaders.ts` — mirror the corrective layer (bit-identical, per existing
  CPU/GPU parity).
- `app/src-tauri/src/gpu_upload.rs` — pack per-zone corrective uniforms.
- `app/src-tauri/src/commands.rs` — compute estimate from proxy/noise-matched buffer; expose
  toggle + intensity.
- `app/src/lib/api.ts` + develop UI — toggle + intensity slider.

### Tests (Phase 2a)

- **Uniform cast ⇒ global equivalence:** a synthetic frame with one cast across all zones produces
  the same `wb_final` as global gray-world (the key faithfulness test).
- **Zone-dependent cast:** synthetic frame with pink highlights + neutral mids ⇒ highlights
  neutralized, mids untouched.
- **Sparse-zone fallback:** a zone with no neutral pixels contributes zero correction.
- **Clamp:** an extreme single-zone cast is bounded by the clamp.
- **Path consistency:** estimate from proxy == estimate from noise-matched near-native buffer.

---

## Phase 2b — Trained model (stub, out of scope)

Upgrade path for scenes with **no neutral reference**, where the classical per-zone estimator has
nothing to balance against and a semantic model ("that's skin / sky / a neutral wall") wins. Would
reuse the existing local ONNX infrastructure (from autodust). If it ever needs its own full-res
inversion input, that path **must** route through `match_proxy_noise`. Requires a model spike +
training data (labeled film scans) + hosting — specified in a separate doc when prioritized.

---

## Rollout

Phase 1 and Phase 2a ship independently and in order. Both are reversible (Phase 1 via the toggle of
absolute vs offset display + migration; Phase 2a via its toggle). Default state after both ship:
offset sliders centered, per-zone neutralizer on + conservative.
