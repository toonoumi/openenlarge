# Unified Thumbnail-Regen Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four scattered thumbnail-regen paths with one view-independent worker driven by a single "needs rebake" flag, so Roll stops re-rendering on entry and apply-to-roll reliably refreshes every frame's strip thumbnail.

**Architecture:** Collapse "needs rebake" into the existing persisted `thumb_stale` flag (`thumb_version != ENGINE_VERSION`). A new module `thumbRegen.ts` owns a singleton bounded-concurrency worker; edits *mark* frames stale (in-memory + a best-effort DB invalidation for crash durability), and the worker *bakes* them in the background regardless of which tab is mounted. Views only display `img.thumbnail`.

**Tech Stack:** SvelteKit + TypeScript frontend, Vitest for unit tests; Rust (Tauri 2) backend with rusqlite catalog, `cargo test` for unit tests.

## Global Constraints

- Frontend test runner: `cd app && npm run test:unit` (Vitest). Typecheck: `cd app && npm run check` (svelte-check).
- Rust tests: `cd app/src-tauri && cargo test`.
- `thumb_stale` is the SINGLE source of truth for "this thumbnail needs rebaking" — for any reason (engine-version bump or look change). The worker clears it via `saveThumbnail` (which stamps the current `ENGINE_VERSION`).
- Do NOT introduce a second/parallel dirty mechanism. Reuse `thumb_stale`.
- Follow existing code style; match surrounding files (semicolons, import grouping).
- Work is committed directly on `main` (no feature branch).

---

### Task 1: Backend `invalidate_thumbnails` command

Stamps `thumb_version = 0` (below `ENGINE_VERSION`) for given ids so they load `thumb_stale = true` next session — making a look-change durable across a crash mid-regen. Mirrors `update_thumbnail` (which stamps the current version on success).

**Files:**
- Modify: `app/src-tauri/src/catalog.rs` (add method + test near `update_thumbnail` at line 134 and the existing stale test at line 646)
- Modify: `app/src-tauri/src/commands.rs` (add command near `save_thumbnail` at line 1568)
- Modify: `app/src-tauri/src/lib.rs:143` (register handler after `commands::save_thumbnail`)
- Modify: `app/src/lib/api.ts` (add binding near `saveThumbnail` at line 240)

**Interfaces:**
- Produces (Rust): `Catalog::invalidate_thumbnails(&self, ids: &[String]) -> rusqlite::Result<()>`
- Produces (command): `invalidate_thumbnails(ids: Vec<String>, catalog) -> Result<(), String>`
- Produces (TS): `api.invalidateThumbnails(ids: string[]): Promise<void>`

- [ ] **Step 1: Write the failing Rust test**

In `app/src-tauri/src/catalog.rs`, add after the `old_engine_version_thumbnail_loads_stale` test (ends ~line 663):

```rust
    #[test]
    fn invalidate_thumbnails_marks_stale() {
        let cat = Catalog::open_in_memory().unwrap();
        let id = cat.upsert_image("/x/a.dng", "a.dng", "{}", "thumb", 0).unwrap();
        // A render stamps the current engine version → not stale.
        cat.update_thumbnail(&id, "data:fresh").unwrap();
        assert!(!cat.load_images(&|_| true).unwrap()[0].thumb_stale);
        // Invalidation drops it below the current version → loads stale again.
        cat.invalidate_thumbnails(&[id.clone()]).unwrap();
        let imgs = cat.load_images(&|_| true).unwrap();
        assert!(
            imgs.iter().find(|i| i.id == id).unwrap().thumb_stale,
            "invalidated thumbnail must load stale"
        );
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app/src-tauri && cargo test invalidate_thumbnails_marks_stale`
Expected: FAIL — `no method named invalidate_thumbnails found`.

- [ ] **Step 3: Implement the catalog method**

In `app/src-tauri/src/catalog.rs`, add after `update_thumbnail` (after line 140):

