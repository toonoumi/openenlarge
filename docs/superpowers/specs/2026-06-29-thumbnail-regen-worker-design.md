# Unified thumbnail-regeneration worker

**Date:** 2026-06-29
**Status:** Approved (design)

## Problem

Thumbnail regeneration is triggered *by the view* instead of *by what changed*, producing two opposite failures:

1. **Roll over-renders on entry.** `Roll.svelte:277` runs `schedulePreview($rollDraft)` reactively on every entry. Unlike `schedulePersist` (gated on `rollDraftTouched`), the preview batch is ungated, so opening the Roll tab re-renders every frame's existing look into `previewMap` even though `img.thumbnail` already shows exactly that. Pure waste.

2. **apply-to-roll strip doesn't visibly update.** `applySelectedTo` → `regenAppliedThumbs` (`copySettings.ts:107,113`) is meant to rebake every applied frame's strip thumbnail, but it is a sequential `for…await` loop (concurrency 1), each non-resident frame triggers a heavy `ensure_resident` (disk read + 4 analysis passes), and any error is swallowed by an empty `catch {}` (`copySettings.ts:125`). On a full roll this is slow and silently lossy, so the strip appears to "only refresh when I select a frame" (selecting → `Develop.refreshThumb` rebakes the active one instantly).

Root cause: regeneration is scattered across four imperative paths (`Develop.refreshThumb`, Roll preview batch, `regenAppliedThumbs`, `Grid.sweepStale`) with inconsistent triggers.

## Existing infrastructure to build on

`Grid.svelte:60–128` already has the right shape: `regenStale(img)` (ensureDeveloped → params from saved edits or auto-WB seed → `api.thumbnail` → `saveThumbnail` → store update clearing `thumb_stale`) and a bounded-concurrency `sweepStale` worker, keyed on the persisted `thumb_stale` flag (`thumb_version != ENGINE_VERSION`, set in `catalog.rs:193`). It is only mounted in the Library view.

## Design

### Core idea
Collapse "this thumbnail needs rebaking" into the **single existing `thumb_stale` flag**, and drive **one view-independent worker** off it. `thumb_stale` stops meaning only "rendered by an older engine version" and starts meaning "needs rebake for *any* reason" — engine bump **or** look change. Edits *mark*; the worker *bakes*. No view bakes on entry or on selection.

### Components

1. **`app/src/lib/develop/thumbRegen.ts` (new module).** Extracts the worker out of `Grid.svelte` so it runs regardless of which tab is mounted.
   - `regenOne(img: ImageEntry): Promise<void>` — the generalized `regenStale`, moved verbatim (ensureDeveloped → saved-edits-or-auto-WB-seed params → `api.thumbnail` → `saveThumbnail` → `images.update` clearing `thumb_stale`). In-flight dedup via a module-level `Set`.
   - `markThumbsStale(ids: string[], opts?: { persist?: boolean }): void` — flips `thumb_stale = true` on those `images` store entries; if `persist`, fires the backend invalidation (best-effort); then kicks the pump.
   - `pump(): void` — singleton bounded-concurrency drain (POOL = 3) over `images.filter(i => i.developed && i.thumb_stale && !inFlight.has(i.id))`. Re-reads the latest store each step (an observer or `regenOne` may have already cleared a frame). Idempotent: a second call while running is a no-op; new marks arriving mid-drain are picked up by the loop's re-read.
   - `startThumbRegen(): void` — the once-per-session initial sweep; called after the catalog loads.

2. **Backend `invalidate_thumbnails(ids: Vec<String>)` command** (`commands.rs` + `catalog.rs`). Sets `thumb_version` to a sentinel `< ENGINE_VERSION` (e.g. `0`) for each id — the mirror of `update_thumbnail` (which stamps the current version on success). This makes a content-change survive a mid-regen crash: on next launch the frame loads `thumb_stale = true` and the worker finishes the job. Exposed in `api.ts` as `invalidateThumbnails(ids)`.

