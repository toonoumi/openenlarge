# Multi-folder import — design

Issue: https://github.com/MohaElder/openenlarge/issues/15

## Problem

Importing requires selecting folders one at a time, which is tedious for many
folders/rolls. Allow selecting multiple folders at once, recursing into nested
subfolders so each becomes its own roll.

## Why this is small

`list_dir_files` (Rust) already walks subfolders recursively. Folders/rolls are
**derived dynamically** from each image's `path` (see `folderTree.ts`,
`folderScope.ts`) — there is no persistent folder entity. So importing files from
many (possibly nested) folders automatically yields the correct per-folder
grouping. No backend changes, no state-model changes.

## Changes

### 1. Picker — multi-select + recurse (`FolderNav.svelte::pickFolderAndImport`)

- Dialog: `openDialog({ directory: true, multiple: true })` → `string[] | string | null`.
- Normalize to `string[]`.
- For each dir, `api.listDirFiles(dir)` concurrently (`Promise.all`) — each already recurses.
- Flatten + **dedupe** the file lists: selecting both a parent and a child would
  otherwise list the child's files twice. Extract a pure helper
  `mergeFolderFiles(lists: string[][]): string[]` (dedupe via `Set`, order-preserving)
  so it is unit-testable without the dialog.
- `selectImportPaths(merged, $omitPreviewJpgs)` then `importPaths(...)` as today.

### 2. Live-count progress (`workflow.ts::importPaths`)

- Add optional `onProgress?: (done: number, total: number) => void`.
- Call after each `importOne` completes, via a shared counter (correct under the
  4-lane concurrency).
- Drag-drop / file-import callers omit it → unchanged.
- `FolderNav.svelte`: track `importProgress`; button shows `Importing {done}/{total}…`
  while importing with known counts, else the plain spinner string (during the scan phase).

### 3. i18n

- Add `folderNav.importingCount` = `Importing {done}/{total}…` (+ zh/ja/ko) to
  `i18n-strings.csv`; regenerate with `scripts/gen-i18n.py` (never hand-edit `dict.ts`).
- `t()` already supports `{done}`/`{total}` interpolation.

## Error handling

- Per-folder scan failures: caught + logged; the other folders still import.
- Per-file failures: already swallowed by `importOne`.

## Testing

- Unit test `mergeFolderFiles`: dedupes across overlapping parent/child lists,
  preserves first-seen order.
- Existing `selectImportPaths` tests cover extension filtering / preview omission.