```rust
    /// Invalidate the baked thumbnails for `ids` by stamping a version below the
    /// current engine version, so `load_images` reports them `thumb_stale` and the
    /// frontend regen worker rebakes them — even after a relaunch that interrupts an
    /// in-session regen. Mirror of `update_thumbnail` (which stamps the current version).
    pub fn invalidate_thumbnails(&self, ids: &[String]) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for id in ids {
            tx.execute("UPDATE images SET thumb_version = 0 WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app/src-tauri && cargo test invalidate_thumbnails_marks_stale`
Expected: PASS.

- [ ] **Step 5: Add the Tauri command**

In `app/src-tauri/src/commands.rs`, add after `save_thumbnail` (after line 1578):

```rust
/// Stamp the given images' thumbnails as stale (thumb_version below the engine
/// version) so the frontend regen worker rebakes them. Called when a look-change
/// (apply-to-roll, roll commit) touches frames the active view won't itself rebake.
#[tauri::command]
pub fn invalidate_thumbnails(
    ids: Vec<String>,
    catalog: State<crate::catalog::Catalog>,
) -> Result<(), String> {
    catalog.invalidate_thumbnails(&ids).map_err(|e| format!("{e}"))
}
```

- [ ] **Step 6: Register the handler**

In `app/src-tauri/src/lib.rs`, add after line 143 (`commands::save_thumbnail,`):

```rust
            commands::invalidate_thumbnails,
```

- [ ] **Step 7: Add the TS binding**

In `app/src/lib/api.ts`, add after `saveThumbnail` (after line 241):

```typescript
  /** Invalidate the persisted thumb_version for these frames so they load stale
   *  next session — makes an in-session look-change durable across a crash. */
  invalidateThumbnails: (ids: string[]) =>
    invoke<void>("invalidate_thumbnails", { ids }),
```

- [ ] **Step 8: Verify build + typecheck**

Run: `cd app/src-tauri && cargo test invalidate` then `cd app && npm run check`
Expected: tests PASS; svelte-check reports no new errors.

- [ ] **Step 9: Commit**

