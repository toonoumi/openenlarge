# Roll-Base Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-image film-base sampling with one robust per-roll base (confidence-filtered per-channel median across the roll), applied to every frame's inversion + WB seed, with a view-scoped manual recalibrate and a self-healing migration for existing rolls.

**Architecture:** A new pure-aggregation backend command `roll_base(ids)` medians the already-stored per-frame `dev.base` over confident frames. `developAll` becomes two-phase (develop+sample all → set folder base → seed all), reusing the existing `withEffectiveBase` precedence so the seed path needs no new wiring. A frontend `roll/rollBase.ts` owns the migration (keyed on absent `folder_base:{dir}`) and the shared frame-reseed helper. Roll-view recalibrate sets the roll base from the reference-frame rebate picker.

**Tech Stack:** Rust (Tauri commands, `film-core`), TypeScript/Svelte frontend, Svelte stores.

**Spec:** `docs/superpowers/specs/2026-06-21-roll-base-anchor-design.md`

## Global Constraints

- Work happens on `main`. The user commits to `main` in parallel — stage ONLY the exact paths each step lists; NEVER `git add -A` / `git commit -am`. Do not stage `docs/superpowers/specs/2026-06-20-ml-wb-spike-plan.md`, `test_flt`, or `scripts/__pycache__/` (the user's untracked files).
- Commit trailer required on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- CPU/GPU parity is mandatory. This feature changes only WHICH base value is fed to the engines; the base is a uniform supplied identically to CPU (`invert_image`) and GPU (`resolve_to_uniforms`). No shader change.
- Filmic tone path stays dormant and byte-identical — do not touch it.
- The "frozen after develop" invariant holds: thumbnails change only via the deliberate one-time migration here or an explicit user edit.
- **Protected frames** (never re-seeded by a roll-base change): any frame whose `editsById[id]` has `base_override != null` OR `wb_manual === true`.
- Roll base aggregation uses the **per-channel median** of frames clearing `film_core::calibrate::REBATE_CONFIDENCE`. Returns nothing (→ per-image auto fallback) if zero frames are confident.
- Any new UI string goes through `i18n-strings.csv` + `scripts/gen-i18n.py` — NEVER hand-edit `app/src/lib/i18n/dict.ts`.
- The roll-base precedence is already modeled by `withEffectiveBase`: per-image `base_override` → folder base → backend per-image auto. Do not add a parallel mechanism.

---

### Task 1: Backend `roll_base` command + median aggregation

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add `aggregate_roll_base`, `RollBase`, `roll_base`; near `auto_base_info` at `commands.rs:2551`)
- Modify: `app/src-tauri/src/lib.rs:110-143` (register the command in `generate_handler!`)
- Test: inline `#[cfg(test)]` tests in `app/src-tauri/src/commands.rs` (the file already has a `mod tests` with base/confidence tests around `commands.rs:2820-2870`)

**Interfaces:**
- Consumes: `film_core::calibrate::REBATE_CONFIDENCE: f32`; `session.images` map of `id → Image { developed: Option<Developed { base: [f32;3], base_confidence: f32, .. } > }` (`session.rs:230`); `ensure_resident(&session, id) -> Result<(), String>`.
- Produces: pure fn `aggregate_roll_base(samples: &[([f32;3], f32)]) -> Option<[f32;3]>`; command `roll_base(ids: Vec<String>, session) -> Result<Option<RollBase>, String>` where `struct RollBase { base: [f32;3], frames_used: u32 }`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `app/src-tauri/src/commands.rs`:

```rust
#[test]
fn aggregate_roll_base_per_channel_median_of_confident() {
    let hi = film_core::calibrate::REBATE_CONFIDENCE + 0.1;
    let samples = [
        ([0.40, 0.22, 0.13], hi),
        ([0.44, 0.24, 0.15], hi),
        ([0.42, 0.23, 0.14], hi),
    ];
    let out = aggregate_roll_base(&samples).expect("confident frames present");
    assert!((out[0] - 0.42).abs() < 1e-6, "r median: {}", out[0]);
    assert!((out[1] - 0.23).abs() < 1e-6, "g median: {}", out[1]);
    assert!((out[2] - 0.14).abs() < 1e-6, "b median: {}", out[2]);
}

#[test]
fn aggregate_roll_base_drops_sub_threshold_frames() {
    let hi = film_core::calibrate::REBATE_CONFIDENCE + 0.1;
    let lo = film_core::calibrate::REBATE_CONFIDENCE - 0.1;
    let samples = [
        ([0.40, 0.22, 0.13], hi),
        ([0.99, 0.10, 0.95], lo), // blue/pink outlier, low confidence → dropped
        ([0.42, 0.23, 0.14], hi),
    ];
    let out = aggregate_roll_base(&samples).expect("two confident frames");
    // Median of the two confident frames only; the low-confidence outlier never counts.
    assert!((out[0] - 0.41).abs() < 1e-6, "r: {}", out[0]);
    assert!((out[2] - 0.135).abs() < 1e-6, "b: {}", out[2]);
}

#[test]
fn aggregate_roll_base_outlier_does_not_move_median() {
    let hi = film_core::calibrate::REBATE_CONFIDENCE + 0.1;
    // One confident-but-pink frame among good ones; median rejects it.
    let samples = [
        ([0.40, 0.22, 0.13], hi),
        ([0.41, 0.23, 0.14], hi),
        ([0.42, 0.24, 0.15], hi),
        ([0.90, 0.10, 0.80], hi), // pink outlier
        ([0.43, 0.25, 0.16], hi),
    ];
    let out = aggregate_roll_base(&samples).expect("confident frames");
    assert!((out[0] - 0.42).abs() < 1e-6, "r median unmoved: {}", out[0]);
    assert!(out[2] < 0.2, "b median not pulled high by outlier: {}", out[2]);
}

#[test]
fn aggregate_roll_base_even_count_averages_middle_two() {
    let hi = film_core::calibrate::REBATE_CONFIDENCE + 0.1;
    let samples = [([0.40, 0.20, 0.10], hi), ([0.44, 0.24, 0.14], hi)];
    let out = aggregate_roll_base(&samples).expect("two frames");
    assert!((out[0] - 0.42).abs() < 1e-6, "r: {}", out[0]);
}

#[test]
fn aggregate_roll_base_none_when_no_confident_frames() {
    let lo = film_core::calibrate::REBATE_CONFIDENCE - 0.1;
    let samples = [([0.40, 0.22, 0.13], lo), ([0.42, 0.23, 0.14], lo)];
    assert!(aggregate_roll_base(&samples).is_none());
}

#[test]
fn aggregate_roll_base_single_confident_frame() {
    let hi = film_core::calibrate::REBATE_CONFIDENCE + 0.1;
    let samples = [([0.40, 0.22, 0.13], hi)];
    let out = aggregate_roll_base(&samples).expect("one frame");
    assert_eq!(out, [0.40, 0.22, 0.13]);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app/src-tauri && cargo test aggregate_roll_base 2>&1 | tail -20`
Expected: FAIL — `cannot find function aggregate_roll_base in this scope`.

- [ ] **Step 3: Implement `aggregate_roll_base` + `RollBase` + `roll_base`**

Add near `auto_base_info` (after the `AutoBaseInfo` block, around `commands.rs:2558`):

```rust
/// Aggregate a roll's per-frame auto bases into one robust roll base: the
/// per-channel median of the frames whose rebate detector cleared
/// `REBATE_CONFIDENCE`. Returns `None` if no frame is confident (rebate-less roll
/// → caller falls back to per-image auto base). Per-channel (not vector) median is
/// deliberate: it rejects a single pink/blue outlier channel independently.
pub(crate) fn aggregate_roll_base(samples: &[([f32; 3], f32)]) -> Option<[f32; 3]> {
    use film_core::calibrate::REBATE_CONFIDENCE;
    let confident: Vec<[f32; 3]> = samples
        .iter()
        .filter(|(_, c)| *c >= REBATE_CONFIDENCE)
        .map(|(b, _)| *b)
        .collect();
    if confident.is_empty() {
        return None;
    }
    let mut out = [0.0f32; 3];
    for (ch, slot) in out.iter_mut().enumerate() {
        let mut col: Vec<f32> = confident.iter().map(|b| b[ch]).collect();
        col.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = col.len();
        *slot = if n % 2 == 1 {
            col[n / 2]
        } else {
            (col[n / 2 - 1] + col[n / 2]) / 2.0
        };
    }
    Some(out)
}

/// The aggregated roll base + how many confident frames fed it. `None` from
/// `roll_base` (serialized as JSON `null`) means no confident rebate in the roll.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RollBase {
    pub base: [f32; 3],
    pub frames_used: u32,
}

/// Compute one robust base for a whole roll by aggregating the already-stored
/// per-frame `dev.base`/`dev.base_confidence` (no re-decode/re-sample). Frames that
/// can't be made resident are skipped. Returns `null` when no frame is confident.
#[tauri::command]
pub fn roll_base(ids: Vec<String>, session: State<Session>) -> Result<Option<RollBase>, String> {
    let mut samples: Vec<([f32; 3], f32)> = Vec::with_capacity(ids.len());
    for id in &ids {
        if ensure_resident(&session, id).is_err() {
            continue;
        }
        let images = session.images.lock().unwrap();
        if let Some(dev) = images.get(id).and_then(|img| img.developed.as_ref()) {
            samples.push((dev.base, dev.base_confidence));
        }
    }
    let frames_used = samples
        .iter()
        .filter(|(_, c)| *c >= film_core::calibrate::REBATE_CONFIDENCE)
        .count() as u32;
    Ok(aggregate_roll_base(&samples).map(|base| RollBase { base, frames_used }))
}
```

