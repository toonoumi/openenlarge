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

pub fn detect_photo_mask(scan: &Image, base: [f32; 3]) -> PhotoMask;
```

- Operates on the **scan/negative-domain thumb** — the same `dev.thumb` the analyses
  already use, after orient + crop — where spokes are the clearest pixels.
- A pixel is a **spoke** when its clearness relative to `base` exceeds `SPOKE_MARGIN`
  (i.e. it sits below the base's minimum density / brighter than base in the scan domain).
- **confidence** combines:
  - (a) the luminance/density gap between the clear (spoke) cluster and the image Dmin —
    a wide, well-separated gap is a strong signal; a smeared continuum is weak;
  - (b) **border-adjacency ratio** — the share of masked pixels that touch the crop edge
    or form a contiguous strip, vs. scattered interior speckle.

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
`(cropped_thumb, base, meter_border)` and passes it to a mask-aware sampler. The mask is
recomputed per call rather than cached: it is deterministic on the small thumb, so all
three callers agree without shared state. (Caching on the developed image is a possible
later optimization; not in this design.)

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

`SPOKE_MARGIN`, `CONF_THRESH`, `FRAC_MIN`, `FRAC_MAX` live at the top of the relevant
`film-core` module alongside the existing analysis constants (mirroring `AUTO_TARGET` /
`AUTO_PCT` in `commands.rs`), so they are tunable in one place.

## Data flow

```
dev.thumb (negative) ──orient+crop──► cropped scan thumb ─┐
                                          base ───────────┤
                            meter_border ─────────────────┤
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

## Testing

`film-core` unit tests for `detect_photo_mask`:
- synthetic clear-base border → mask detected, high confidence;
- spoke-free frame → empty mask / low confidence, full-crop fallback;
- dark night frame (shadows carry base density) → *not* masked;
- `exclude` forces the mask; `include` never masks.

Mask-aware sampler tests:
- `percentile_luma_masked` and `sample_dmax` exclude exactly the masked pixels;
- a masked region shifts the auto-exposure EV in the expected direction vs. the full crop.

Existing `app/src/lib/viewport/gl/invert.test.ts` is unaffected; add lightweight TS
coverage for the `meter_border` parameter plumbing if practical.

## Open questions / tuning

- Exact values for `SPOKE_MARGIN`, `CONF_THRESH`, `FRAC_MIN`, `FRAC_MAX` are tuning work,
  to be validated against real spoke scans during implementation.
- Whether `per_zone_wb` needs the mask in v1 or can follow `as_shot_wb` — default is to
  mask both for consistency.