```bash
git add app/src-tauri/src/catalog.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/lib/api.ts
git commit -m "feat(catalog): invalidate_thumbnails command (stamp thumb_version stale)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `thumbRegen.ts` worker module

Extracts the regen worker out of `Grid.svelte` into a view-independent module. This is the heart of the change.

**Files:**
- Create: `app/src/lib/develop/thumbRegen.ts`
- Test: `app/src/lib/develop/thumbRegen.test.ts`

**Interfaces:**
- Consumes: `api.invalidateThumbnails` (Task 1); stores `images`, `editsById`, `cropById`, `dustById` from `../store`; `withEffectiveBase` from `./base`; `applyAsShotWb` from `./wb`; `imageDir` from `../library/folderScope`; `gridThumbView`, `GRID_STATIC_EDGE` from `../library/gridHiRes`; `api`, `defaultParams`, `ImageEntry` from `../api`.
- Produces:
  - `regenOne(img: ImageEntry): Promise<void>`
  - `markThumbsStale(ids: string[], opts?: { persist?: boolean }): void`
  - `pump(): void`
  - `startThumbRegen(): void`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/develop/thumbRegen.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("../api", () => ({
  api: {
    ensureDeveloped: vi.fn().mockResolvedValue(undefined),
    thumbnail: vi.fn().mockResolvedValue("data:new"),
    saveThumbnail: vi.fn().mockResolvedValue(undefined),
    invalidateThumbnails: vi.fn().mockResolvedValue(undefined),
    asShotWb: vi.fn().mockResolvedValue({}),
    perZoneWb: vi.fn().mockResolvedValue({ sh: 0, mid: 0, hi: 0 }),
  },
  defaultParams: () => ({}),
}));
vi.mock("./base", () => ({ withEffectiveBase: (p: any) => p }));
vi.mock("./wb", () => ({ applyAsShotWb: (p: any) => p }));
vi.mock("../library/folderScope", () => ({ imageDir: () => "/dir" }));
vi.mock("../library/gridHiRes", () => ({ gridThumbView: () => ({}), GRID_STATIC_EDGE: 320 }));

import { images, editsById, cropById, dustById } from "../store";
import { api } from "../api";
import { regenOne, pump, markThumbsStale } from "./thumbRegen";

const frame = (id: string, extra: Record<string, unknown> = {}) => ({
  id, path: `/p/${id}`, file_name: id, thumbnail: "old", metadata: {},
  offline: false, developed: true, has_ir: false, positive: false, thumb_stale: true, ...extra,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  images.set([]); editsById.set({}); cropById.set({}); dustById.set({});
  vi.clearAllMocks();
});

describe("regenOne", () => {
  it("rebakes, persists, and clears thumb_stale", async () => {
    images.set([frame("a") as any]);
    editsById.set({ a: { foo: 1 } as any });
    await regenOne(get(images)[0] as any);
    expect(api.thumbnail).toHaveBeenCalledWith("a", { foo: 1 }, {});
    expect(api.saveThumbnail).toHaveBeenCalledWith("a", "data:new");
    const img = get(images)[0];
    expect(img.thumbnail).toBe("data:new");
    expect(img.thumb_stale).toBe(false);
  });

  it("leaves thumb_stale set when the render fails", async () => {
    images.set([frame("a") as any]);
    editsById.set({ a: { foo: 1 } as any });
    (api.thumbnail as any).mockRejectedValueOnce(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await regenOne(get(images)[0] as any);
    expect(get(images)[0].thumb_stale).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips undeveloped frames", async () => {
    images.set([frame("a", { developed: false }) as any]);
    await regenOne(get(images)[0] as any);
    expect(api.thumbnail).not.toHaveBeenCalled();
  });
});

describe("markThumbsStale + pump", () => {
  it("marks frames stale, persists invalidation, and drains them", async () => {
    images.set([frame("a", { thumb_stale: false }) as any, frame("b", { thumb_stale: false }) as any]);
    editsById.set({ a: {} as any, b: {} as any });
    markThumbsStale(["a", "b"], { persist: true });
    expect(api.invalidateThumbnails).toHaveBeenCalledWith(["a", "b"]);
    await flush(); await flush();
    expect(api.thumbnail).toHaveBeenCalledTimes(2);
    expect(get(images).every((i) => i.thumb_stale === false)).toBe(true);
  });

  it("does not persist when opts.persist is false", () => {
    images.set([frame("a", { thumb_stale: false }) as any]);
    markThumbsStale(["a"]);
    expect(api.invalidateThumbnails).not.toHaveBeenCalled();
  });

  it("pump renders every developed+stale frame once", async () => {
    images.set([frame("a") as any, frame("b") as any, frame("c") as any]);
    editsById.set({ a: {} as any, b: {} as any, c: {} as any });
    pump();
    await flush(); await flush();
    expect(api.thumbnail).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm run test:unit -- thumbRegen`
Expected: FAIL — cannot resolve `./thumbRegen`.

- [ ] **Step 3: Create the module**

Create `app/src/lib/develop/thumbRegen.ts`:

