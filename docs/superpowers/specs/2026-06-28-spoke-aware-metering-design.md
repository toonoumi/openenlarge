# Spoke-aware metering — design

**Date:** 2026-06-28
**Status:** Approved (pre-implementation)

## Problem

Many users deliberately include the film frame "spokes" — sprocket holes, inter-frame
rebate, and frame lines — in their scans because they look cool. Our auto-exposure then
over-brightens those frames.

**Mechanism.** `auto_brightness_value` (`app/src-tauri/src/commands.rs:2181`) solves for the
exposure (EV) that maps the **90th-percentile luminance** of the finished positive to
**0.80**. It measures over the user's crop. The spokes are physically *clear, unexposed
film*: in the scan/negative domain they pass the most light, and after inversion they
become near-black (the clearest negative → the darkest positive, darker even than the
image's real shadows). A block of near-black border pixels drags the luminance
distribution down, so the measured 90th percentile reads lower than the photo's true
90th percentile, and the solver raises EV to compensate → **image too bright**.

The same crop region also feeds **D_max** analysis (`analyze` → `sample_dmax`) and
**white-balance** estimation (`as_shot_wb`, `per_zone_wb`), so the spokes bias all three
crop-aware measurements identically.

The core tension: the user wants the spokes in the **output**, but not in the
**metering**. We must decouple "what is shown" from "what is measured."

**Positives are affected too.** `positive` is a boolean flag (auto-classified by
`classify::classify_positive` at develop time, or hand-toggled via `togglePositive`), not
a string mode. On the positive path the per-pixel invert short-circuits to
`develop_positive_px` (`engine.rs:282`) — a bare `exposure · WB · 1/2.2` passthrough that
**never reads `base` or `d_max`**. But `auto_brightness_value` measures the *finished*
positive through the same chokepoint, so it over-brightens spoke-laden positives exactly
as it does negatives. The catch: the negative-domain "clearer than film base" signal does
not exist for a positive (its rebate is near-black/opaque, not clear orange base), so the
detector must branch on `positive`. For positives only auto-exposure and WB consume the
mask — D_max is computed but inert on the positive render.

## Goals

- Auto-exposure, D_max, and WB ignore spoke/gap pixels when the crop includes them.
- Hands-free for rolls/batch — no per-image manual region.
- Safe by default: never exclude the real photo on a frame that has no spokes (e.g. a
  genuinely dark night frame).
- A manual per-roll escape hatch when auto guesses wrong, mirroring the existing per-roll
  base-recalibrate model.

## Non-goals

- Changing what the user sees in the output (spokes stay in the rendered/exported image).
- Geometric frame/format detection (35mm vs 120 perforation geometry). The chosen signal
  is format-agnostic.
- Auto-base detection changes. `auto_base` already runs on the full working image and is
  out of scope here.

## Approach (chosen)

**A — clear-base threshold mask (value/density domain).** Spokes are physically clear
film: in the scan/negative-domain thumb they are the brightest, near-uniform region,
distinctly clearer than even the image's deepest shadows (which still carry the orange
mask plus some density). We already detect the film `base` (`auto_base`). So a pixel is a
spoke when it is *clearer than the base by a margin*. Confidence is derived from the
separation between the clear cluster and the image Dmin, and from spatial coherence (the
mask hugging the crop border / forming a strip rather than scattered interior speckle).

Rejected alternatives:
- **B — geometric border-band detection.** Sprocket holes are not a clean rectangle
  (perforated strip on one edge, irregular); fragile across formats and partial
  inclusion. More code, less robust.
- **C — histogram outlier trim only (no spatial mask).** Cannot distinguish a spoke
  cluster from a legitimately large shadow region; equivalent to unconditional trimming,
  which was explicitly rejected.

## Design

### 1. Core: one shared photo mask (`film-core`)

New in `crates/film-core/src/calibrate.rs`:

```rust
pub struct PhotoMask {
    pub mask: Vec<bool>,        // one per pixel; true = image pixel, false = spoke/gap
    pub excluded_fraction: f32, // 0..1
    pub confidence: f32,        // 0..1
}

pub fn detect_photo_mask(scan: &Image, base: [f32; 3], positive: bool) -> PhotoMask;
```

- Operates on the **scan thumb** — the same `dev.thumb` the analyses already use, after
  orient + crop. The detection signal branches on `positive`.

**Negative path** (`positive == false`): spokes are the clearest pixels.
  - A pixel is a **spoke** when its clearness relative to `base` exceeds `SPOKE_MARGIN`
    (it sits below the base's minimum density / brighter than base in the scan domain).
  - **confidence** combines (a) the luminance/density gap between the clear (spoke)
    cluster and the image Dmin — a wide, well-separated gap is strong, a smeared continuum
    weak; and (b) **border-adjacency ratio** — the share of masked pixels touching the
    crop edge / forming a contiguous strip, vs. scattered interior speckle.

**Positive path** (`positive == true`): `base` is ignored; spokes are an extreme,
  near-uniform, border-adjacent region at *either* rail — near-black (slide rebate, dense
  and opaque) or near-white (clear sprocket/perforation). A pixel is a candidate when it
  is within `POS_RAIL_MARGIN` of black or white; it is confirmed by **local uniformity**
  (low variance — film rebate and clear gaps are flat) and **border-adjacency**.
  - **confidence** combines rail extremeness, the uniformity of the candidate region, and
    border-adjacency. Scattered interior near-black (real scene shadows) or near-white
    (real speculars) fail the uniformity + border tests and are not masked.

Both paths return the same `PhotoMask`; downstream callers do not care which signal
produced it.

### 2. Confidence gate + plausibility

The mask is honored only when:

- `confidence >= CONF_THRESH`, **and**
- `excluded_fraction` is within a plausible band `[FRAC_MIN, FRAC_MAX]` (e.g. 0.02–0.60).

Otherwise the analysis falls back to metering the **full crop** (today's behavior). The
plausibility band is what prevents a dark night frame (large real shadow area, but those
shadows still carry base density and so are *not* clearer-than-base) from having its real
content excluded.

Degenerate guards: an empty mask, or a near-all-masked result, falls back to the full
crop. Metering must never run on zero pixels.

### 3. Shared plumbing into the three analyses

All three commands already orient + crop the thumb. Each computes the mask **once** from
`(cropped_thumb, base, positive, meter_border)` and passes it to a mask-aware sampler. The
mask is recomputed per call rather than cached: it is deterministic on the small thumb, so
all three callers agree without shared state. (Caching on the developed image is a
possible later optimization; not in this design.) `positive` is already available on
`Developed` / `InvertParams`, so no new plumbing is needed to reach the detector. For a
positive image the D_max sampler still applies the mask, but its result is inert on the
positive render — only auto-exposure and WB consume the mask in that case.

- `auto_brightness_value` (`commands.rs:2181`) → `percentile_luma_masked` skips spoke
  pixels when measuring the 90th-percentile luminance.
- `analyze` / `sample_dmax` / `sample_dmax_spread` (`calibrate.rs`) → skip spoke pixels.
- `as_shot_wb` / `per_zone_wb` (`commands.rs`) → restrict the estimate to mask pixels.

`percentile_luma` (`commands.rs:2240`) gains a masked variant.

### 4. Manual override (per-roll)

New develop param `meter_border: "auto" | "exclude" | "include"`, default `"auto"`:

- `auto` — confidence-gated detection (§2).
- `exclude` — force the threshold mask even at low confidence ("yes, there are spokes").
  Still subject to the degenerate guards (never meter zero pixels).
- `include` — never mask; meter the full crop (today's behavior).

Surfaced as a small segmented control in Develop, near the D_max / recalibrate controls.
Stored in develop params and **mirrored to the whole roll** like other Develop edits,
consistent with the per-roll base-calibration model.

### 5. Frontend wiring (`app/src/lib/develop/Basic.svelte`, `app/src/lib/api.ts`)

- `api.autoBrightness`, `api.analyze`, and the WB calls gain the `meter_border` argument
  (they already pass `crop` + `geom`).
- Toggling `meter_border` re-runs `reanalyze()` (D_max + WB reseed) **and**
  `autoExposure()` for the active frame, then mirrors to the roll.
- The crop-change reactive trigger (`Basic.svelte:215`) is unchanged in *when* it fires;
  it simply meters with the mask now. Exposure still does not auto-rerun on crop change
  (consistent with the current design) — but `seedExposure` and `autoExposure` use the
  mask when they do run.

### 6. Constants

`SPOKE_MARGIN` (negative), `POS_RAIL_MARGIN` (positive), `CONF_THRESH`, `FRAC_MIN`,
`FRAC_MAX` live at the top of the relevant `film-core` module alongside the existing
analysis constants (mirroring `AUTO_TARGET` / `AUTO_PCT` in `commands.rs`), so they are
tunable in one place.

## Data flow

```
dev.thumb ────────────orient+crop──► cropped scan thumb ─┐
                              base (negative only) ───────┤
                              positive flag ──────────────┤   negative: clearer-than-base
                              meter_border ───────────────┤   positive: rail+uniform+border
                                                          ▼
                                            detect_photo_mask → PhotoMask
                                                          │ (confidence + plausibility gate)
                  ┌───────────────────────────────────────┼───────────────────────────┐
                  ▼                                        ▼                           ▼
        percentile_luma_masked                  sample_dmax (masked)          WB estimate (masked)
        → auto-exposure EV                       → d_max_override              → temp/tint seed
```

## Error handling and edge cases

- **No / failed base estimate:** confidence is low → `auto` falls back to the full crop.
  `exclude` still applies the threshold using whatever base is available.
- **excluded_fraction too high (> FRAC_MAX):** implausible for spokes → treated as no
  spokes under `auto` (likely a dark frame).
- **Empty or all-masked:** fall back to the full crop.
- **Orientation-only changes:** unaffected — they do not change the crop coverage and do
  not trigger re-analysis (existing behavior preserved).
- **Positive/negative flip:** when `classify_positive` or the manual toggle changes the
  flag, the detector switches signal accordingly on the next analysis. The
  `meter_border` override is independent of and orthogonal to the positive flag.
- **Positive D_max:** masking is applied but inert on the positive render; this is
  intentional and costs nothing (keeps one code path for all three samplers).

## Testing

`film-core` unit tests for `detect_photo_mask`:
- **negative**, synthetic clear-base border → mask detected, high confidence;
- **negative**, spoke-free frame → empty mask / low confidence, full-crop fallback;
- **negative**, dark night frame (shadows carry base density) → *not* masked;
- **positive**, near-black slide rebate border → masked;
- **positive**, near-white clear sprocket strip → masked;
- **positive**, spoke-free slide with deep scene shadows / speculars → *not* masked
  (fails uniformity + border tests);
- `exclude` forces the mask; `include` never masks (both flag states).

Mask-aware sampler tests:
- `percentile_luma_masked` and `sample_dmax` exclude exactly the masked pixels;
- a masked region shifts the auto-exposure EV in the expected direction vs. the full crop.

Existing `app/src/lib/viewport/gl/invert.test.ts` is unaffected; add lightweight TS
coverage for the `meter_border` parameter plumbing if practical.

## Open questions / tuning

- Exact values for `SPOKE_MARGIN`, `POS_RAIL_MARGIN`, `CONF_THRESH`, `FRAC_MIN`,
  `FRAC_MAX` are tuning work, to be validated against real spoke scans (both negative and
  positive) during implementation.
- Whether `per_zone_wb` needs the mask in v1 or can follow `as_shot_wb` — default is to
  mask both for consistency.
