# Basic panel control cleanup — design

**Date:** 2026-06-28
**Status:** Approved (pre-implementation)

## Problem

After shipping spoke-aware metering, the Develop → Basic panel stacks five
analysis-related controls as heavy full-width buttons + one segmented row:
**Inverse** (full-width), **Metering** (Auto / Exclude border / Whole crop segmented),
**Re-Analysis for crop** (full-width), **Revert re-analysis** (conditional full-width),
then Film Base. It reads as cluttered and redundant.

Two observations drive the cleanup:

- **Inverse** is a *mode* toggle (negative↔positive), conceptually a sibling of the HDR
  toggle — not an "analysis" control. It belongs in the header with HDR/Reset.
- **Metering**, **Re-Analysis**, and **Revert** are all "how the current crop is
  analyzed." Since changing Metering already re-meters the crop, Re-Analysis/Revert are
  secondary actions that do not need full-width buttons.

## Goal

Reduce the body from four stacked controls (Inverse + Metering + Re-Analysis + Revert) to
a single "Metering" cluster, and move neg/pos selection into the header — without changing
any underlying behavior.

## Non-goals

- No change to the underlying actions or their re-meter behavior (`togglePositive`,
  `manualReanalyze`, `revertReanalyze`, `setMeterBorder` are unchanged).
- No Rust/engine/param changes. This is presentational rewiring of `Basic.svelte` only.
- No relabeling of the metering modes (Auto / Exclude border / Whole crop stay).

## Target layout

```
Basic                    [ Neg | Pos ]  HDR  Reset      ← header
─────────────────────────────────────────────────
Metering                                    ⟳  ↩        ← label row (icons negatives-only)
[ Auto ] [ Exclude border ] [ Whole crop ]              ← segmented control, full width

FILM-EDGE COLOR
[ swatch ]
...(unchanged below)
```

## Design

### 1. Header — `[Neg|Pos]` segment

Add a two-state segmented toggle to the header's right-hand button group, BEFORE the HDR
toggle. Bound to `$params.positive`:

- "Neg" segment is active (highlighted) when `!$params.positive`; "Pos" when
  `$params.positive`.
- Clicking the inactive segment calls the existing `togglePositive` (which already
  re-meters via `remeterActiveExposure(false)`). Clicking the already-active segment is a
  no-op (guard on the handler, or only flip when the clicked state differs).
- Disabled when there is no active image (`!$activeId`), matching the "Apply to roll"
  disabled pattern.

This replaces the full-width **Inverse** button: same action, now showing the current
classification instead of a blind flip.

### 2. Body — single "Metering" cluster

Replace the standalone `wbhead` metering row + the two full-width re-analysis buttons with
one cluster:

- A label row: `Metering` label on the left; two icon buttons right-aligned.
  - **⟳ re-analyze** icon button → `manualReanalyze` (today's "Re-Analysis for crop").
    `title`/`aria-label` reuse the existing `base.reanalyze` string.
  - **↩ revert** icon button → `revertReanalyze`, rendered only when
    `$preReanalyze && $preReanalyze.id === $activeId` (the SAME condition that gates
    today's revert button). `title`/`aria-label` reuse `base.revertReanalyze`.
  - Both icons are negatives-only: wrap them in `{#if !$params.positive}` (D_max/WB
    re-analysis does not apply to positives). On positives the label row shows just
    "Metering".
- Below the label row: the existing 3-button segmented control (Auto / Exclude border /
  Whole crop), full width, unchanged in behavior. It stays visible for both positives and
  negatives (it drives exposure + WB on positives too).

### 3. Removed controls

- The full-width **Inverse** button (`button.recal.inverse`) — replaced by the header
  segment.
- The full-width **Re-Analysis for crop** button (`button.recal.reanalyze`) — replaced by
  the ⟳ icon.
- The full-width **Revert re-analysis** button (`button.recal.revert`) — replaced by the
  ↩ icon.

The `{#if !$params.positive}` block that currently wraps reanalyze/revert/Film Base is
restructured: the reanalyze/revert move into the Metering cluster's icon row (still
negatives-gated); the Film Base swatch + low-confidence hint stay negatives-only as today.

### 4. i18n & icons

- New CSV rows (then `python3 scripts/gen-i18n.py`): `basic.negative` and
  `basic.positive`, `note` = `option`, `file` = `src/lib/develop/Basic.svelte`. Values:
  en `Neg`/`Pos`, zh `负`/`正`, ja `ネガ`/`ポジ`, ko `네거`/`포지`.
- The `basic.inverseBtn` CSV row is removed (the full-width button is gone). Confirmed:
  `basic.inverseBtn` is referenced ONLY by the button being deleted (grep across `app/src`
  shows only `Basic.svelte:342` + the generated `dict.ts`). Regenerate so `dict.ts` drops
  the dead key.
- The ⟳ and ↩ icons reuse existing tooltip strings (`base.reanalyze`,
  `base.revertReanalyze`) — no new i18n for those.
- Icons: use the EXISTING `Icon` glyphs `rotate-cw` (⟳ re-analyze) and `rotate-ccw`
  (↩ revert) — a matched CW/CCW pair already in the set (`app/src/lib/icons/Icon.svelte`),
  so NO new icon assets are added. (The Basic panel has no image-rotate control, so the
  rotate glyphs won't be confused with rotation here. If GUI smoke finds them ambiguous, a
  follow-up can add a dedicated `refresh-cw` glyph — out of scope for this change.)

### 5. CSS

- Header `[Neg|Pos]` segment: a small two-button segmented control styled to match the
  existing header toggles (`hdrtoggle`/`reset`) and the body `wbbtns` active-state
  (`.on`). Keep it compact so the header (title + segment + HDR + Reset) fits the ~280px
  panel; allow graceful wrap if space is tight.
- Icon buttons (⟳ ↩): small, borderless/subtle, sized like other inline icon affordances
  (e.g. the base-swatch pipette), with hover state.

## Accessibility

- The `[Neg|Pos]` segments: `aria-pressed` reflecting the active state; accessible labels
  from `basic.negative`/`basic.positive`.
- Icon buttons: `aria-label` + `title` from the reused strings.

## Testing

- `cd app && npm run check` — 0 errors (the gate for this Svelte change; there is no unit
  harness for the markup).
- Manual GUI smoke (user): header Neg/Pos flips the image and shows the current state;
  ⟳ re-analyzes the crop; ↩ appears only after a re-analysis and reverts it; the Metering
  segmented control still switches modes and re-meters; on a positive image the ⟳/↩ icons
  are hidden but the Metering segment remains; header doesn't crowd/overflow.

## Risks

- Header crowding on a narrow panel (title + segment + HDR + Reset). Mitigation: short
  "Neg"/"Pos" labels; verify and allow wrap.
- Discoverability: re-analyze/revert become icons rather than labeled buttons. Mitigation:
  tooltips (reused strings) + they remain in the natural "Metering" cluster where a user
  looking to re-derive the crop would expect them.