```typescript
// View-independent thumbnail-regeneration worker. `thumb_stale` is the single
// "needs rebake" flag (engine-version bump OR look change); edits mark frames stale
// and this worker bakes them in the background, regardless of which tab is mounted.
// Replaces Grid.svelte's local regenStale/sweepStale and copySettings' regenAppliedThumbs.

import { get } from "svelte/store";
import { images, editsById, cropById, dustById } from "../store";
import { api, defaultParams, type ImageEntry } from "../api";
import { withEffectiveBase } from "./base";
import { applyAsShotWb } from "./wb";
import { imageDir } from "../library/folderScope";
import { gridThumbView, GRID_STATIC_EDGE } from "../library/gridHiRes";

const POOL = 3;
const inFlight = new Set<string>();
let pumping = false;

/** Rebake one developed frame's catalog thumbnail and clear its thumb_stale flag.
 *  Reuses saved edits if present, else the develop-time auto-WB seed (matching the
 *  look the frame opens with). saveThumbnail stamps the current engine version. */
export async function regenOne(img: ImageEntry): Promise<void> {
  if (!img.developed || inFlight.has(img.id)) return;
  inFlight.add(img.id);
  try {
    // Ensure the decoded working buffer is resident (rehydrates from the .oecache
    // sidecar if it was evicted). Cheap when already cached.
    await api.ensureDeveloped(img.id);
    const dir = imageDir(img);
    const saved = get(editsById)[img.id];
    let params;
    if (saved) {
      params = withEffectiveBase(saved, dir);
    } else {
      const seed = withEffectiveBase({ ...defaultParams(), positive: img.positive }, dir);
      const wb = await api.asShotWb(img.id, seed, null, { rot90: 0, flip_h: false, flip_v: false, angle: 0 });
      params = applyAsShotWb(seed, wb);
      try {
        const pz = await api.perZoneWb(img.id, params, null, { rot90: 0, flip_h: false, flip_v: false, angle: 0 });
        params = { ...params, pz_sh: pz.sh, pz_mid: pz.mid, pz_hi: pz.hi };
      } catch { /* keep identity pz on failure */ }
    }
    const view = gridThumbView(get(cropById)[img.id], get(dustById)[img.id], GRID_STATIC_EDGE);
    const url = await api.thumbnail(img.id, params, view);
    await api.saveThumbnail(img.id, url);
    images.update((list) =>
      list.map((i) => (i.id === img.id ? { ...i, thumbnail: url, thumb_stale: false } : i)));
  } catch (e) {
    // Leave thumb_stale set so the frame is retried on the next pump / next session.
    console.warn(`thumbRegen: regenOne failed for ${img.id}`, e);
  } finally {
    inFlight.delete(img.id);
  }
}

/** Drain every developed+stale frame with bounded concurrency. Singleton: a second
 *  call while running is a no-op; marks added mid-drain are picked up by the re-read. */
export function pump(): void {
  if (pumping) return;
  pumping = true;
  const worker = async () => {
    for (;;) {
      const next = get(images).find((i) => i.developed && i.thumb_stale && !inFlight.has(i.id));
      if (!next) return;
      await regenOne(next);
    }
  };
  void Promise.all(Array.from({ length: POOL }, worker)).finally(() => { pumping = false; });
}

/** Mark frames as needing a rebake (look change) and kick the worker. When persist,
 *  also invalidate the DB thumb_version so the mark survives a crash mid-regen. */
export function markThumbsStale(ids: string[], opts: { persist?: boolean } = {}): void {
  if (!ids.length) return;
  const set = new Set(ids);
  images.update((list) =>
    list.map((i) => (set.has(i.id) && i.developed ? { ...i, thumb_stale: true } : i)));
  if (opts.persist) api.invalidateThumbnails(ids).catch(() => { /* best-effort durability */ });
  pump();
}

let swept = false;
/** Once-per-session initial sweep, kicked after the catalog loads — rebakes every
 *  developed+stale thumbnail (e.g. after an ENGINE_VERSION bump). */
export function startThumbRegen(): void {
  if (swept) return;
  swept = true;
  pump();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npm run test:unit -- thumbRegen`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/thumbRegen.ts app/src/lib/develop/thumbRegen.test.ts
git commit -m "feat(develop): view-independent thumbnail-regen worker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire Library Grid + catalog load to the shared worker

Remove Grid's local worker and delegate to `thumbRegen`. Kick the initial sweep from catalog load (not Grid mount) so it runs even if the user opens straight into Develop/Roll.

**Files:**
- Modify: `app/src/lib/library/Grid.svelte` (imports at lines 4-8; delete `regenStale` lines 60-89 and `sweepStale` lines 91-115; update `ensureVisible` lines 119-126; remove line 128)
- Modify: `app/src/lib/catalog.ts` (import + call after `images.set` at line 65)

