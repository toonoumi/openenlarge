# Undo / Redo Across All Per-Image Edits — Design

**Date:** 2026-06-05
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch context:** `feat/gpu-develop-pipeline`

## Problem

Undo today is eraser-only: `⌘Z` while the eraser tool is active slices the last
stroke off `dustById` (`Develop.svelte:121`, `dust.ts:undoStroke`). There is no
redo, and no other action is undoable. We want full **undo (⌘Z / Ctrl+Z)** and
**redo (⌘⇧Z / Ctrl+⇧Z)** across every per-image edit.

## Scope & decisions

- **History scope:** per-image timelines. Each image has its own independent
  undo/redo stack; switching images switches which stack is active.
- **Coverage (all per-image edits):**
  - Basic adjustments, tonal curve, color grading → `editsById` (`InvertParams`)
  - Crop / 90° rotate / flip / straighten → `cropById` (`CropRect`), including the
    `⌘]` / `⌘[` rotate shortcuts
  - Eraser strokes + IR-removal toggle/sensitivity → `dustById` (`DustEdits`)
  - Per-section Reset buttons (one reset = one undo step)
  - Per-image metadata overrides → `metaById` (`MetaOverride`)
- **Granularity:** one undo step per *gesture* (a whole slider drag, one curve-point
  drag, one brush stroke), matching today's eraser behavior and Lightroom/Photoshop.
- **Persistence:** the undo/redo **history stack is in-memory only** — never written
  to the catalog/disk; gone on app quit. (The *edits themselves* still persist via
  the existing `catalog.ts` store wiring; undo just writes old values back into those
  stores, which persist as normal.)
- **Delete is NOT undoable.** It removes catalog rows and may move the original file
  to the system Trash — out of scope for undo. Instead, the ConfirmDelete popover
  gains a "This can't be undone." warning.

## Architecture — snapshot-based per-image history

Chosen over a command pattern (too much per-action inverse code, brittle, fiddly
with the crop draft) and per-slice deltas (cross-store gestures push back toward a
tuple model anyway). The state is already cleanly separated into per-id maps, so
snapshotting the active image's tuple is trivial and cheap.

### New module: `app/src/lib/develop/history.ts`

The unit of history is a per-image snapshot of the editable tuple:

```ts
interface EditSnapshot {
  params: InvertParams;     // from editsById
  crop: CropRect | null;    // from cropById
  dust: DustEdits;          // from dustById
  meta: MetaOverride;       // from metaById
}

interface ImageHistory {
  past: EditSnapshot[];     // states before the current one (undo targets)
  future: EditSnapshot[];   // states undone (redo targets)
  present: EditSnapshot;    // the live committed state
}
```

A single store `historyById: writable<Record<string, ImageHistory>>` holds one stack
per image id. It is **never wired into `catalog.ts`** — that is what keeps it
ephemeral.

### Module API

```ts
seed(id, snapshot): void        // first touch: present = snapshot, empty stacks
commit(id, snapshot): void      // push present→past, present = snapshot, clear future.
                                //   No-op if deep-equal to present.
undo(id): EditSnapshot | null   // present→future, pop past→present; null if past empty
redo(id): EditSnapshot | null   // present→past, pop future→present; null if future empty
canUndo(id) / canRedo(id): boolean
drop(id): void                  // remove an image's history (called from deleteImage)
```

- `commit`'s deep-equality guard means a gesture that ends with no net change (drag a
  slider and release where it started) produces no step.
- A per-image cap (default **50** steps) trims the oldest `past` entry when exceeded.
- Any new `commit` clears `future` (standard redo invalidation) — baked into the API.

### Applying a snapshot back into the app

Undo/redo return an `EditSnapshot`; an applier writes each field into its existing
store for that id:

```ts
editsById.update(m => ({ ...m, [id]: snap.params }));
cropById.update(m => ({ ...m, [id]: snap.crop }));
dustById.update(m => ({ ...m, [id]: snap.dust }));
metaById.update(m => ({ ...m, [id]: snap.meta }));
dustRev++;   // existing Viewport re-render trigger
```