Register the command — add `commands::roll_base,` to the `generate_handler!` list in `app/src-tauri/src/lib.rs`, immediately after the `commands::auto_base_info,` line (currently `lib.rs:143`):

```rust
            commands::auto_base_info,
            commands::roll_base,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app/src-tauri && cargo test aggregate_roll_base 2>&1 | tail -20`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Confirm the crate still builds (command wiring is valid)**

Run: `cd app/src-tauri && cargo build 2>&1 | tail -5`
Expected: builds (warnings OK). If a stale incremental link error appears (`_anon.*.llvm.*` undefined), `rm -rf target/debug/incremental` and rebuild.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(base): roll_base command — confidence-filtered per-channel median across a roll

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Frontend `rollBase` binding + extract `seedFrame` + two-phase `developAll`

**Files:**
- Modify: `app/src/lib/api.ts:331` (add `rollBase` binding after `autoBaseInfo`)
- Modify: `app/src/lib/workflow.ts:148-240` (extract `seedFrame`; split `developAll` into two phases; set the roll base between them)
- Test: `app/src/lib/workflow.rollbase.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `roll_base(ids) -> { base, frames_used } | null`; existing `withEffectiveBase(params, dir)` (`develop/base.ts`), `setFolderBase(dir, base)` (`develop/base.ts`), `imageDir(img)` (`library/folderScope`), `gridThumbView`, `GRID_STATIC_EDGE` (`library/gridHiRes`), `api.asShotWb`, `api.autoBrightness`, `api.thumbnail`, `api.saveThumbnail`.
- Produces: `async function seedFrame(id: string, img: ImageEntry, solveExposure: boolean): Promise<void>` (exported, reused by Task 3 & 4).

- [ ] **Step 1: Add the `rollBase` API binding**

In `app/src/lib/api.ts`, immediately after the `autoBaseInfo` binding (`api.ts:331`):

```ts
  autoBaseInfo: (id: string) =>
    invoke<{ base: [number, number, number]; confidence: number }>("auto_base_info", { id }),

  rollBase: (ids: string[]) =>
    invoke<{ base: [number, number, number]; frames_used: number } | null>("roll_base", { ids }),