**Interfaces:**
- Consumes: `regenOne`, `startThumbRegen` from `../develop/thumbRegen` (Task 2).

- [ ] **Step 1: Update Grid imports**

In `app/src/lib/library/Grid.svelte`, the import block (lines 4-9) currently pulls `withEffectiveBase`, `applyAsShotWb`, `imageDir` for the local worker. After this task `regenStale`/`sweepStale` are gone, so those three imports (and `editsById`, `cropById`, `dustById`, `defaultParams`) may become unused. Replace the worker-specific imports with the shared functions and let svelte-check flag any now-unused import to remove.

Add this import after line 8 (`import { gridColumns, ... } from "./gridHiRes";` is line 9 — add after it):

```typescript
  import { regenOne, startThumbRegen } from "../develop/thumbRegen";
```

- [ ] **Step 2: Delete the local `regenStale` and `sweepStale`**

In `app/src/lib/library/Grid.svelte`, delete the entire `regenStale` function (lines 60-89) and the `sweptStale`/`sweepStale` block (lines 91-115). Keep `renderHiRes` and the hi-res state.

- [ ] **Step 3: Update `ensureVisible` to call the shared `regenOne`**

Replace the `ensureVisible` body (lines 119-126) so visible stale cells use the shared worker's `regenOne` (jumping the queue), keeping the hi-res boost local:

```typescript
  // For every visible developed cell: rebake a stale static thumbnail first (jumping
  // the shared worker's queue for on-screen frames), else (when zoomed) hi-res boost.
  function ensureVisible() {
    for (const id of visible) {
      const img = shown.find((i) => i.id === id);
      if (!img?.developed) continue;
      if (img.thumb_stale) { regenOne(img); continue; }
      if (boost && hiRes[id]?.key !== img.thumbnail) renderHiRes(img);
    }
  }
```

- [ ] **Step 4: Remove the Grid-mount sweep trigger**

In `app/src/lib/library/Grid.svelte`, delete line 128:

```typescript
  $: if ($images.length) sweepStale(); // once-per-session eager refresh after the catalog loads
```

Keep line 127 (`$: boost, shown, ensureVisible();`).

- [ ] **Step 5: Kick the sweep from catalog load**

In `app/src/lib/catalog.ts`, add to the existing import from `./develop/...` or a new import line near the top imports:

```typescript
import { startThumbRegen } from "./develop/thumbRegen";
```

Then immediately after `images.set(entries);` (line 65) add:

```typescript
  startThumbRegen(); // rebake any engine-version-stale thumbnails in the background
```

- [ ] **Step 6: Verify typecheck + full unit suite**

Run: `cd app && npm run check && npm run test:unit`
Expected: svelte-check reports no new errors (remove any import it flags as unused, e.g. `withEffectiveBase`, `applyAsShotWb`, `imageDir`, `defaultParams`, `editsById`, `cropById`, `dustById`, `ImageEntry` if no longer referenced in Grid); all unit tests PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/library/Grid.svelte app/src/lib/catalog.ts
git commit -m "refactor(library): delegate thumbnail regen to shared worker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire apply-to-roll / paste to mark-stale

Replace the fragile sequential `regenAppliedThumbs` with a single `markThumbsStale` call; the worker handles concurrency, persistence, and retries.

**Files:**
- Modify: `app/src/lib/develop/copySettings.ts` (imports line 7-22; `applySelectedTo` line 107; delete `regenAppliedThumbs` lines 110-127)
- Test: `app/src/lib/develop/copySettings.test.ts` (new)

**Interfaces:**
- Consumes: `markThumbsStale` from `./thumbRegen` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/develop/copySettings.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./thumbRegen", () => ({ markThumbsStale: vi.fn() }));
vi.mock("../toast", () => ({ showToast: vi.fn() }));
vi.mock("./historyStore", () => ({ commitActive: vi.fn() }));

