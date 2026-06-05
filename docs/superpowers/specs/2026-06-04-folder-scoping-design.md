# Folder-scoping the image views

**Date:** 2026-06-04
**Status:** Approved

## Problem

Images can be imported from N folders. The Grid is already scoped to the selected
folder (by exact directory match), but the **bottom thumbnail row (Filmstrip)**, the
**Develop navigation range** (arrow keys), and **Develop-all** all operate over the
entire imported set regardless of folder. The user wants every image view scoped to
the currently selected folder.

Selection must be **recursive on parents**: selecting `film_scan/ny2026-2` shows only
`-2`; selecting the parent `film_scan` shows everything imported underneath it
(`-1`, `-2`, …).

## Decisions

- **Develop-all scope:** develops only the undeveloped images in the selected folder.
- **On folder switch:** if the active image is not in the newly selected folder,
  select the first image of that folder as active.

## Design

### 1. Folder membership predicate — `lib/library/folderScope.ts` (pure, tested)

```
imageDir(img)            → normalized real directory of img.path
inFolder(dir, selected)  → selected == null ? true
                         : dir === selected || dir.startsWith(selected + "/")
```

`startsWith(selected + "/")` gives recursive parent scoping. `null` = show all
(initial state before any folder is chosen).

### 2. Real-path folder tree

`buildTree` currently emits a synthetic `/MacintoshHD/...` prefix for non-volume
paths, which never matches a real image directory — a latent bug that breaks parent
selection on the internal drive (works for `/Volumes/...` only because synthetic ==
real there). Fix: each tree node's `fullPath` is the **real** path prefix; display
name "Macintosh HD" is unchanged. No change for `/Volumes` scans.

### 3. One scoped derived view — `store.ts`

```
folderImages = derived([images, selectedFolder],
  ([imgs, sel]) => imgs.filter(i => inFolder(imageDir(i), sel)))
```

Swap `$images` → `$folderImages` in:

| Consumer | File | Change |
|---|---|---|
| Grid | `library/Grid.svelte` | use `$folderImages` (drop inline exact-match filter) |
| Filmstrip | `panels/Filmstrip.svelte` | iterate `$folderImages` |
| Develop arrow-nav | `tabs/Develop.svelte` | nav list = `$folderImages` |
| Library arrow-nav | `tabs/Library.svelte` | nav list = `$folderImages`; ↑/↓ = first/last of folder |
| Develop-all | `workflow.ts` | `undevelopedIds` over folder-scoped list |

`markAllUndeveloped` (quality change) stays global.

### 4. Selection follows the folder

A `selectFolder(path)` action used by `TreeNode` click: set `selectedFolder`, then if
`activeId`'s image is not in the new folder, set `activeId` to the first
`folderImages`. Library arrow-nav already sets active + syncs folder. Default
auto-select unchanged.

## Testing

Unit: `inFolder` (exact / child / parent-recursive / sibling-excluded / null=all),
`buildTree` real-path roots, `undevelopedIds` folder scoping. Svelte wiring verified
by build + GUI click-through.

## Out of scope

Persistence, multi-folder selection, folder-tree UI redesign.