Routing through the same stores means the existing reactive pipeline (Viewport
re-render, thumbnail refresh, catalog persistence) just works — no special-casing.

## Gesture-boundary capture

Rule: **snapshot the active image's tuple once, when a gesture ends.** No "begin"
call — because we snapshot the *result* after each gesture and diff against `present`,
we never capture mid-drag frames. `currentSnapshot()` reads the four stores for the
active id.

| Control | Commit signal |
|---|---|
| Basic / color sliders (`<input type=range>`) | native `change` event (fires on pointer release, not during drag) |
| Tonal curve, color wheels, eraser | `pointerup` ending the drag (already custom pointer editors) |
| Crop / rotate / flip / straighten | crop already commits as one unit on tool-exit / Enter (`commitCrop`); the `⌘]`/`⌘[` and flip/rotate buttons each commit once |
| Section Reset buttons, IR toggle, metadata fields | the click / `change` is itself the boundary — commit immediately |

Each commit point calls `commit(activeId, currentSnapshot())`.

## Keyboard wiring & scope

The key-matching + dispatch lives in `history.ts` as a helper used by both modules so
logic isn't duplicated. Replace the eraser-only handler in `Develop.svelte:121`, and
add the same binding to `Library.svelte` (for metadata undo, since metadata is edited
in the Library module).

- **⌘Z / Ctrl+Z** → `undo(activeId)`, apply result. No-op (and do *not*
  `preventDefault`) when `canUndo` is false, so the OS/browser default isn't swallowed.
- **⌘⇧Z / Ctrl+⇧Z** → `redo(activeId)`. Also accept **Ctrl+Y** (Windows redo
  convention) on the redo path.
- Both bindings are **suppressed while a text field is focused** (reuse existing
  `formFocused()`), so undo inside a metadata text input does native text undo, not
  image undo. Range/slider inputs are *not* text fields, so slider undo still works.
- **Tool-independent:** undo works in `edit`, `crop`, and `eraser` tools alike (today
  it is gated to `eraser`).

## Delete warning

In `ConfirmDelete.svelte`, add a one-line caution under the existing `.sub` text:
*"This can't be undone."* No behavior change to the delete flow itself.

## Edge cases & decisions

- **Baseline seeding:** the first time an image is committed to (or first becomes
  active in Develop), call `seed(id, currentSnapshot())` so the initial developed
  state is the floor of the stack — undo can return you to "no edits," and the first
  edit is itself undoable.
- **Switching images:** stacks are keyed by id, so switching is free; each image keeps
  its own past/future. No clearing on navigation.
- **Delete:** `deleteImage` in `workflow.ts` already drops the per-image stores; add
  `history.drop(id)` alongside so a removed image's stack is freed.
- **Crop draft:** undo while *inside* the crop tool applies to the committed `cropById`
  snapshot and re-syncs the draft (`rect`, `rot90`, …) from it so the overlay reflects
  the undo. Reuse the existing `startCrop()` re-sync logic after an undo/redo that
  changed the crop.
- **Section Reset:** one reset = one snapshot = one undo step.
- **`dustRev`:** undo/redo bump it so the Viewport re-renders, same as live eraser edits.
- **Memory:** 50 snapshots × small objects per image; dust strokes are the only
  potentially large field and are already held live in `dustById`.

## Testing

The engine is pure and store-driven (testable like `dust.test.ts` / `perImage.test.ts`):

- **`history.test.ts`** — seed/commit/undo/redo ordering; `future` cleared on new
  commit; deep-equal commit is a no-op; cap trims oldest; `drop` removes a stack;
  undo/redo at stack boundaries return `null`.
- Integration-style test: an undo writes values back into
  `editsById`/`cropById`/`dustById`/`metaById` for the right id.
- Keyboard-matching helper tested in isolation (⌘Z vs ⌘⇧Z vs Ctrl+Y; `formFocused`
  suppression).

## Out of scope

- Undoing delete / file-trash recovery.
- Persisting history across sessions.
- A global cross-image timeline ("most-recent-action-wins").
- Visible undo/redo UI buttons or a history panel (keyboard only for now).
