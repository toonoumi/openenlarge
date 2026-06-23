# Absolute Temp/Tint white balance — design

**Status:** proposed (review before implementing)
**Date:** 2026-06-23

## Problem

Today Temp/Tint are a *relative trim* multiplied onto a hidden per-image baseline:

```
wb[c] = wb_baseline[c] · wb_from_kelvin(temp, tint)[c]
```

Auto WB and the gray-point picker both **estimate gains, store them in the hidden
`wb_baseline`, and re-zero the visible sliders to 5500 K / 0** (`applyAsShotWb`). The
gray-point backend even computes a real Temp/Tint and throws it away.

Consequences (the colleague's report):
- The sliders never show the *actual* white balance — they always start at 0 and mean
  "delta from an invisible baseline". So "+100" has no fixed meaning; on a different
  baseline the same value lands at a different colour ("too relative").
- Picking a neutral gray — which plainly *sets* a white balance — snaps the slider to 0
  instead of showing the WB it just set ("feels weird").

(Note: the estimate itself is deterministic — `as_shot_wb` inverts with `wb=[1,1,1]`, so it
doesn't drift on repeated presses. The confusion is purely the hidden-baseline + re-zero.)

## Goal

Temp/Tint **are** the white balance — absolute, visible, stable.
- Auto WB and the gray-point picker **move the sliders** to the estimated values.
- Trimming from there means the same thing every time; no hidden baseline, no re-zero.
- Per-image editing matches Lightroom's mental model.

## Why the relative model existed (and the trap)

The re-zero / universal-5500 model was introduced *because* an earlier absolute approach
(the `asShotTemp` machinery) "produced wrong offsets in copy/roll-apply" and was removed.
Universal Temp made copy/roll-apply copy the *look* (the trim), each frame keeping its own
as-shot. Going absolute means **re-solving copy/roll-apply as a relative offset** — and we
must avoid whatever bit `asShotTemp` last time.

**Likely root of the old bug:** offsets were taken in **Kelvin**, which is non-linear.
Copying "+1000 K" from a 5000 K frame to a 8000 K frame is not the same colour shift. The
fix: **do Temp offsets in MIRED** (`M = 1e6 / K`), which is linear in colour shift, then
convert back. Tint offsets are already linear. This is also what the slider's reciprocal
track already implies.

## Model

### Per-frame (engine + sliders)
- `wb_baseline` is retired (set to identity). The engine WB is `wb_from_kelvin(temp, tint)`
  directly. Temp/Tint are absolute.
- Auto WB: `as_shot_wb` already returns `(temp, tint)`; set the sliders to them (stop
  calling `applyAsShotWb`'s re-zero).
- Gray-point: `gray_point_wb` already computes `(temp, tint)`; set the sliders to them
  (stop discarding them).
- Store each frame's **as-shot Temp/Tint** as a read-only reference (`as_shot_temp`,
  `as_shot_tint`) — the deterministic `as_shot_wb` estimate — used only for relative
  copy/roll. It is NOT a multiplier and never touches the render.

### Copy / roll-apply (relative, in mired)
- Source offset: `dM = 1e6/src.temp − 1e6/src.as_shot_temp`, `dTint = src.tint − src.as_shot_tint`.
- Target: `tgt.temp = 1e6 / (1e6/tgt.as_shot_temp + dM)`, `tgt.tint = tgt.as_shot_tint + dTint`,
  clamped to slider range.
- This is the same relative-offset shape as the #6 roll scalars (which ship already), so
  Temp/Tint slot into that model: roll Temp/Tint become a mired/linear offset on each
  frame's as-shot.

### Auto-WB re-seed safety
- `wb_manual` still guards against base/profile changes auto-reseeding over a user WB.
- Pressing Auto WB sets the sliders to the as-shot estimate (so Auto == "reset to as-shot",
  which is intuitive), and clears `wb_manual`.

## Migration

Existing developed images carry `wb_baseline` (hidden) + temp 5500 / tint 0. On an
`ENGINE_VERSION` bump:
- Convert `wb_baseline` gains → `(temp, tint)` via the existing `gains_to_cct`.
- Set visible `temp`/`tint` to that; set `wb_baseline = [1,1,1]`.
- Seed `as_shot_temp/as_shot_tint` from a fresh `as_shot_wb`.
- Net render is unchanged (the visible WB now equals what the baseline produced).

## Touch list

- `crates/film-core` engine: WB from temp/tint only (baseline retired) — or keep the
  multiply with baseline forced to identity to minimise churn.
- `commands.rs`: `as_shot_wb` / `gray_point_wb` already return temp/tint; add `as_shot_*`
  reference fields; migration on load.
- `app/src/lib/develop/wb.ts` `applyAsShotWb`: set temp/tint instead of re-zeroing.
- `Develop.svelte` / `Basic.svelte`: Auto WB + gray-point set the sliders; drop the
  `wb_baseline` composition from `resolve_params` / `gpu_upload`.
- Copy-settings (`copySettings.ts`) + roll-apply: Temp/Tint as a mired/linear offset.
- Tests: an absolute-WB round-trip, a mired-offset copy/roll invariant, EV0/look-unchanged.

## Open questions for review
1. Retire `wb_baseline` entirely, or keep it = identity for compatibility? (Lean: keep the
   field, force identity, to avoid a schema migration — only the meaning of temp/tint changes.)
2. Should Auto WB == "reset Temp/Tint to as-shot" be the explicit semantics? (Lean: yes.)
3. Per-zone WB ("Color Drift Correction") is unaffected (separate residual layer) — confirm.
