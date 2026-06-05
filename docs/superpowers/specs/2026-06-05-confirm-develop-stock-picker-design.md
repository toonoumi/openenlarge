# Film-Stock Picker on Confirm Develop Design

**Date:** 2026-06-05
**Branch:** `main`
**Status:** Approved, ready for implementation planning

## Goal

When the user taps "Develop all" and the Confirm Develop dialog appears, offer an
**optional** film-stock picker. The chosen stock is applied to every image this
develop-all run processes (the undeveloped images in the selected folder), so a
whole roll can be set to its film stock in one action instead of per-image.

## Resolved decisions

- **Scope:** the stock applies to **only the images being developed in this run**
  — i.e. the undeveloped images in the selected folder (`undevelopedIds(folderImages)`),
  the exact set `developAll()` already iterates. Already-developed frames are untouched.
- **Optional:** the picker defaults to "No film profile" (`none`). If left there,
  behavior is identical to today (no stock change).
- **Per-image apply, not a folder default:** the stock is written to each image's
  `params.stock` (a normal `InvertParams` field) and persisted like any edit. This
  is a one-time batch apply, not a new persistent folder-scoped store.
- **Overwrite:** within scope, the chosen stock overwrites each image's current
  `stock`. (At a fresh develop these are all the `"none"` default anyway.)

## Current state (relevant facts)

- `ConfirmDevelop.svelte` (`app/src/lib/overlay/ConfirmDevelop.svelte`) is a simple
  dialog: prop `count`, dispatches `confirm` / `cancel`. Shown via a `confirming`
  state in `app/src/routes/+page.svelte`; its `confirm` handler calls `developAll()`.
- `developAll()` (`app/src/lib/workflow.ts:20`) computes
  `ids = undevelopedIds(get(folderImages))`, sets `developProgress`, loops
  `api.developImage(id)`, then switches to the Develop module. `undevelopedIds`
  is a pure exported helper.
- Film stock is `params.stock: "none" | "portra400" | "fujic200"` on `InvertParams`
  (`app/src/lib/api.ts`). Per-image params live in the `editsById` store
  (`app/src/lib/store.ts`, `perImage.ts`); a per-image entry may be absent until
  edited (defaults resolve lazily via `defaultParams()`).
- Persistence is a debounced write-through: `catalog.ts` subscribes to `editsById`
  and saves each changed id via `api.saveEdits(id, JSON.stringify(params))`. Updating
  `editsById` is sufficient to persist; no explicit save call needed.
- Stock option strings exist: `basic.noFilmProfile`, `basic.stock.portra400`,
  `basic.stock.fujic200`. i18n is generated from `i18n-strings.csv` via
  `scripts/gen-i18n.py` (do not hand-edit `dict.ts`).

## Architecture

### Component: dialog picker

`ConfirmDevelop.svelte` gains a local `let stock = "none"` and a `<select bind:value={stock}>`
with three `<option>`s (none / portra400 / fujic200) above the button row. The confirm
button dispatches the choice: `dispatch("confirm", { stock })`. `cancel` is unchanged.
A small "(optional)" hint clarifies it can be skipped.

### Helper: pure batch-set

A pure, testable helper in `workflow.ts`:

```
applyStockToIds(
  editsMap: Record<string, InvertParams>,
  ids: string[],
  stock: string,
  makeDefault: () => InvertParams,
): Record<string, InvertParams>
```

Returns a new map where each id in `ids` has `stock` set (seeding from
`editsMap[id] ?? makeDefault()`). Ids not in `editsMap` get a fresh default with
the stock applied. Pure — no store or IO access.

### Flow: develop-all with stock

`developAll(stock?: string)`:
1. `const ids = undevelopedIds(get(folderImages));`
2. If `stock && stock !== "none"`, do a single
   `editsById.update((m) => applyStockToIds(m, ids, stock, defaultParams))`.
   The debounced write-through persists each changed id.
3. Proceed exactly as today (progress overlay, develop loop, switch to Develop).

### Wire-through

`+page.svelte`'s ConfirmDevelop `on:confirm` handler reads the emitted
`event.detail.stock` and calls `developAll(stock)`.

### Strings

Add to `i18n-strings.csv` (then regenerate `dict.ts`):
- `confirmDevelop.filmStock` — en "Film stock", zh "胶片型号"
- `confirmDevelop.filmStockOptional` — en "optional", zh "可选"

Option labels reuse the existing `basic.noFilmProfile` / `basic.stock.*` keys.

## Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `ConfirmDevelop.svelte` | Render dialog + optional stock select; emit `{stock}` on confirm | i18n |
| `applyStockToIds` (workflow.ts) | Pure: set stock on given ids in an edits map | `InvertParams`, `defaultParams` |
| `developAll(stock?)` | Apply stock to undeveloped ids, then develop them | `applyStockToIds`, `editsById`, `folderImages`, `api.developImage` |
| `+page.svelte` confirm handler | Pass emitted stock into `developAll` | `developAll` |

## Error handling & edge cases

- **Stock = none / omitted:** no edits-map mutation; identical to current behavior.
- **No undeveloped images:** `ids` is empty; `applyStockToIds` is a no-op; `developAll`
  early-returns to the Develop module as today.
- **Image with no editsById entry:** `applyStockToIds` seeds from `defaultParams()`.
- **Invalid stock value:** the dialog only emits one of the three known values; the
  helper does not validate further (the backend treats unknown stock as `none`).

## Testing

- **Unit (`applyStockToIds`):** sets stock on listed ids; seeds defaults for absent
  ids; leaves out-of-scope ids untouched; returns a new map (no mutation).
- **Unit (`developAll`):** with a stock, the undeveloped ids get the stock in
  `editsById` before/around develop; with `"none"`, `editsById` is unchanged. (Mock
  `api.developImage`.)
- **Manual:** import a roll, Develop all, pick Portra 400 → open frames → each inverts
  with Portra and persists across restart; picking "No film profile" leaves stock
  unchanged.

## Out of scope (YAGNI)

- Making the develop-time grid thumbnail reflect the chosen stock (would require a
  backend `develop_image` params change). The thumbnail updates once the frame is
  opened in Develop. Documented limitation.
- A persistent folder-default stock store (the user asked for a one-time per-image
  apply to the frames being developed).
- Per-image stock selection within the dialog (one stock for the batch).