```

- [ ] **Step 2: Write the failing test for two-phase ordering**

Create `app/src/lib/workflow.rollbase.test.ts`. This test asserts the ORDER guarantee: `roll_base` + `setFolderBase` happen before any `asShotWb` seed call, so WB seeds against the roll base.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Order log shared by the api mock.
const calls: string[] = [];

vi.mock("./api", () => ({
  defaultParams: () => ({ mode: "d", stock: "none", base_override: null, d_max_override: null, exposure: 0, temp: 5500, tint: 0, positive: false, wb_mode: "gain", wb_manual: false }),
  api: {
    developImage: vi.fn(async (id: string) => { calls.push(`develop:${id}`); return { id, path: `/roll/${id}.dng`, file_name: `${id}.dng`, thumbnail: "", developed: true, positive: false }; }),
    rollBase: vi.fn(async (ids: string[]) => { calls.push(`rollBase:${ids.length}`); return { base: [0.42, 0.23, 0.14], frames_used: ids.length }; }),
    asShotWb: vi.fn(async () => { calls.push("asShotWb"); return { temp: 5800, tint: 5 }; }),
    autoBrightness: vi.fn(async () => { calls.push("autoBrightness"); return { exposure: -0.9 }; }),
    thumbnail: vi.fn(async () => "data:image/jpeg;base64,x"),
    saveThumbnail: vi.fn(async () => {}),
  },
}));

// setFolderBase records ordering; folderBaseByPath stays empty so seeds read it live.
const setFolderBaseSpy = vi.fn(() => calls.push("setFolderBase"));
vi.mock("./develop/base", () => ({
  withEffectiveBase: (p: unknown, _dir: string) => p,
  setFolderBase: (...a: unknown[]) => setFolderBaseSpy(...a),
}));
vi.mock("./library/folderScope", () => ({ imageDir: () => "/roll" }));
vi.mock("./library/gridHiRes", () => ({ gridThumbView: () => ({}), GRID_STATIC_EDGE: 320 }));
vi.mock("./analytics", () => ({ track: () => {} }), { virtual: true });

import { get } from "svelte/store";
import { images, folderImages, editsById, module, selectedFolder } from "./store";
import { developAll } from "./workflow";

describe("developAll two-phase roll base", () => {
  beforeEach(() => {
    calls.length = 0;
    setFolderBaseSpy.mockClear();
    editsById.set({});
    selectedFolder.set("/roll");
    images.set([
      { id: "a", path: "/roll/a.dng", file_name: "a.dng", thumbnail: "", developed: false, positive: false } as never,
      { id: "b", path: "/roll/b.dng", file_name: "b.dng", thumbnail: "", developed: false, positive: false } as never,
    ]);
  });

  it("sets the roll base before any WB seed runs", async () => {
    await developAll("develop");
    const firstSeed = calls.indexOf("asShotWb");
    const setBase = calls.indexOf("setFolderBase");
    expect(setBase).toBeGreaterThanOrEqual(0);
    expect(firstSeed).toBeGreaterThan(setBase); // WB seeded AFTER the roll base is set
    // Both frames developed before the roll base was computed.
    expect(calls.indexOf("rollBase:2")).toBeGreaterThan(calls.indexOf("develop:b"));
  });
});
```

