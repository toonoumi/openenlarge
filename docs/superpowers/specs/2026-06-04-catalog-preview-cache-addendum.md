# Catalog Persistence — Preview/Working Cache Addendum

**Date:** 2026-06-04
**Branch:** `feat/catalog-persistence`
**Status:** Approved (fixes the relaunch "still asks to develop" bug)

## Problem

The catalog persists edits + a tiny thumbnail, but NOT the decoded working scan.
So on relaunch every image is `developed: false` → the "Develop" badge nags and the
user must re-run the develop flow, paying the full RAW decode (~8s/RAF) again even
though the thumbnails already look inverted. **Persisting edits without persisting
the expensive decode defeats the purpose.** This is the preview-cache the original
spec wrongly deferred.

## Fix

Persist the decoded `Developed { working, thumb, base }` to a per-image **cache
sidecar file**, and reload it lazily on launch so images come back genuinely
developed: no badge, no re-decode, sliders live instantly.

**Why edits don't invalidate it:** develop-slider edits re-invert *from* `working`
(the linear pre-inversion scan). So the cache only needs (re)writing on develop /
re-develop — never on a slider change.

## Storage

- Location: `<app_data_dir>/cache/<id>.oecache`, one file per image id (UUID).
- Layout: `[has_ir: u8]` then a **zstd**-compressed payload of:
  - `base: [f32;3]`
  - `working: Image` — `width u32, height u32, has_ir u8, pixels (w*h*3 f32 LE), [ir w*h f32 if has_ir]`
  - `thumb: Image` — same encoding
  The leading uncompressed `has_ir` byte lets `load_catalog` read IR-capability with
  a 1-byte read, without decompressing.
- **Bound:** the cached `working` is capped to ≤4096 long edge (Performance cap) even
  in Quality mode, so cache files stay bounded (~tens of MB, not ~1GB for 102MP).
  Export still re-decodes full-res from the original file, so loupe-at-4096 is fine.

## Lazy reload (memory-safe)

- `load_catalog`: for each image, `developed = cache_file.exists()` (cheap stat),
  `has_ir = read_has_ir(cache_file)` when present. Pixels are NOT loaded here.
- `ensure_resident(session, id)`: if `developed` is absent in the Session but a cache
  file exists, read+decompress it into `Session.developed` (dropping the lock during
  file IO). Called at the top of `render_view`, `thumbnail`, `export_image`,
  `as_shot_wb`. First view of each image pays the ~150ms cache read; subsequent views
  are instant. RAM grows only with what you actually view (matches prior folder-scoped
  develop memory behaviour, but instant).

## Lifecycle

- `develop_image`: after building `Developed`, write the cache (working capped 4096).
- `delete_image`: remove the cache file.
- `set_quality` change / edits: cache stays valid (loupe uses ≤4096; export re-decodes).
- Re-develop overwrites the cache.

## Surface changes

**Backend:**
- New dep: `zstd = "0.13"`.
- New module `app/src-tauri/src/cache.rs`: `write(path, &Developed)`, `read(path) -> Developed`, `read_has_ir(path) -> bool`, with `Image` (de)serialization helpers. Tests round-trip an Image (with and without IR) and `read_has_ir`.
- `session.rs`: `Session` gains `cache_dir: Mutex<PathBuf>` + `cache_path(id) -> PathBuf`.
- `lib.rs` setup: set the Session cache_dir to `<app_data_dir>/cache` and `create_dir_all`.
- `commands.rs`: `develop_image` writes cache; `delete_image` removes it; `render_view`/`thumbnail`/`export_image`/`as_shot_wb` call `ensure_resident` first; `load_catalog` reports `developed`/`has_ir` from cache presence; `CatalogImage` gains `developed: bool` + `has_ir: bool`.

**Frontend:**
- `api.ts`: `CatalogImage` gains `developed: boolean` + `has_ir: boolean`.
- `catalog.ts` `applySnapshot`: use `ci.developed` / `ci.has_ir` instead of hardcoded `false`.

## Out of scope (follow-ups)
- Cache size cap / LRU eviction (cache grows unbounded for now; note in UI later).
- Re-caching at full res for Quality-mode 100% loupe.
- Cache invalidation if the source file changes on disk (currently trusts the cache).
