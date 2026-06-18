# Develop Roll — Revision 1 (post-feedback)

> Execute via subagent-driven-development. Builds on the shipped feature (`2026-06-18-develop-roll-contactsheet.md`). Reuses `apply.ts`, `RollAdjust`, `ConfirmOverwrite`, `draft.ts`, `livePreview.ts`.

**Goal:** Rework the Develop section per user feedback into a two-mode UI: (default) a real-looking contact sheet whose right-panel sliders update all thumbnails live and persist to all frames — no Apply buttons; (reference-edit) tapping Crop / Film base / White point opens a center reference-frame layout where you sample/crop on one frame and it applies to all. Tapping a thumbnail opens a view-only fullscreen. Confirm once on entry (with "don't ask again").

## Global constraints (unchanged)
- Work on `main`; frontend TS/Svelte/i18n only; no Rust. i18n via CSV + `scripts/gen-i18n.py`.
- Concurrent user WIP in the tree — stage with EXPLICIT paths only, never `git add -A`/`.`/`-u`/`commit -a`. Verify `git diff --cached` has no `preReanalyze`/`revert`/`commands.rs`/`Viewport.svelte`/`hiTier`/`finish.rs`.
- Internal module value stays `"roll"`. Tune (`"develop"`) unchanged.

## Decisions
- **Live apply (no buttons):** moving any roll slider writes the look (tone/color via `applyToneColorToAll`) into EVERY developed folder frame's `editsById` AND regenerates+saves their thumbnails — debounced. No "Apply look" / "Apply base/wp/crop to roll" buttons anywhere. The `rollDraft` remains the single source the panels bind to; a debounced effect mirrors it to all frames.
- **Confirm-once on entry:** on entering Develop, if any developed folder frame has non-default edits AND the user hasn't set the skip-pref, show `ConfirmOverwrite` with a "Don't ask me again" checkbox. Confirm → enable live mirroring (+ persist pref if checkbox ticked). Cancel → return to Library (`module.set("library")`). If no frames have edits, or the skip-pref is set, enter directly with mirroring enabled.
- **Reference-edit mode:** Roll gains `mode: "sheet" | "crop" | "base" | "wp"`. In a non-sheet mode, render the center reference Viewport (the active frame) + the tool's controls (CropView/CropPanel, or BaseView + auto button, or wp crosshair) + the contact-sheet strip along the bottom. Each op writes the `rollDraft` (base/dmax/crop) and mirrors to all live; a Back/Done control returns to `"sheet"`. Reuse the logic currently in `FramePreview.svelte`.
- **View-only fullscreen:** tapping a sheet thumbnail opens a pure-view Viewport overlay (no edit tools). `FramePreview.svelte` is reduced to this.
- Keep `apply.ts` (`applyToneColorToAll`/`applyCropToAll`/`applyBaseToAll`/`applyWhitePointToAll`, `framesWithToneColor`) — now driven live, not by buttons.

---

## Task R1: Contact-sheet UI redesign (feedback #5)

**Files:** Modify `app/src/lib/tabs/Roll.svelte` (grid markup + style only).

Make the grid read as a real contact sheet: frames **edge-to-edge (gap: 0)**, **no per-cell border/box-shadow**, no rounded corners, no hover-lift. Pack tighter (smaller `minmax`, e.g. 150–180px) on a dark backing. A 1px hairline separator between cells (via a background grid color or `outline`) is fine for the "sheet" feel, but no drop shadows. Keep the cell clickable (tap → openFrame) and the `previewMap[id] ?? img.thumbnail` image source. Keep `object-fit: contain` so frames aren't cropped.

Gate: `npm --prefix app run check` (0 new errors) + visual: grid looks like a contact sheet (tight, flat).

Commit: `feat(develop): contact-sheet grid styling (tight, no gaps/shadows)`

---

## Task R2: Live-apply look + remove Apply button (feedback #3)

**Files:** Modify `app/src/lib/tabs/Roll.svelte`. Test: `app/src/lib/roll/applyLive.test.ts` (+ `app/src/lib/roll/applyLive.ts` if extracting).

- Replace the debounced live-PREVIEW (which only filled `previewMap`) with a debounced live-APPLY: render each developed folder frame's draft thumbnail (as today) AND, in the same batch, write the look into every frame via `editsById.set(applyToneColorToAll(get(editsById), ids, $rollDraft.params))`, set each `images[id].thumbnail` to the rendered data-URL, and `api.saveThumbnail(id, url)`. Use the existing stale-token guard so only the latest batch commits. Persistence is automatic via `editsById` write-through.
- Remove the "Apply look to roll" button and its `onApplyClick`/`applyLook`/`showConfirm`-for-look path. (The entry confirm is added in R4.)
- Keep `rollDraft` as the slider source; `$: scheduleLiveApply($rollDraft)` runs on every change.
- Extract the pure "which ids + merged params" decision into a tiny tested helper only if it clarifies; otherwise keep inline and rely on `apply.ts`'s existing tests. If extracting, the test asserts the batch writes a new editsById ref per id with the draft tone/color merged onto each frame's base/dmax.

Gate: type-check; manual: drag a slider → all sheet thumbnails update and persist (switch to Tune, frames carry the look).