(If `get`/`module`/`folderImages` imports are unused in the final test, drop them to keep the file lint-clean — the assertions above are the contract.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd app && npx vitest run src/lib/workflow.rollbase.test.ts 2>&1 | tail -25`
Expected: FAIL — current `developAll` interleaves develop+seed per frame (an `asShotWb` fires before any `setFolderBase`), and `rollBase`/`setFolderBase` aren't called at all.

- [ ] **Step 4: Extract `seedFrame` and rewrite `developAll` as two phases**

In `app/src/lib/workflow.ts`, add the import for `setFolderBase` (extend the existing `./develop/base` import) and `api`'s `rollBase` is already on `api`. Add the shared helper above `developAll`:

```ts
/** Seed one developed frame's look against its EFFECTIVE base (per-image override →
 * roll/folder base → backend auto): auto-WB, optional auto-exposure, then re-WB at the
 * final exposure (WB is exposure-dependent — see the 2026-06-21 freeze fix), and bake the
 * catalog thumbnail. `solveExposure=false` keeps the frame's existing exposure (used by the
 * migration / roll recalibrate, where only the base changed). Writes editsById + saves the
 * thumbnail. Overwrites temp/tint, so callers must skip protected frames themselves. */
export async function seedFrame(id: string, img: ImageEntry, solveExposure: boolean): Promise<void> {
  const dir = imageDir(img);
  const prior = get(editsById)[id];
  const seed: InvertParams = prior ? { ...prior } : { ...defaultParams(), positive: img.positive };
  try {
    const wb = await api.asShotWb(id, withEffectiveBase(seed, dir));
    seed.temp = wb.temp; seed.tint = wb.tint; seed.wb_manual = false;
  } catch { return; /* not resident — per-image seed retries on activation */ }
  if (solveExposure) {
    try {
      const { exposure } = await api.autoBrightness(id, withEffectiveBase(seed, dir));
      seed.exposure = exposure;
    } catch { /* not resident */ }
    try {
      const wb2 = await api.asShotWb(id, withEffectiveBase(seed, dir));
      seed.temp = wb2.temp; seed.tint = wb2.tint;
    } catch { /* not resident */ }
  }
  editsById.update((m) => ({ ...m, [id]: seed }));
  try {
    const params = withEffectiveBase(get(editsById)[id] ?? seed, dir);
    const view = gridThumbView(get(cropById)[id], get(dustById)[id], GRID_STATIC_EDGE);
    const url = await api.thumbnail(id, params, view);
    await api.saveThumbnail(id, url);
    images.update((list) => list.map((i) => (i.id === id ? { ...i, thumbnail: url, thumb_stale: false } : i)));
  } catch { /* not resident — re-bakes on first view */ }
}
```

Then replace the body of `developAll` (`workflow.ts:148-240`) so the per-frame loop no longer seeds; instead develop all, set the roll base, then seed all:

```ts
export async function developAll(target: "develop" | "roll" = "develop"): Promise<void> {
  const ids = undevelopedIds(get(folderImages));
  if (ids.length === 0) { module.set(target); return; }
  developProgress.set({ active: true, done: 0, total: ids.length });
  await nextPaint();
  const failures: string[] = [];
  const nameOf = (id: string) => get(images).find((i) => i.id === id)?.file_name ?? id;

  // Phase 1: develop every frame (decode + sample its base). No seeding yet — the
  // roll base needs every frame's sample first.
  const developed: ImageEntry[] = [];
  for (const id of ids) {
    let ok = false;
    try {
      const updated = await api.developImage(id);
      images.update((list) => list.map((i) => (i.id === id ? updated : i)));
      if (updated.developed) { developed.push(updated); ok = true; }
      else { failures.push(`${nameOf(id)}: develop returned but not marked developed`); console.error("develop returned developed=false", id, nameOf(id)); }
    } catch (e) {
      failures.push(`${nameOf(id)}: ${e}`); console.error("develop failed", id, nameOf(id), e);
    }
    undevelopableIds.update((s) => {
      const has = s.has(id);
      if (ok && has) { const n = new Set(s); n.delete(id); return n; }
      if (!ok && !has) { const n = new Set(s); n.add(id); return n; }
      return s;
    });
    developProgress.update((p) => ({ ...p, done: p.done + 1 }));
  }

  // Phase 1.5: compute + set the roll base BEFORE any WB seed, so WB seeds against it.
  // `withEffectiveBase` (used inside seedFrame) then prefers this folder base automatically.
  if (developed.length > 0) {
    const dir = imageDir(developed[0]);
    try {
      const rb = await api.rollBase(developed.map((i) => i.id));
      if (rb) setFolderBase(dir, rb.base);
    } catch (e) { console.error("rollBase failed", dir, e); }
  }

  // Phase 2: seed each freshly-developed frame against the roll base (only if it has no
  // stored edits yet — re-develop / manual overrides are untouched).
  for (const updated of developed) {
    if (!get(editsById)[updated.id]) await seedFrame(updated.id, updated, true);
  }

  if (failures.length > 0) {
    showToast(translate("toast.developFailed", { count: failures.length, detail: failures[0] }), 8000);
  }
  if (!get(activeId)) {
    const first = get(folderImages)[0];
    if (first) activeId.set(first.id);
  }
  track("images_developed", { count: ids.length });
  module.set(target);
  // (Keep the existing overlay-fadeout tail that followed line 240 — leave it intact.)
}
```

Ensure `InvertParams` and `ImageEntry` are imported from `./api` at the top of `workflow.ts` (add to the existing `./api` import if not already present), and that `setFolderBase` is added to the `./develop/base` import.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd app && npx vitest run src/lib/workflow.rollbase.test.ts 2>&1 | tail -25`
Expected: PASS — roll base is set before the first `asShotWb`, and both develops precede `rollBase`.

- [ ] **Step 6: Type-check**

Run: `cd app && npm run check 2>&1 | grep -E "workflow|ERROR" | head`
Expected: no new errors referencing `workflow.ts` (the two pre-existing `invert.test.ts` errors about `ResolvedInversion` are unrelated and may remain).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/workflow.ts app/src/lib/workflow.rollbase.test.ts
git commit -m "feat(base): two-phase developAll seeds the whole roll against one roll base

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Self-healing migration for existing rolls

**Files:**
- Create: `app/src/lib/roll/rollBase.ts`
- Modify: the app bootstrap that starts `previewPrefetch` (find it: `grep -rn "previewPrefetch\|initPreviewPrefetch\|prefetch" app/src/lib app/src/routes app/src/App.svelte`), to also call the migration initializer
- Test: `app/src/lib/roll/rollBase.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `seedFrame(id, img, solveExposure)`; `api.rollBase`; `folderBaseByPath` store + `setFolderBase` (`develop/base.ts`); `editsById`, `images`, `selectedFolder`, `folderImages`, `developProgress` stores (`store.ts`); `imageDir` (`library/folderScope`).
- Produces: `ensureRollBase(dir: string, imgs: ImageEntry[]): Promise<void>`; `reseedRollProtectedFree(imgs: ImageEntry[]): Promise<void>`; `initRollBaseMigration(): void`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/roll/rollBase.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const seedFrameSpy = vi.fn(async () => {});
vi.mock("../workflow", () => ({ seedFrame: (...a: unknown[]) => seedFrameSpy(...a) }));

const setFolderBaseSpy = vi.fn();
vi.mock("../develop/base", async () => {
  const { writable } = await import("svelte/store");
  return { setFolderBase: (...a: unknown[]) => setFolderBaseSpy(...a) };
});
vi.mock("../library/folderScope", () => ({ imageDir: () => "/roll" }));
vi.mock("../api", () => ({ api: { rollBase: vi.fn(async () => ({ base: [0.42, 0.23, 0.14], frames_used: 3 })) } }));

import { get } from "svelte/store";
import { folderBaseByPath, editsById } from "../store";
import { api } from "../api";
import { ensureRollBase } from "./rollBase";

const dev = (id: string) => ({ id, path: `/roll/${id}.dng`, file_name: `${id}.dng`, thumbnail: "", developed: true, positive: false } as never);

describe("ensureRollBase migration", () => {
  beforeEach(() => {
    seedFrameSpy.mockClear(); setFolderBaseSpy.mockClear();
    (api.rollBase as ReturnType<typeof vi.fn>).mockClear();
    folderBaseByPath.set({});
    editsById.set({});
  });

  it("computes + sets the roll base and reseeds protected-free frames", async () => {
    editsById.set({
      b: { base_override: [0.5, 0.3, 0.2] } as never,       // protected (override)
      c: { wb_manual: true } as never,                       // protected (manual WB)
    });
    await ensureRollBase("/roll", [dev("a"), dev("b"), dev("c")]);
    expect(setFolderBaseSpy).toHaveBeenCalledWith("/roll", [0.42, 0.23, 0.14]);
    expect(seedFrameSpy).toHaveBeenCalledTimes(1);           // only "a" reseeded
    expect(seedFrameSpy.mock.calls[0][0]).toBe("a");
    expect(seedFrameSpy.mock.calls[0][2]).toBe(false);       // WB-only, keep exposure
  });

  it("skips entirely when a folder base already exists", async () => {
    folderBaseByPath.set({ "/roll": [0.4, 0.2, 0.1] });
    await ensureRollBase("/roll", [dev("a")]);
    expect(api.rollBase).not.toHaveBeenCalled();
    expect(setFolderBaseSpy).not.toHaveBeenCalled();
    expect(seedFrameSpy).not.toHaveBeenCalled();
  });

  it("does nothing on a rebate-less roll (rollBase returns null)", async () => {
    (api.rollBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await ensureRollBase("/roll", [dev("a")]);
    expect(setFolderBaseSpy).not.toHaveBeenCalled();
    expect(seedFrameSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/lib/roll/rollBase.test.ts 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './rollBase'`.

- [ ] **Step 3: Implement `roll/rollBase.ts`**

```ts
import { get, derived } from "svelte/store";
import type { ImageEntry } from "../api";
import { api } from "../api";
import { folderBaseByPath, setFolderBase } from "../develop/base";
import { editsById, images, selectedFolder, folderImages, developProgress } from "../store";
import { imageDir } from "../library/folderScope";
import { seedFrame } from "../workflow";

// NOTE: `folderBaseByPath` lives in store.ts and `setFolderBase` in develop/base.ts;
// import each from its home module.

/** A frame is protected from a roll-base reseed if the user set its base explicitly
 * (base_override) or picked its WB by hand (wb_manual). */
function isProtected(id: string): boolean {
  const e = get(editsById)[id];
  return !!e && (e.base_override != null || e.wb_manual === true);
}

/** Reseed every protected-free developed frame against the current effective base,
 * WB-only (keep each frame's existing exposure — only the base changed). */
export async function reseedRollProtectedFree(imgs: ImageEntry[]): Promise<void> {
  for (const img of imgs) {
    if (!img.developed || isProtected(img.id)) continue;
    await seedFrame(img.id, img, false);
  }
}

/** One-time migration for an existing roll: if the folder has no stored base yet,
 * compute the roll base, set it, and reseed protected-free frames. A folder that
 * already has a base (auto or manual) is left untouched, so this never recomputes. */
export async function ensureRollBase(dir: string, imgs: ImageEntry[]): Promise<void> {
  if (get(folderBaseByPath)[dir]) return;
  const developed = imgs.filter((i) => i.developed);
  if (developed.length === 0) return;
  let rb: { base: [number, number, number]; frames_used: number } | null = null;
  try { rb = await api.rollBase(developed.map((i) => i.id)); } catch { return; }
  if (!rb) return; // rebate-less roll → keep per-image auto fallback
  setFolderBase(dir, rb.base);
  await reseedRollProtectedFree(developed);
}

/** Wire the migration to fire once per folder on entry (mirrors previewPrefetch's
 * module-level subscription). Guards: skip while a develop pass is active (developAll
 * owns the base then), skip folders already based, and run once per dir. */
export function initRollBaseMigration(): void {
  let lastDir: string | null = null;
  derived([selectedFolder, folderImages], (v) => v).subscribe(([dir, imgs]) => {
    if (!dir || dir === lastDir) return;
    if (get(developProgress).active) return;            // developAll is handling it
    if (get(folderBaseByPath)[dir]) { lastDir = dir; return; }
    const list = imgs as ImageEntry[];
    if (!list.some((i) => i.developed)) return;          // wait until something is developed
    lastDir = dir;
    void ensureRollBase(dir, list);
  });
}
```

If `folderBaseByPath` is exported from `store.ts` (it is — `store.ts:72`) and `setFolderBase` from `develop/base.ts`, the two imports above resolve. Adjust the import lines so each symbol comes from its real module (the inline NOTE comment can be deleted once verified).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/lib/roll/rollBase.test.ts 2>&1 | tail -20`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Wire `initRollBaseMigration` into bootstrap**

Find where `previewPrefetch` is initialized (`grep -rn "previewPrefetch" app/src`). In that same bootstrap site (e.g. the top-level `App.svelte` `onMount`, or wherever the prefetch subscription starts), import and call `initRollBaseMigration()` once. Example if it's in `App.svelte`:

```ts
  import { initRollBaseMigration } from "$lib/roll/rollBase";
  onMount(() => { initRollBaseMigration(); /* ...existing init... */ });
```

If `previewPrefetch` self-starts at module import (no explicit init), instead add `import "$lib/roll/rollBase";` and convert the subscription to run at module load (call `initRollBaseMigration()` at the bottom of `rollBase.ts`). Pick whichever matches the existing prefetch pattern so there is exactly ONE subscription started once.

- [ ] **Step 6: Type-check**

Run: `cd app && npm run check 2>&1 | grep -E "rollBase|ERROR" | head`
Expected: no new errors referencing `roll/rollBase.ts`.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/roll/rollBase.ts app/src/lib/roll/rollBase.test.ts
# plus the one bootstrap file you edited in Step 5:
git add <bootstrap-file>
git commit -m "feat(base): self-healing roll-base migration for existing rolls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Roll-view manual recalibrate (whole-roll scope)

**Files:**
- Modify: `app/src/lib/tabs/Roll.svelte` (arm the reference-frame rebate picker; on pick → set roll base + reseed). **The user keeps live WIP here — integrate, do not overwrite; touch only the recalibrate wiring.**
- Modify: `app/src/lib/roll/RollAdjust.svelte` (add the "Recalibrate roll base" control). **Also user-WIP — same caution.**
- Modify: `i18n-strings.csv` (add the button label) + run `scripts/gen-i18n.py`
- Test: covered by the GUI smoke step (the pick→apply path is wiring over already-tested units: `sampleBaseAt`, `setFolderBase`, `reseedRollProtectedFree`)

**Interfaces:**
- Consumes: `api.sampleBaseAt(refId, rect) -> [number,number,number]` (`api.ts:327`); `setFolderBase(dir, base)` (`develop/base.ts`); `reseedRollProtectedFree(imgs)` (Task 3); Roll's existing `refId`/reference viewport + its rect-picker arming pattern (the same one `analyzeWhitePoint(refId, rect)` already uses in `Roll.svelte:454`).
- Produces: no new exported symbols (UI wiring only).

- [ ] **Step 1: Add the i18n string**

Append a row to `i18n-strings.csv` for the control label. Use the existing column format of that CSV (inspect the header first). Key: `roll.recalibrateBase`; English: `Recalibrate roll base`; Chinese: `重新校准胶卷片基`.

Run: `python scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` regenerates with the new key (do NOT hand-edit dict.ts).

- [ ] **Step 2: Add the recalibrate control in `RollAdjust.svelte`**

In the Film Base area of the roll adjust panel, add a button bound to the existing roll reference state. Mirror how the per-image swatch arms `baseSampling` in `Basic.svelte:80`, but route it to a roll-scoped flag/event the Roll viewport listens to. Minimal shape:

```svelte
<button class="recal" on:click={() => dispatch("recalibrateRollBase")}>{$t('roll.recalibrateBase')}</button>
```

(Use the panel's existing `createEventDispatcher` if present, or the existing store the panel uses to talk to `Roll.svelte` — match the file's current pattern rather than introducing a new channel.)

- [ ] **Step 3: Arm the reference-frame rebate picker + apply to roll in `Roll.svelte`**

Handle the `recalibrateRollBase` event: arm the reference viewport's rect picker (the same overlay used by the white-point/`analyzeWhitePoint` tool on `refId`). On a committed pick rect, set the roll base and reseed:

```ts
import { setFolderBase } from "$lib/develop/base";
import { reseedRollProtectedFree } from "$lib/roll/rollBase";
import { selectedFolder, folderImages } from "$lib/store";

async function onRollBasePick(rect: [number, number, number, number]) {
  const id = refId; if (!id) return;
  const dir = get(selectedFolder); if (!dir) return;
  const base = await api.sampleBaseAt(id, rect);
  setFolderBase(dir, base);
  await reseedRollProtectedFree(get(folderImages));
}
```

Wire `onRollBasePick` to the reference picker's commit callback (reuse the existing rect-pick plumbing that `analyzeWhitePoint` already uses on `refId` at `Roll.svelte:454`; the difference is only `sampleBaseAt` + `setFolderBase` + reseed instead of `analyzeWhitePoint`). Disarm the picker after a pick.

- [ ] **Step 4: Type-check + build**

Run: `cd app && npm run check 2>&1 | grep -E "Roll.svelte|RollAdjust|ERROR" | head`
Expected: no new errors in the two Roll files.

- [ ] **Step 5: GUI smoke (manual — the wiring's only end-to-end gate)**

Run `npm run tauri dev`. Verify:
1. Import a roll containing a known pink frame → after develop, no frame is pink (auto roll base).
2. Open an already-developed roll (no folder base) → it migrates once on entry; thumbnails settle; re-entering doesn't recompute.
3. In **Roll**, use "Recalibrate roll base", pick a clean rebate on the reference frame → the whole roll re-balances; frames with a manual base/WB are unchanged.
4. In **Frame**, the existing per-image Film Base pick still affects only that image.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/tabs/Roll.svelte app/src/lib/roll/RollAdjust.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(base): Roll-view recalibrate sets the whole-roll base

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Roll base = confidence-filtered per-channel median → Task 1. ✅
- Pure aggregation, no re-decode (reads stored `dev.base`) → Task 1 `roll_base`. ✅
- Two-phase `developAll`, roll base before WB seed, reuse `withEffectiveBase` → Task 2. ✅
- Per-image override wins → preserved (Phase 2 only seeds frames with no stored edits; migration/reseed skip protected). ✅
- Manual recalibrate scope follows view (Roll = whole roll; Frame = unchanged per-image) → Task 4 (Roll) + Frame path untouched. ✅
- Self-healing migration keyed on absent `folder_base` → Task 3. ✅
- Protected frames (base_override OR wb_manual) → `isProtected` in Task 3, honored in Tasks 3 & 4. ✅
- Rebate-less roll → `roll_base` returns `None`/`null`, callers no-op → Tasks 1, 2, 3. ✅
- Parity (base is a uniform, no shader) → no engine/shader task needed. ✅
- Testing: Rust median tests (Task 1), two-phase ordering (Task 2), migration (Task 3), GUI smoke (Task 4). ✅

**Type consistency:** `roll_base` returns `Option<RollBase { base:[f32;3], frames_used:u32 }>` (Rust) ↔ `{ base:[number,number,number], frames_used:number } | null` (TS). `seedFrame(id, img, solveExposure)` signature identical across Tasks 2/3. `setFolderBase(dir, base)` and `folderBaseByPath` used from their existing homes (`develop/base.ts`, `store.ts`). `isProtected` semantics (base_override OR wb_manual) match the Global Constraints definition.

**Known follow-ups (out of scope, noted for the final review):**
- Adding frames to an already-based roll does not recompute the base by design (manual Roll recalibrate refreshes it).
- Mixed-stock folder gets a compromise base by design (folder = roll).
