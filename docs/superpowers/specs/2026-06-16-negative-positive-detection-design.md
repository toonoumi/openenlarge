# Negative / Positive Detection on Develop

**Date:** 2026-06-16
**Status:** Design — approved for planning

## Problem

The app assumes every developed image is a color negative and unconditionally
applies the Cineon densitometry inversion (`engine.rs:81` `invert_d`) at render
and export time. Users also load positives (slides, prints, already-positive
scans). For those, the inversion produces a wrong, washed/inverted result and
there is no way to edit them as-is.

We want Develop to classify each image as **negative** or **positive**:
- Negatives: inverted as today.
- Positives: rendered as a passthrough (no inversion) but still fully editable
  with generic tone/color/crop/dust controls.
- Either classification is one tap to override, because the detector will not be
  perfect across the range of film types.

The detector must work across at least:
- Standard C-41 color negative (orange mask base)
- Black & white negative (neutral / clear base — no orange mask)
- Harman Phoenix (thin, bluish base — not orange)
- Positive slides / prints (dense black rebate, natural-looking image)

Because B&W, Phoenix, and slides all have non-orange bases, **base color alone
cannot drive the decision.**

## Detection

Runs inside the Develop pipeline (`developImage`, `commands.rs`) after the image
is decoded into the working/proxy buffer and before/alongside the existing
auto-base + D_max steps.

**Signal: tonal inversion, not base color.** A negative is tonally inverted
relative to the scene — scene highlights are dense (dark) on film, shadows are
clear; overall the frame is low-contrast with a dominant cast, and the film
rebate/border sits near the *minimum* density. A positive reads as a normal
photograph — natural contrast and tone distribution, with a dense (near-black)
rebate where one is present.

The detector produces:
- `mode: 'negative' | 'positive'`
- `confidence: number` (0..1)

**Fallback:** when the signal is ambiguous / low confidence, default to
`negative` (preserves today's behavior). The override makes this low-stakes.

The exact heuristic (which statistics, thresholds, whether to sample the rebate)
is expected to need iteration; it is the riskiest part of the feature. The
symmetric, always-available override is what makes shipping an imperfect
detector safe.

**Analysis always runs.** Auto-base and D_max sampling run on every image
regardless of detected mode, so that tapping "Inverse" on a detected positive is
instant (no re-develop, no spinner). Positives simply do not consume those
results unless flipped to negative.

## Render pipeline

Two branches keyed off the per-image `mode`:

- `mode === 'negative'` → existing Cineon inversion path, unchanged
  (`engine.rs` `invert_d`, GL `invert.ts`).
- `mode === 'positive'` → **passthrough**: decode → display with only generic
  tone/color applied (exposure, contrast, white balance, saturation), plus crop
  and dust. Inversion-specific math (film base, D_max, print exposure, paper
  grade) is skipped.

This requires a positive branch in both:
- CPU engine (`crates/film-core/src/engine.rs`)
- GL preview shader / uniform resolution (`app/src/lib/viewport/gl/invert.ts`)

Export uses the same branch so a positive exports as its passthrough render.

## UI — Basic panel (`app/src/lib/develop/Basic.svelte`)

The panel adapts to the active image's `mode`.

**Detected negative:**
- Panel as today: "Re-Analysis for crop" + "FILM-EDGE COLOR" swatch, plus the
  existing low-confidence base warning.
- Adds a quiet escape hatch: a subtle link/button —
  "Looks like a negative — treat as positive instead?" — to correct a
  mis-detected negative in one tap.

**Detected positive:**
- "Re-Analysis for crop" and "FILM-EDGE COLOR" are **replaced** by:
  - an **Inverse** button, and
  - a label: "This is a positive image. Tap to invert it anyway."
- The generic tone/color/crop/dust controls remain visible and live.
- The inversion-specific controls stay hidden while in positive mode.

**Override behavior (both directions):**
- Tapping flips the active image's `mode`, persists it, and re-renders live.
- Inversion-specific controls appear/disappear accordingly.
- Fully reversible — flipping back restores the prior state. Since analysis
  always ran during Develop, no recompute is needed on flip.

## State

Extend the per-image edits structure (`app/src/lib/perImage.ts`, `InvertParams`
in `app/src/lib/api.ts`) with:
- `mode: 'negative' | 'positive'`
- `modeConfidence: number` (detector output; used only to drive the
  low-confidence affordance / wording, not gating)

`mode` is set by the detector during Develop and overwritten by the user
override. It persists per image like the other edits in `editsById[imageId]`.

Whether `mode` lives literally inside `InvertParams` or as a sibling per-image
field is an implementation detail for the plan; it must round-trip through the
catalog persistence the same way other per-image edits do.

## i18n

New strings (Inverse button, positive-image label, "treat as positive" link)
are added to `/i18n-strings.csv` and `dict.ts` is regenerated via
`scripts/gen-i18n.py`. `dict.ts` is never edited by hand.

## Out of scope

- Per-stock auto-profiling beyond the negative/positive decision.
- Detecting *which* positive medium (slide vs. print) — positives are one
  passthrough path.
- Batch "mark all as positive" controls — override is per image. (Can be a
  follow-up if needed.)

## Risks

- **Detector accuracy** across B&W / Phoenix / slides from a single tonal
  signal. Mitigated by the symmetric one-tap override and the
  default-to-negative fallback.
- **Engine passthrough correctness** — the engine and GL shader are built around
  inversion; the positive branch must cleanly bypass the inversion-specific
  uniforms without disturbing the negative path.