Commit: `feat(develop): live-apply roll look to all frames (no Apply button)`

---

## Task R3: View-only fullscreen (feedback #1)

**Files:** Modify `app/src/lib/roll/FramePreview.svelte` (strip to view-only). Possibly modify `app/src/lib/tabs/Roll.svelte` (open on tap).

- Reduce `FramePreview.svelte` to a pure view-only fullscreen: the center Viewport rendering the tapped frame with its OWN current edits + committed crop (as the existing preview path already does), a Close button, and Escape. REMOVE all crop/base/wp tool state, the mode toggles, the apply buttons, BaseView, CropView/CropPanel, ConfirmOverwrite, pending dispatcher — everything except preview + close. (The crop/base/wp logic moves to R5's reference-edit mode.)
- `Roll.svelte`: tapping a sheet thumbnail still calls `openFrame(id)` → sets `rollReferenceId` → renders the view-only `FramePreview`.

Gate: type-check; manual: tap thumbnail → fullscreen view, Close/Escape returns; no edit controls present.

Commit: `feat(develop): view-only fullscreen frame preview`

---

## Task R4: Confirm-once on entry + "don't ask again" (answers)

**Files:** Modify `app/src/lib/roll/ConfirmOverwrite.svelte` (add checkbox), `app/src/lib/tabs/Roll.svelte` (entry gate), `app/src/lib/store.ts` (pref store), `app/src/lib/catalog.ts` (hydrate + persist pref), `/i18n-strings.csv` (+ regen).

- Add a persisted pref `rollOverwriteSkip` (boolean), wired in `catalog.ts` like the other prefs (`save_pref` key `roll_overwrite_skip`, hydrate from `snap.prefs`).
- `ConfirmOverwrite.svelte`: add a "Don't ask me again" checkbox; on confirm, dispatch `confirm` with `{ dontAsk: boolean }` (e.g. `dispatch('confirm', { dontAsk })`).
- `Roll.svelte` on mount: `resetRollDraft()`; compute `conflicts = framesWithToneColor(get(editsById), developed ids)` (also count crop/base/wp edits if cheap). If `conflicts.length > 0 && !$rollOverwriteSkip` → show the confirm and DO NOT enable live mirroring until confirmed. On confirm: if `dontAsk`, set the pref; enable mirroring. On cancel: `module.set("library")`. Otherwise enable mirroring immediately.
- New i18n rows for the checkbox label (`confirmOverwrite.dontAsk`).

Gate: type-check + dict regen (key present). Manual: edit a frame in Tune, enter Develop → confirm appears once; tick "don't ask again", confirm → never reappears; cancel → back to Library.

Commit: `feat(develop): confirm roll overwrite once on entry with don't-ask-again`

---

## Task R5: Reference-edit mode — crop / film base / auto base / white point (feedback #1, #2)

**Files:** Modify `app/src/lib/tabs/Roll.svelte` (mode + center reference layout + bottom strip), reuse crop/base/wp logic from the pre-R3 `FramePreview.svelte` (git history) and from `Develop.svelte`. i18n for the panel entry buttons + Back.

- Add `mode: "sheet" | "crop" | "base" | "wp"` to Roll. The right panel (sheet mode) shows `RollAdjust` (sliders) plus entry controls: a **Crop** button, a **Film base** section (Sample + Auto buttons), a **White point** (Pick) button. Tapping one sets `mode` and a reference frame (`activeId` ?? first developed frame).
- In a non-sheet mode, render a Tune-like layout: center Viewport on the reference frame + the tool's controls + the contact-sheet as a bottom strip (reuse the R1 grid, shorter). Port the crop state machine + BaseView + wp-pick exactly as they were in `FramePreview.svelte` before R3 (they wrote `rollDraft`), then mirror to all live (the R2 effect already mirrors tone/color; for crop/base/wp add equivalent debounced mirrors via `applyCropToAll`/`applyBaseToAll`/`applyWhitePointToAll` into all frames + thumbnail regen). A **Back/Done** control returns to `"sheet"`.
- **FIX feedback #2 (base pick doesn't fire after arming):** investigate `BaseView.svelte`'s CURRENT interface (user-modified) — confirm the event it dispatches and the props it needs (esp. whether it needs `imgW`/`imgH` from metadata and a correctly-armed pointer overlay). Ensure the BaseView overlay actually receives pointer events (z-index / pointer-events) and its `sampled` event is handled. Verify by manual sample.
- **FIX feedback #3 (re-pick doesn't refresh thumbnails):** after a base/wp/crop change, the live mirror must regenerate + save all thumbnails (same as R2). Ensure base changes trigger the mirror effect (the effect must depend on `rollDraft.params.base_override`/`d_max_override`/`crop`, not only tone/color).

Gate: type-check + dict regen. Manual: tap Film base → reference layout; sample base on the frame (works now) → all sheet thumbnails refresh; tap Crop → draw crop → applies to all; White point pick → applies to all; Back → contact sheet.

Commit: `feat(develop): reference-edit mode for crop/base/white-point, applied live to roll`

---

## Final
- Full suite `npm --prefix app run test:unit` green; `npm --prefix app run check` 0 errors.
- Whole-branch review of the revision diff.
- Manual pass of the whole Develop flow.