### Wiring — triggers become *marks*

- **apply-to-roll / paste** (`copySettings.ts`): replace the `regenAppliedThumbs` loop with `markThumbsStale(nonActiveIds, { persist: true })`. The active frame is excluded (it rebakes via `Develop.refreshThumb`). Delete `regenAppliedThumbs`. → fixes issue #2.
- **Roll slider commit** (`Roll.svelte` `schedulePersist`): keep the existing `previewMap` fast-path — for each id with a rendered preview in the snapshot, persist it (`images.update` + `api.saveThumbnail`, which stamps current version) as today. For any committed id *without* a preview entry, call `markThumbsStale([id], { persist: true })` so the worker backfills it. (No double-render of already-previewed frames.)
- **Roll entry** (`Roll.svelte:277`): gate `schedulePreview` with the same `if (!get(rollDraftTouched)) return;` guard `schedulePersist` uses. On entry, cells render `previewMap[id] ?? img.thumbnail`; `img.thumbnail` is kept fresh by the worker, and any genuinely stale frame is rebaked by the worker — not by a full preview batch. → fixes issue #1.
- **Library** (`Grid.svelte`): import `regenOne` / `startThumbRegen` from the new module; remove the local `regenStale` / `sweepStale` definitions. `ensureVisible` calls `regenOne(img)` directly for *visible* stale cells so on-screen frames jump the queue (in-flight guard prevents duplicate work with the pump). The hi-res zoom-boost logic stays local to Grid.
- **Catalog load** (`catalog.ts` `loadCatalog`, or wherever `images.set(...)` lands the snapshot): call `startThumbRegen()` after the store is populated, replacing Grid's `$: if ($images.length) sweepStale()` mount trigger.
- **Single-frame edit** (`Develop.svelte` `refreshThumb`): unchanged. The active frame stays on its 400 ms debounced bake; `saveThumbnail` stamps the current engine version, clearing `thumb_stale`.

## Data flow

```
edit (apply-to-roll / roll commit / engine bump on load)
  → markThumbsStale(ids)            [in-memory thumb_stale=true (+ persist sentinel)]
  → pump()                          [singleton, POOL=3]
      → regenOne(img) per frame     [ensureDeveloped → thumbnail → saveThumbnail]
          → images.update: thumb_stale=false, thumbnail=fresh
          → DB thumb_version = ENGINE_VERSION (via saveThumbnail)
views (Library grid / Develop strip / Roll sheet) render img.thumbnail reactively
```

## Error handling
- `regenOne` keeps a `try/catch` but **logs** failures (`console.warn`) instead of silently swallowing, and leaves `thumb_stale = true` so the frame is retried on the next pump / next session. (Replaces the silent `catch {}` in `regenAppliedThumbs`.)
- Backend `invalidate_thumbnails` is best-effort from the frontend's perspective; a failure only means the content-change isn't crash-durable, not that the in-session rebake is skipped.

## Testing
- **`thumbRegen` unit tests** (Vitest, mocking `api`): `markThumbsStale` sets the flag + kicks pump; `pump` respects POOL concurrency; in-flight dedup prevents double renders; a `regenOne` failure leaves `thumb_stale` set; pump drains marks added mid-run.
- **`catalog.rs` Rust test**: `invalidate_thumbnails` sets `thumb_version` below `ENGINE_VERSION` so `load_images` reports `thumb_stale = true`; a subsequent `update_thumbnail` clears it. (Mirror of the existing `old_engine_version_thumbnail_loads_stale` test.)
- **Regression**: Roll entry untouched issues **zero** `api.thumbnail` calls (assert on the mocked api); apply-to-roll marks all non-active ids stale.

## Out of scope (YAGNI)
- No per-frame "regenerating…" spinner in the strip/sheet.
- No change to the import or develop thumbnail paths.
- No change to the auto-WB seed logic — reused as-is from `regenStale`.