import { activeId, editsById, cropById, images, invalidatePreview } from "../store";
import { markThumbsStale } from "./thumbRegen";
import { applySelectedTo } from "./copySettings";
import { PASTE_DEFAULT_GROUPS } from "./copySettings";

beforeEach(() => {
  editsById.set({ a: {} as any, b: {} as any, c: {} as any });
  cropById.set({});
  images.set([
    { id: "a", developed: true } as any,
    { id: "b", developed: true } as any,
    { id: "c", developed: true } as any,
  ]);
  activeId.set("a");
  vi.clearAllMocks();
});

describe("applySelectedTo", () => {
  it("marks the non-active applied frames stale (persisted)", async () => {
    const src = { params: { exposure: 1 } as any, crop: null, tempOffset: 0 };
    await applySelectedTo(["a", "b", "c"], src, { ...PASTE_DEFAULT_GROUPS });
    // Active frame "a" rebakes via Develop.refreshThumb, so it is excluded.
    expect(markThumbsStale).toHaveBeenCalledWith(["b", "c"], { persist: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npm run test:unit -- copySettings`
Expected: FAIL — `markThumbsStale` not called (still calling `regenAppliedThumbs`).

- [ ] **Step 3: Swap the regen call**

In `app/src/lib/develop/copySettings.ts`, add to the imports (after line 14, the `draftThumbView` import — it becomes unused; see Step 5):

```typescript
import { markThumbsStale } from "./thumbRegen";
```

Replace the tail of `applySelectedTo` (lines 103-107, the comment block + `void regenAppliedThumbs(ids, active);`) with:

```typescript
  // Mark the applied background frames stale; the shared worker rebakes them (bounded
  // concurrency, persisted, retried). The active frame rebakes via Develop.refreshThumb.
  const others = ids.filter((id) => id !== active);
  if (others.length) markThumbsStale(others, { persist: true });
```

- [ ] **Step 4: Delete `regenAppliedThumbs`**

In `app/src/lib/develop/copySettings.ts`, delete the entire `regenAppliedThumbs` function (lines 110-127).

- [ ] **Step 5: Remove now-unused imports**

`regenAppliedThumbs` was the only user of `withEffectiveBase`, `imageDir`, `draftThumbView`, and `images`/`defaultParams` (verify with svelte-check). Remove from the import block (lines 7-22) whatever `npm run check` flags as unused.

- [ ] **Step 6: Run the test + typecheck**

Run: `cd app && npm run test:unit -- copySettings && npm run check`
Expected: test PASS; no new svelte-check errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/develop/copySettings.ts app/src/lib/develop/copySettings.test.ts
git commit -m "fix(develop): apply-to-roll marks frames stale for the regen worker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Gate Roll preview on entry + mark on commit

Stop the full preview re-render on Roll entry; persist already-rendered previews on commit and mark any un-previewed committed frame stale for the worker.

**Files:**
- Modify: `app/src/lib/tabs/Roll.svelte` (`schedulePersist` lines 233-272; the reactive line 277)

**Interfaces:**
- Consumes: `markThumbsStale` from `../develop/thumbRegen` (Task 2); `rollDraftTouched` already imported in Roll.

- [ ] **Step 1: Add the import**

In `app/src/lib/tabs/Roll.svelte`, add to the script imports (alongside the other `../develop/...` or `../roll/...` imports near the top):

```typescript
  import { markThumbsStale } from "../develop/thumbRegen";
```

- [ ] **Step 2: Gate the preview batch on entry**

In `app/src/lib/tabs/Roll.svelte`, find `schedulePreview` (the `debounce` at line 220). Add a touched-guard as the first line of its callback so opening the Roll tab (untouched) renders nothing — cells fall back to `previewMap[id] ?? img.thumbnail`, and the worker handles any genuinely stale frame:

```typescript
  const schedulePreview = debounce((draft: typeof $rollDraft) => {
    if (!get(rollDraftTouched)) return; // entry/re-entry: show cached thumbnails, don't re-render
    if (previewRunning) {
      // Queue the latest draft; an in-flight batch will pick it up on completion.
      previewPending = draft;
      return;
    }
    runPreviewBatch(draft);
  }, 120);
```

- [ ] **Step 3: Mark un-previewed committed frames stale**

In `app/src/lib/tabs/Roll.svelte`, replace the persist-thumbnail loop at the end of `schedulePersist` (lines 263-271) with one that keeps the `previewMap` fast-path and falls back to the worker for any committed frame without a rendered preview:

```typescript
    // Persist thumbnail for each frame — reuse previewMap renders (no re-render); for
    // any frame without a preview yet, mark it stale so the shared worker rebakes it.
    const snap = previewMap;
    const missing: string[] = [];
    for (const id of ids) {
      const url = snap[id];
      if (url) {
        images.update((xs) => xs.map((i) => i.id === id ? { ...i, thumbnail: url } : i));
        api.saveThumbnail(id, url);
      } else {
        missing.push(id);
      }
    }
    if (missing.length) markThumbsStale(missing, { persist: true });
```

- [ ] **Step 4: Verify typecheck + full unit suite**

Run: `cd app && npm run check && npm run test:unit`
Expected: no new svelte-check errors; all unit tests PASS (the existing `roll/*.test.ts` suites still green).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tabs/Roll.svelte
git commit -m "fix(roll): no thumbnail re-render on entry; worker backfills on commit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification + GUI smoke

**Files:** none (verification only).

- [ ] **Step 1: Run all backend + frontend tests**

Run: `cd app/src-tauri && cargo test` then `cd app && npm run test:unit && npm run check`
Expected: all PASS, no new typecheck errors.

- [ ] **Step 2: GUI smoke (manual — this repo ships behind GUI smoke tests)**

Run the app (`cd app && npm run tauri dev`) and confirm:
1. Open a developed roll, switch to the **Roll** tab without touching any slider → **no thumbnail flicker / no re-render** (watch that thumbnails don't visibly re-bake).
2. In single-frame **Develop**, Copy → **apply to whole roll** → every bottom filmstrip thumbnail updates to the new look within a couple of seconds **without** clicking each frame.
3. Move a **Roll** slider → contact-sheet previews update live; on release the look persists; leave and re-enter Roll → no re-render, thumbnails already correct.
4. Library grid still rebakes engine-stale thumbnails on launch.

- [ ] **Step 3: Final commit (if any smoke fixups were needed)**

```bash
git add -A && git commit -m "test: verify thumbnail-regen worker end to end

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Single `thumb_stale` flag + view-independent worker → Task 2. ✓
- `thumbRegen.ts` (regenOne / markThumbsStale / pump / startThumbRegen) → Task 2. ✓
- Backend `invalidate_thumbnails` + sentinel < ENGINE_VERSION + api binding → Task 1. ✓
- apply-to-roll uses markThumbsStale, deletes regenAppliedThumbs → Task 4. ✓
- Roll slider commit marks stale; previewMap fast-path kept → Task 5 Step 3. ✓
- Roll entry gated on rollDraftTouched → Task 5 Step 2. ✓
- Library Grid delegates; sweep kicked from catalog load → Task 3. ✓
- Single-frame edit (refreshThumb) unchanged → no task needed (explicitly left alone). ✓
- Error handling logs instead of silent catch → Task 2 regenOne. ✓
- Tests: thumbRegen unit, catalog Rust, copySettings, roll suite regression → Tasks 1,2,4,5. ✓
- Out of scope (no spinner, no import/develop path change, auto-WB reused) → respected. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `markThumbsStale(ids, { persist })`, `regenOne(img)`, `pump()`, `startThumbRegen()` used identically across Tasks 2-5. `invalidate_thumbnails`/`invalidateThumbnails` consistent across Rust/command/TS in Task 1. ✓
