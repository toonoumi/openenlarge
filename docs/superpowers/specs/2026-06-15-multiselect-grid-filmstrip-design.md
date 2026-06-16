# Multi-select + multi-delete for grid & filmstrips

Date: 2026-06-15

## Goal

Add Ctrl/Cmd-click, Shift-click, and Ctrl/Cmd+A multi-selection to:

- the Library grid (`Grid.svelte`),
- the Library bottom thumbnail row (`Filmstrip.svelte`),
- the Develop bottom thumbnail row (same `Filmstrip.svelte`),

and let the context-menu delete operate on the whole selection, showing
"Delete N items".

## Model

Two coexisting concepts:

- **`activeId`** (unchanged) — the single image Develop's viewport and the
  Metadata panel render. Shown with the existing white ring.
- **`selection`** (new) — the multi-select set, drawn with an additional
  "selected" highlight distinct from the active ring.

Behaviour (per user decisions):

- **Active stays coupled.** A plain (no-modifier) click selects exactly that
  image *and* makes it active. Modifier clicks build the selection without
  changing which image is active.
- **Context-menu delete acts on the whole current selection** ("Delete N
  items"). Right-click does not alter the selection.
- **Selection clears** on folder change, after a delete, and on a plain click
  (collapses to the clicked item). It is *not* cleared when switching
  Library<->Develop.

### Click semantics (reuse `selection.ts`)

The pure helpers in `selection.ts` already implement this and are unit-tested:

- plain click -> `{selected: {id}, anchor: id}`
- Ctrl/Cmd click -> toggle `id`, anchor = `id`
- Shift click -> range from `anchor` to `id`

## Components & changes

### `app/src/lib/selection.ts` (moved from `export/selection.ts`)

Pure, no export-specific code. Move to a shared home; update imports in
`export/ExportModal.svelte` and `export/selection.test.ts` (and the test file
itself moves alongside or just re-points its import). ExportModal keeps its own
*separate* local `SelState` for choosing which images to export — untouched.

### `app/src/lib/store.ts`

- `selection = writable<SelState>(noneSelected())`
- `setActive(id)` — `activeId.set(id)` and collapse selection to `{id}`. Used by
  plain click, arrow-key nav, and `selectFolder`.
- `selectClick(id, mods)` — plain -> `setActive(id)`; Ctrl/Cmd or Shift ->
  `selection.update(s => click(s, ids, id, mods))` leaving `activeId` untouched.
  `ids` comes from `get(folderImages)`.
- `selectAll()` — `selection.set(allSelected(folderImageIds))`.
- `deleteSelectionIds()` — returns selection set if non-empty, else
  `[activeId]` (filtered for null). The single source of truth for what a
  delete affects.
- `selectFolder()` also resets `selection`.

### `deleteTarget` -> `string[]`

`deleteTarget` becomes `writable<string[]>([])` (empty array = no dialog).

- `+page.svelte`: `runDelete` loops `deleteImage(id, deleteFile)` over the ids;
  `deleteName` shows the single filename when length === 1, else "". Pass
  `count` to `ConfirmDelete`.
- `ConfirmDelete.svelte`: new `count` prop. Title "Delete N items?" when
  count > 1, else existing "Delete {name}?".

### Interaction wiring

- `Grid.svelte`: cell `on:click={(e) => selectClick(img.id, mods(e))}`; add
  `.multi` class when `$selection.selected.has(img.id)`.
- `Filmstrip.svelte`: same (covers both Library and Develop bottom rows).
- `Library.svelte` / `Develop.svelte` window keydown:
  - Ctrl/Cmd+A -> `selectAll()` (skip when a text field is focused).
  - Ctrl/Cmd+Backspace -> `deleteTarget.set(deleteSelectionIds())`.
  - Arrow-key nav -> `setActive` (collapses selection), keeping today's feel.
- Context menus:
  - `ImageContextMenu` (Library) and `QualityMenu` (Develop) show "Delete N
    items" (singular "Delete image" when 1) and dispatch delete ->
    `deleteTarget.set(deleteSelectionIds())`.
  - In `Develop.svelte`, right-clicking a filmstrip thumbnail (closest
    `[data-id]`) opens `ImageContextMenu`; right-click elsewhere keeps
    `QualityMenu`.

### i18n (`dict.ts`, `en` + `zh`)

- `confirmDelete.titleCount`: "Delete {count} items?" / "删除 {count} 张照片？"
- `contextMenu.deleteCount`: "Delete {count} items" / "删除 {count} 张照片"
  (the existing singular `contextMenu.delete` / `quality.deleteImage` stay for
  count === 1).

## Highlight styling

- Active: existing white ring (`.sel` in Grid, `.active` in Filmstrip).
- Multi-selected: a subtler fill/border (e.g. accent-tinted background or 1px
  accent ring) so a multi-selected-but-not-active cell is visually distinct
  from both unselected and active.

## Testing

- `selection.ts` helpers: already covered by `selection.test.ts`.
- Add a unit test for `deleteSelectionIds` semantics (selection vs active
  fallback) if it can be factored as a pure function over `(selectedIds,
  activeId)`.
- Build (`npm run build` / `svelte-check`) + manual verification for the Svelte
  wiring and styling.

## Out of scope

- No batch develop/edit from the grid selection (delete only).
- ExportModal's own selection is unchanged.
