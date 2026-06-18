# Develop Roll Contact-Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the new **Develop** section — a roll-level contact-sheet view of the current folder that live-previews a non-destructive *roll draft* across all frames, bulk-writes the look/geometry/base/white-point into every frame (with an overwrite-confirm), and exports the sheet to a single image.

**Architecture:** A new `module === "roll"` route renders `Roll.svelte`. A standalone `rollDraft` store (params + crop) is edited by side panels and previewed live across a contact-sheet grid via debounced `api.thumbnail` batch renders. Reference-based ops (crop / film base / white-point pick) happen in a full-screen frame overlay. "Apply to roll" actions call pure functions in `roll/apply.ts` that bulk-write into `editsById` / `cropById` (which auto-persist), gated by an overwrite-confirm when frames already carry non-default edits.

**Tech Stack:** Svelte 5, TypeScript, Vitest (pure-logic tests only — this repo has no component tests), Tauri 2 backend (reused as-is, no Rust changes).

## Global Constraints

- **i18n:** All user-facing strings come from `$t('key')`. Never edit `app/src/lib/i18n/dict.ts` by hand. Add rows to `/i18n-strings.csv` (columns `key,en,zh,file,note`) and regenerate with `python3 scripts/gen-i18n.py` from repo root. (See memory: i18n generated from CSV.)
- **Work on `main`:** Commit directly on `main`; no feature branch. (See memory.)
- **No Rust changes:** Reuse existing Tauri commands only (`render_view`, `thumbnail`, `analyze_white_point`, `sample_base_at`, `as_shot_wb`, `gray_point_wb`, `auto_base_info`). Do not add or modify `src-tauri`.
- **Persistence is automatic:** Writing to `editsById` / `cropById` triggers debounced write-through (`catalog.ts` `wireRecord`). Bulk-write must replace the per-id entry with a **new object reference** for each changed id, or the save is skipped.
- **Internal module names:** `"library"` = Library, `"develop"` = the per-image **Tune** editor (unchanged), **`"roll"`** = the new Develop contact-sheet section (this plan). The UI label "Develop" maps to `module === "roll"`.
- **Test command:** `npm --prefix app run test:unit` runs Vitest. Type-check with `npm --prefix app run check`.
- **Excluded from Develop:** AI Enhance, Eraser, Auto-Dust, and the Color Mixer point-color eyedropper. These stay in Tune only.

---

## Milestone 1 — Routing + contact-sheet shell

Deliverable: clicking the Develop tab opens a contact sheet of the current folder's developed frames; tapping a frame opens a full-screen preview overlay; everything else (Library/Tune/Export) is unchanged.

### Task 1: Add the `"roll"` module value + persistence

**Files:**
- Modify: `app/src/lib/store.ts:12`
- Modify: `app/src/lib/catalog.ts:87`

**Interfaces:**
- Produces: `module: Writable<"library" | "roll" | "develop">`

- [ ] **Step 1: Widen the `module` store type**

In `app/src/lib/store.ts`, line 12, change:

```ts
export const module = writable<"library" | "develop">("library");
```

to:

```ts
export const module = writable<"library" | "roll" | "develop">("library");
```

- [ ] **Step 2: Accept `"roll"` when hydrating persisted module**

In `app/src/lib/catalog.ts`, line 87, change:

```ts
  if (st.module === "library" || st.module === "develop") moduleStore.set(st.module);
```

to:

```ts
  if (st.module === "library" || st.module === "roll" || st.module === "develop") moduleStore.set(st.module);
```

- [ ] **Step 3: Type-check**

Run: `npm --prefix app run check`
Expected: no new errors (existing `module.set("develop")` / `"library"` calls still valid).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/catalog.ts
git commit -m "feat(develop): add roll module value + persistence"
```

### Task 2: Roll-draft store

**Files:**
- Create: `app/src/lib/roll/draft.ts`
- Test: `app/src/lib/roll/draft.test.ts`

**Interfaces:**
- Consumes: `defaultParams` (api.ts), `CropRect` (crop/types.ts)
- Produces:
  - `interface RollDraft { params: InvertParams; crop: CropRect | null }`
  - `rollDraft: Writable<RollDraft>`
  - `rollReferenceId: Writable<string | null>` — id of the frame open in the full-screen overlay (null = sheet view)
  - `resetRollDraft(): void` — set draft back to `{ params: defaultParams(), crop: null }`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/roll/draft.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { rollDraft, rollReferenceId, resetRollDraft } from "./draft";
import { defaultParams } from "../api";

describe("rollDraft", () => {
  beforeEach(() => resetRollDraft());

  it("seeds from default params with no crop", () => {
    expect(get(rollDraft)).toEqual({ params: defaultParams(), crop: null });
  });

  it("resetRollDraft clears edits back to defaults", () => {
    rollDraft.update((d) => ({ ...d, params: { ...d.params, exposure: 2 } }));
    expect(get(rollDraft).params.exposure).toBe(2);
    resetRollDraft();
    expect(get(rollDraft).params.exposure).toBe(0);
    expect(get(rollDraft).crop).toBeNull();
  });

  it("rollReferenceId defaults to null", () => {
    expect(get(rollReferenceId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app run test:unit -- roll/draft`
Expected: FAIL — cannot find module `./draft`.

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/roll/draft.ts
import { writable, type Writable } from "svelte/store";
import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";

/** The roll-wide draft: one set of params (tone/color/wb + base_override +
 * d_max_override) plus a crop geometry, previewed live across the contact sheet
 * and bulk-written into every frame on "Apply to roll". Non-destructive until applied. */
export interface RollDraft {
  params: InvertParams;
  crop: CropRect | null;
}

export const rollDraft: Writable<RollDraft> = writable({ params: defaultParams(), crop: null });

/** Id of the frame open in the full-screen overlay (reference frame / preview).
 * null = the contact-sheet grid is showing. */
export const rollReferenceId: Writable<string | null> = writable<string | null>(null);

/** Reset the draft to a fresh default look (called on entering Develop). */
export function resetRollDraft(): void {
  rollDraft.set({ params: defaultParams(), crop: null });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app run test:unit -- roll/draft`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/roll/draft.ts app/src/lib/roll/draft.test.ts
git commit -m "feat(develop): roll draft store"
```

### Task 3: Contact-sheet shell component + routing

**Files:**
- Create: `app/src/lib/tabs/Roll.svelte`
- Modify: `app/src/routes/+page.svelte:13-14` (import), `:126-130` (Develop button), `:139-143` (page render)
- Modify: `/i18n-strings.csv` (add Develop-section strings)

**Interfaces:**
- Consumes: `developedFolderImages` (export/eligible.ts), `rollReferenceId` + `resetRollDraft` (roll/draft.ts), `setActive` (store.ts)
- Produces: `Roll.svelte` rendered when `module === "roll"`.

- [ ] **Step 1: Add i18n rows**

Add these rows to `/i18n-strings.csv` (after the `app.tab.export` row is fine):

```
roll.empty,"No developed frames in this folder yet.","此文件夹中还没有已显影的胶片。","src/lib/tabs/Roll.svelte","hint"
roll.applyLook,"Apply look to roll","应用色调到整卷","src/lib/tabs/Roll.svelte","button"
roll.close,"Close","关闭","src/lib/roll/FramePreview.svelte","button"
```

- [ ] **Step 2: Regenerate the dict**

Run: `python3 scripts/gen-i18n.py` (from repo root)
Expected: `wrote app/src/lib/i18n/dict.ts with N keys` (N increased by 3). Verify `grep -n "roll.applyLook" app/src/lib/i18n/dict.ts` shows the en + zh entries.

- [ ] **Step 3: Create the shell component**

```svelte
<!-- app/src/lib/tabs/Roll.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "$lib/i18n";
  import { developedFolderImages } from "$lib/export/eligible";
  import { setActive } from "$lib/store";
  import { rollReferenceId, resetRollDraft } from "$lib/roll/draft";

  // Fresh roll draft each time the section opens (seed from defaults per spec).
  onMount(() => { resetRollDraft(); });

  function openFrame(id: string) {
    setActive(id);
    rollReferenceId.set(id);
  }
</script>

<div class="roll">
  <div class="sheet">
    {#if $developedFolderImages.length === 0}
      <div class="empty">{$t('roll.empty')}</div>
    {:else}
      <div class="grid">
        {#each $developedFolderImages as img (img.id)}
          <button class="cell" data-id={img.id} on:click={() => openFrame(img.id)}>
            <div class="ratio"><img src={img.thumbnail} alt={img.file_name} draggable="false" /></div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if $rollReferenceId}
  <!-- FramePreview added in Task 9; placeholder keeps the shell compilable. -->
{/if}

<style>
  .roll { height: 100%; min-height: 0; display: flex; }
  .sheet { flex: 1; overflow-y: auto; padding: 8px; }
  .grid { display: grid; gap: 12px; align-content: start;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .cell { display: block; padding: 0; border: 1px solid var(--glass-brd); border-radius: 11px;
    overflow: hidden; background: #0d0d10; cursor: pointer; transition: box-shadow 0.12s; }
  .cell:hover { box-shadow: 0 12px 26px rgba(0,0,0,0.5); }
  .ratio { position: relative; width: 100%; height: 0; padding-bottom: 75%; }
  .ratio img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
  .empty { color: var(--text-faint); padding: 16px; }
</style>
```

- [ ] **Step 4: Wire routing in `+page.svelte`**

In `app/src/routes/+page.svelte`, after the `Develop` import (line 14), add:

```ts
  import Roll from "$lib/tabs/Roll.svelte";
```

Change the Develop tab button (currently `<button>{$t('app.tab.develop')}</button>` at line 127) to:

```svelte
      <button class:active={$module === "roll"} disabled={!$hasImages} on:click={() => module.set("roll")}>{$t('app.tab.develop')}</button>
```

Change the page render block (lines 139-143) from:

```svelte
    {#key $module}
      <div class="page" in:fly={{ y: 10, duration: 220, easing: cubicOut }}>
        {#if $module === "library"}<Library />{:else}<Develop />{/if}
      </div>
    {/key}
```

to:

```svelte
    {#key $module}
      <div class="page" in:fly={{ y: 10, duration: 220, easing: cubicOut }}>
        {#if $module === "library"}<Library />{:else if $module === "roll"}<Roll />{:else}<Develop />{/if}
      </div>
    {/key}
```

- [ ] **Step 5: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: `npm --prefix app run tauri dev`, import a folder, Develop a few frames in Tune so they're `developed`, click the **Develop** tab. Expected: contact-sheet grid of the developed frames; clicking a frame sets it active (no overlay yet — FramePreview lands in Task 9). Library/Tune/Export unaffected.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/tabs/Roll.svelte app/src/routes/+page.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): contact-sheet shell + routing"
```

---

## Milestone 2 — Roll draft editing + live preview + apply look

Deliverable: side panels edit the roll draft; the contact sheet previews the draft live across all frames; "Apply look to roll" bulk-writes tone/color into every frame with an overwrite-confirm.

### Task 4: Pure apply/conflict logic (`roll/apply.ts`)

**Files:**
- Create: `app/src/lib/roll/apply.ts`
- Test: `app/src/lib/roll/apply.test.ts`

**Interfaces:**
- Consumes: `InvertParams`, `defaultParams` (api.ts); `CropRect` (crop/types.ts)
- Produces (all pure — take maps + ids, return NEW maps; never mutate input):
  - `toneColorOf(p: InvertParams): Partial<InvertParams>` — the tone/color subset (excludes `mode`, `stock`, `base_override`, `d_max_override`, `hdr`, `positive`)
  - `hasToneColorEdits(p: InvertParams): boolean` — true if the tone/color subset differs from defaults
  - `framesWithToneColor(edits: Record<string, InvertParams>, ids: string[]): string[]`
  - `applyToneColorToAll(edits, ids, src: InvertParams): Record<string, InvertParams>`
  - `framesWithCrop(crops: Record<string, CropRect | null>, ids: string[]): string[]`
  - `applyCropToAll(crops, ids, crop: CropRect | null): Record<string, CropRect | null>`
  - `framesWithBase(edits, ids): string[]` — entries whose `base_override !== null`
  - `applyBaseToAll(edits, ids, base: [number, number, number] | null): Record<string, InvertParams>`
  - `framesWithWhitePoint(edits, ids): string[]` — entries whose `d_max_override !== null`
  - `applyWhitePointToAll(edits, ids, dmax: number | null): Record<string, InvertParams>`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/roll/apply.test.ts
import { describe, it, expect } from "vitest";
import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";
import {
  toneColorOf, hasToneColorEdits, framesWithToneColor, applyToneColorToAll,
  framesWithCrop, applyCropToAll,
  framesWithBase, applyBaseToAll,
  framesWithWhitePoint, applyWhitePointToAll,
} from "./apply";

const crop: CropRect = {
  rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, aspect: "custom",
  orientation: "landscape", rot90: 0, flipH: false, flipV: false, angle: 0,
};

describe("tone/color", () => {
  it("toneColorOf excludes film/calibration fields", () => {
    const p = { ...defaultParams(), exposure: 1, base_override: [1, 1, 1] as [number, number, number], d_max_override: 2 };
    const tc = toneColorOf(p);
    expect(tc.exposure).toBe(1);
    expect("base_override" in tc).toBe(false);
    expect("d_max_override" in tc).toBe(false);
    expect("stock" in tc).toBe(false);
  });

  it("hasToneColorEdits is false for defaults, true after a tone edit", () => {
    expect(hasToneColorEdits(defaultParams())).toBe(false);
    expect(hasToneColorEdits({ ...defaultParams(), contrast: 10 })).toBe(true);
  });

  it("hasToneColorEdits ignores base/dmax-only differences", () => {
    expect(hasToneColorEdits({ ...defaultParams(), d_max_override: 3, base_override: [0.5, 0.5, 0.5] })).toBe(false);
  });

  it("framesWithToneColor lists only ids with non-default tone/color", () => {
    const edits: Record<string, InvertParams> = {
      a: defaultParams(),
      b: { ...defaultParams(), saturation: 20 },
    };
    expect(framesWithToneColor(edits, ["a", "b", "c"])).toEqual(["b"]);
  });

  it("applyToneColorToAll writes src tone/color but preserves each frame's base/dmax", () => {
    const edits: Record<string, InvertParams> = {
      a: { ...defaultParams(), base_override: [0.2, 0.2, 0.2], d_max_override: 1.5 },
    };
    const src = { ...defaultParams(), contrast: 30 };
    const next = applyToneColorToAll(edits, ["a", "b"], src);
    expect(next.a.contrast).toBe(30);
    expect(next.a.base_override).toEqual([0.2, 0.2, 0.2]); // preserved
    expect(next.a.d_max_override).toBe(1.5);               // preserved
    expect(next.b.contrast).toBe(30);                      // created from defaults
    expect(next.b.base_override).toBeNull();
    expect(next).not.toBe(edits);     // new map
    expect(next.a).not.toBe(edits.a); // new entry ref (persistence needs this)
  });
});

describe("crop", () => {
  it("framesWithCrop lists ids with a non-null crop", () => {
    const crops: Record<string, CropRect | null> = { a: null, b: crop };
    expect(framesWithCrop(crops, ["a", "b", "c"])).toEqual(["b"]);
  });

  it("applyCropToAll writes a cloned crop to every id", () => {
    const next = applyCropToAll({}, ["a", "b"], crop);
    expect(next.a).toEqual(crop);
    expect(next.a).not.toBe(crop);          // cloned
    expect(next.a!.rect).not.toBe(crop.rect); // deep clone
  });

  it("applyCropToAll with null clears crops", () => {
    const next = applyCropToAll({ a: crop }, ["a"], null);
    expect(next.a).toBeNull();
  });
});

describe("base", () => {
  it("framesWithBase lists ids whose base_override is set", () => {
    const edits: Record<string, InvertParams> = {
      a: defaultParams(),
      b: { ...defaultParams(), base_override: [0.3, 0.3, 0.3] },
    };
    expect(framesWithBase(edits, ["a", "b"])).toEqual(["b"]);
  });

  it("applyBaseToAll sets base_override on every id, leaving tone untouched", () => {
    const edits: Record<string, InvertParams> = { a: { ...defaultParams(), contrast: 5 } };
    const next = applyBaseToAll(edits, ["a", "b"], [0.4, 0.4, 0.4]);
    expect(next.a.base_override).toEqual([0.4, 0.4, 0.4]);
    expect(next.a.contrast).toBe(5);
    expect(next.b.base_override).toEqual([0.4, 0.4, 0.4]);
  });
});

describe("white point", () => {
  it("framesWithWhitePoint lists ids whose d_max_override is set", () => {
    const edits: Record<string, InvertParams> = {
      a: defaultParams(),
      b: { ...defaultParams(), d_max_override: 2.1 },
    };
    expect(framesWithWhitePoint(edits, ["a", "b"])).toEqual(["b"]);
  });

  it("applyWhitePointToAll sets d_max_override on every id", () => {
    const next = applyWhitePointToAll({ a: defaultParams() }, ["a", "b"], 1.9);
    expect(next.a.d_max_override).toBe(1.9);
    expect(next.b.d_max_override).toBe(1.9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app run test:unit -- roll/apply`
Expected: FAIL — cannot find module `./apply`.

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/roll/apply.ts
import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Per-image film/calibration fields that are NOT part of the shared "look". */
const EXCLUDE = new Set<keyof InvertParams>([
  "mode", "stock", "base_override", "d_max_override", "hdr", "positive",
]);

/** The tone/color subset of a params object (everything except EXCLUDE). */
export function toneColorOf(p: InvertParams): Partial<InvertParams> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(p) as (keyof InvertParams)[]) {
    if (!EXCLUDE.has(k)) out[k] = p[k];
  }
  return out as Partial<InvertParams>;
}

/** True when the tone/color subset differs from a fresh default. */
export function hasToneColorEdits(p: InvertParams): boolean {
  return JSON.stringify(toneColorOf(p)) !== JSON.stringify(toneColorOf(defaultParams()));
}

const entry = (edits: Record<string, InvertParams>, id: string): InvertParams =>
  edits[id] ?? defaultParams();

export function framesWithToneColor(edits: Record<string, InvertParams>, ids: string[]): string[] {
  return ids.filter((id) => edits[id] && hasToneColorEdits(edits[id]));
}

export function applyToneColorToAll(
  edits: Record<string, InvertParams>, ids: string[], src: InvertParams,
): Record<string, InvertParams> {
  const next = { ...edits };
  const tc = clone(toneColorOf(src));
  for (const id of ids) next[id] = { ...entry(edits, id), ...clone(tc) };
  return next;
}

export function framesWithCrop(crops: Record<string, CropRect | null>, ids: string[]): string[] {
  return ids.filter((id) => crops[id] != null);
}

export function applyCropToAll(
  crops: Record<string, CropRect | null>, ids: string[], crop: CropRect | null,
): Record<string, CropRect | null> {
  const next = { ...crops };
  for (const id of ids) next[id] = crop ? clone(crop) : null;
  return next;
}

export function framesWithBase(edits: Record<string, InvertParams>, ids: string[]): string[] {
  return ids.filter((id) => edits[id]?.base_override != null);
}

export function applyBaseToAll(
  edits: Record<string, InvertParams>, ids: string[], base: [number, number, number] | null,
): Record<string, InvertParams> {
  const next = { ...edits };
  for (const id of ids) next[id] = { ...entry(edits, id), base_override: base ? [...base] : null };
  return next;
}

export function framesWithWhitePoint(edits: Record<string, InvertParams>, ids: string[]): string[] {
  return ids.filter((id) => edits[id]?.d_max_override != null);
}

export function applyWhitePointToAll(
  edits: Record<string, InvertParams>, ids: string[], dmax: number | null,
): Record<string, InvertParams> {
  const next = { ...edits };
  for (const id of ids) next[id] = { ...entry(edits, id), d_max_override: dmax };
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app run test:unit -- roll/apply`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/roll/apply.ts app/src/lib/roll/apply.test.ts
git commit -m "feat(develop): pure apply-to-roll + conflict detection"
```

### Task 5: Parametrize the reusable panels with a `paramsStore` prop

So `TonalCurve`, `ColorGrading`, `ColorMixer` can edit the roll draft instead of the active image. The change is mechanical: accept a store prop defaulting to the global `params`, and route reads/writes through it. Tune keeps working because the default is `params`.

**Files:**
- Modify: `app/src/lib/develop/TonalCurve.svelte`
- Modify: `app/src/lib/develop/ColorGrading.svelte`
- Modify: `app/src/lib/develop/ColorMixer.svelte`

**Interfaces:**
- Consumes: `ParamsStore` (perImage.ts), `params` (store.ts)
- Produces: each panel gains `export let paramsStore: ParamsStore = params;` and a `showPointColor` prop on ColorMixer.

- [ ] **Step 1: TonalCurve — inject the store**

In `app/src/lib/develop/TonalCurve.svelte`:
- Change the import on line 3 from `import { params } from "../store";` to:
  ```ts
  import { params } from "../store";
  import type { ParamsStore } from "../perImage";
  ```
- Add a prop (next to the existing `export let onWpPick` block):
  ```ts
  export let paramsStore: ParamsStore = params;
  ```
- Replace every `$params` with `$paramsStore` and every `params.update(` with `paramsStore.update(` in this file. (Verify with `grep -n "\\\$params\\|params\\.update\\|params\\.set" app/src/lib/develop/TonalCurve.svelte` — after the edit only the `paramsStore` versions and the import line should remain.)

- [ ] **Step 2: ColorGrading — inject the store**

In `app/src/lib/develop/ColorGrading.svelte`:
- After line 3 (`import { params } from "../store";`) add:
  ```ts
  import type { ParamsStore } from "../perImage";
  ```
- Add a script prop:
  ```ts
  export let paramsStore: ParamsStore = params;
  ```
- Replace every `$params` with `$paramsStore` and `params.update(` with `paramsStore.update(`.

- [ ] **Step 3: ColorMixer — inject the store + hide point color**

In `app/src/lib/develop/ColorMixer.svelte`:
- After line 3 add:
  ```ts
  import type { ParamsStore } from "../perImage";
  ```
- Add props:
  ```ts
  export let paramsStore: ParamsStore = params;
  export let showPointColor = true;
  ```
- Replace every `$params` with `$paramsStore` and `params.update(` with `paramsStore.update(`.
- Find the tab/section that renders Point Color (the eyedropper UI driven by `onPick` / `picking`) and wrap it with `{#if showPointColor}...{/if}` so the roll panel can omit it. (Locate it: `grep -n "onPick\|picking\|pc_samples\|point" app/src/lib/develop/ColorMixer.svelte`.)

- [ ] **Step 4: Type-check + Tune regression smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: in Tune, exercise the tone curve, color grading wheels, and color mixer bands on an image — all must still write to the active image exactly as before (no behavior change, since the default store is `params`).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/TonalCurve.svelte app/src/lib/develop/ColorGrading.svelte app/src/lib/develop/ColorMixer.svelte
git commit -m "refactor(develop): panels accept an injectable paramsStore"
```

### Task 6: Roll adjust panel (tone sliders + WB + WP slider) bound to the draft

A lean side panel for the contact sheet: the tonal/WB sliders and a D_max slider, all writing to `rollDraft.params`. Reuses `Slider`, `TonalCurve`, `ColorGrading`, `ColorMixer` (the last three via the `paramsStore` prop from Task 5). Excludes film base, WB gray-point pick, white-point pick (those are reference-frame ops in Milestone 3).

**Files:**
- Create: `app/src/lib/roll/draftParams.ts`
- Test: `app/src/lib/roll/draftParams.test.ts`
- Create: `app/src/lib/roll/RollAdjust.svelte`
- Modify: `/i18n-strings.csv`

**Interfaces:**
- Consumes: `rollDraft` (roll/draft.ts); `ParamsStore` (perImage.ts)
- Produces:
  - `draftParamsStore(): ParamsStore` — a `ParamsStore` adapter over `rollDraft` so the parametrized panels and `bind:value` can read/write `rollDraft.params`.

- [ ] **Step 1: Write the failing test for the adapter**

```ts
// app/src/lib/roll/draftParams.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { rollDraft, resetRollDraft } from "./draft";
import { draftParamsStore } from "./draftParams";

describe("draftParamsStore", () => {
  beforeEach(() => resetRollDraft());

  it("reads rollDraft.params", () => {
    const ps = draftParamsStore();
    expect(get(ps).exposure).toBe(0);
    rollDraft.update((d) => ({ ...d, params: { ...d.params, exposure: 1.5 } }));
    expect(get(ps).exposure).toBe(1.5);
  });

  it("update writes back into rollDraft.params as a new reference", () => {
    const ps = draftParamsStore();
    const before = get(rollDraft).params;
    ps.update((p) => ({ ...p, contrast: 25 }));
    expect(get(rollDraft).params.contrast).toBe(25);
    expect(get(rollDraft).params).not.toBe(before);
  });

  it("set replaces rollDraft.params", () => {
    const ps = draftParamsStore();
    const next = { ...get(rollDraft).params, saturation: 40 };
    ps.set(next);
    expect(get(rollDraft).params.saturation).toBe(40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app run test:unit -- roll/draftParams`
Expected: FAIL — cannot find module `./draftParams`.

- [ ] **Step 3: Write the adapter**

```ts
// app/src/lib/roll/draftParams.ts
import { derived, get } from "svelte/store";
import type { InvertParams } from "../api";
import type { ParamsStore } from "../perImage";
import { rollDraft } from "./draft";

/** A ParamsStore view over rollDraft.params, so the editing panels (which take a
 * ParamsStore) can drive the roll draft. Each write stores a fresh params object. */
export function draftParamsStore(): ParamsStore {
  const view = derived(rollDraft, (d) => d.params);
  return {
    subscribe: view.subscribe,
    set: (p: InvertParams) => rollDraft.update((d) => ({ ...d, params: { ...p } })),
    update: (fn) => rollDraft.update((d) => ({ ...d, params: { ...fn(get(rollDraft).params) } })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app run test:unit -- roll/draftParams`
Expected: PASS (3 tests).

- [ ] **Step 5: Add i18n rows for the panel heading + sliders**

Add to `/i18n-strings.csv`:

```
roll.adjust.heading,"Roll look","整卷色调","src/lib/roll/RollAdjust.svelte","heading"
roll.adjust.whitePoint,"White point","白点","src/lib/roll/RollAdjust.svelte","label"
```

Run: `python3 scripts/gen-i18n.py`. Verify the keys appear in `dict.ts`.

- [ ] **Step 6: Build the panel**

Build `app/src/lib/roll/RollAdjust.svelte`. It holds the draft `ParamsStore` once (`const ps = draftParamsStore()`), renders the tonal/WB sliders with `bind:value={$ps.<field>}` mirroring the slider rows in `app/src/lib/develop/Basic.svelte` (exposure, contrast, highlights, shadows, whites, blacks, texture, vibrance, saturation, temp, tint) plus a `White point` slider bound to `$ps.d_max_override`, then mounts the three reused panels with the draft store:

```svelte
<!-- app/src/lib/roll/RollAdjust.svelte -->
<script lang="ts">
  import { t } from "$lib/i18n";
  import Slider from "$lib/develop/Slider.svelte";
  import TonalCurve from "$lib/develop/TonalCurve.svelte";
  import ColorGrading from "$lib/develop/ColorGrading.svelte";
  import ColorMixer from "$lib/develop/ColorMixer.svelte";
  import { signed, ev, kelvin, TEMP_GRADIENT, TINT_GRADIENT, SAT_GRADIENT } from "$lib/develop/gradients";
  import { draftParamsStore } from "./draftParams";

  const ps = draftParamsStore();
</script>

<div class="adjust">
  <h3>{$t('roll.adjust.heading')}</h3>

  <!-- These rows are copied VERBATIM from Basic.svelte (lines ~248-271), with only
       `$params` swapped for `$ps`. Same label keys / min / max / step / scale /
       gradient / format so the roll look matches per-image Tune exactly. -->
  <Slider label={$t('basic.temp')} min={2000} max={50000} step={0.5} scale="reciprocal" scrubStep={10}
          gradient={TEMP_GRADIENT} bind:value={$ps.temp} def={5500} format={kelvin} />
  <Slider label={$t('basic.tint')} min={-150} max={150} step={1}
          gradient={TINT_GRADIENT} bind:value={$ps.tint} def={0} format={signed} />
  <Slider label={$t('basic.exposure')} min={-5} max={5} step={0.01} bind:value={$ps.exposure} def={0} format={ev} />
  <Slider label={$t('basic.contrast')} min={-100} max={100} bind:value={$ps.contrast} def={0} format={signed} />
  <Slider label={$t('basic.highlights')} min={-100} max={100} bind:value={$ps.highlights} def={0} format={signed} />
  <Slider label={$t('basic.shadows')} min={-100} max={100} bind:value={$ps.shadows} def={0} format={signed} />
  <Slider label={$t('basic.whites')} min={-100} max={100} bind:value={$ps.whites} def={0} format={signed} />
  <Slider label={$t('basic.blacks')} min={-100} max={100} bind:value={$ps.blacks} def={0} format={signed} />
  <Slider label={$t('basic.texture')} min={-100} max={100} bind:value={$ps.texture} def={0} format={signed} />
  <Slider label={$t('basic.vibrance')} min={-100} max={100} bind:value={$ps.vibrance} def={0} gradient={SAT_GRADIENT} format={signed} />
  <Slider label={$t('basic.saturation')} min={-100} max={100} bind:value={$ps.saturation} def={0} gradient={SAT_GRADIENT} format={signed} />

  <TonalCurve paramsStore={ps} onWpPick={null} wpPicking={false} />
  <ColorGrading paramsStore={ps} />
  <ColorMixer paramsStore={ps} showPointColor={false} onPick={null} picking={false} />
</div>

<style>
  .adjust { display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0 0 4px; font-size: 13px; color: var(--text); }
</style>
```

Implementer notes:
- Open `app/src/lib/develop/Basic.svelte` (rows ~248-271) and confirm each row's props
  against the live file; if any differ from the above, the live file wins — copy it
  verbatim and only swap `$params` → `$ps`. Import `TEMP_GRADIENT`, `TINT_GRADIENT`,
  `SAT_GRADIENT`, `signed`, `ev`, `kelvin` from `$lib/develop/gradients` (extend the
  import line in the script accordingly).
- **White point (D_max) slider:** there is no Basic row to copy 1:1, and
  `d_max_override` is `number | null`. Do NOT add a raw `bind:value` to a nullable.
  Defer the D_max slider to Task 12 (it pairs with the reference-frame pick); for this
  task, ship the tone/WB sliders + the three reused panels only. The `roll.adjust.whitePoint`
  string is added now so Task 12 can mount the slider here without another i18n round-trip.

- [ ] **Step 7: Type-check**

Run: `npm --prefix app run check`
Expected: no errors. (`RollAdjust` not yet mounted anywhere — that's Task 8.)

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/roll/draftParams.ts app/src/lib/roll/draftParams.test.ts app/src/lib/roll/RollAdjust.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): roll adjust panel bound to draft"
```

### Task 7: Overwrite-confirm dialog

A reusable confirm shown before any apply-to-roll that would clobber non-default frames.

**Files:**
- Create: `app/src/lib/roll/ConfirmOverwrite.svelte`
- Modify: `/i18n-strings.csv`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ConfirmOverwrite.svelte` — props `count: number`; dispatches `confirm` and `cancel`. (Model the markup on `app/src/lib/overlay/ConfirmApplySettings.svelte`.)

- [ ] **Step 1: Add i18n rows**

```
confirmOverwrite.title,"Overwrite {count} edited frame{plural}?","覆盖 {count} 张已编辑的胶片？","src/lib/roll/ConfirmOverwrite.svelte","heading"
confirmOverwrite.sub,"Some frames in this roll already have edits. Applying to the whole roll will replace them.","本卷中部分胶片已有编辑。应用到整卷将覆盖它们。","src/lib/roll/ConfirmOverwrite.svelte","paragraph"
confirmOverwrite.cancel,"Cancel","取消","src/lib/roll/ConfirmOverwrite.svelte","button"
confirmOverwrite.overwrite,"Overwrite all","全部覆盖","src/lib/roll/ConfirmOverwrite.svelte","button"
```

Run: `python3 scripts/gen-i18n.py`; verify keys in `dict.ts`.

- [ ] **Step 2: Read the existing confirm for the exact pattern**

Read `app/src/lib/overlay/ConfirmApplySettings.svelte` and copy its modal scaffold (overlay div, GlassPanel/card, button row, `createEventDispatcher`, Escape/backdrop handling). Reuse its `{plural}` convention (`count === 1 ? '' : 's'`).

- [ ] **Step 3: Create `ConfirmOverwrite.svelte`**

Mirror `ConfirmApplySettings.svelte` but with: prop `export let count: number;`, title `confirmOverwrite.title` (pass `{ count, plural: count === 1 ? '' : 's' }` to `$t`), body `confirmOverwrite.sub`, a Cancel button dispatching `cancel`, and an Overwrite button (`confirmOverwrite.overwrite`) dispatching `confirm`.

- [ ] **Step 4: Type-check**

Run: `npm --prefix app run check`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/roll/ConfirmOverwrite.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): overwrite-confirm dialog"
```

### Task 8: Wire adjust panel + live preview + Apply look into `Roll.svelte`

**Files:**
- Modify: `app/src/lib/tabs/Roll.svelte`
- Create: `app/src/lib/roll/livePreview.ts`
- Test: `app/src/lib/roll/livePreview.test.ts`

**Interfaces:**
- Consumes: `rollDraft` (draft.ts); `developedFolderImages` (eligible.ts); `editsById`, `cropById`, `folderBaseByPath`, `images` (store.ts); `toneColorOf`, `framesWithToneColor`, `applyToneColorToAll` (apply.ts); `withEffectiveBase` (develop/base.ts); `imageDir` (library/folderScope.ts); `api.thumbnail` (api.ts)
- Produces:
  - `livePreviewParams(draft: InvertParams, frame: InvertParams): InvertParams` — merge the draft's tone/color onto a frame's own base/dmax/stock so a preview shows the roll look on that frame's calibration.
  - `draftThumbView(crop: CropRect | null): ThumbView`

- [ ] **Step 1: Write the failing test for the preview merge**

```ts
// app/src/lib/roll/livePreview.test.ts
import { describe, it, expect } from "vitest";
import { defaultParams } from "../api";
import { livePreviewParams, draftThumbView } from "./livePreview";
import type { CropRect } from "../crop/types";

describe("livePreviewParams", () => {
  it("takes tone/color from the draft but base/dmax from the frame", () => {
    const draft = { ...defaultParams(), contrast: 40, base_override: [9, 9, 9] as [number, number, number], d_max_override: 7 };
    const frame = { ...defaultParams(), base_override: [0.3, 0.3, 0.3] as [number, number, number], d_max_override: 2 };
    const out = livePreviewParams(draft, frame);
    expect(out.contrast).toBe(40);                  // from draft
    expect(out.base_override).toEqual([0.3, 0.3, 0.3]); // from frame
    expect(out.d_max_override).toBe(2);             // from frame
  });
});

describe("draftThumbView", () => {
  it("maps a CropRect to a ThumbView", () => {
    const crop: CropRect = { rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, aspect: "custom", orientation: "landscape", rot90: 1, flipH: true, flipV: false, angle: 3 };
    expect(draftThumbView(crop)).toEqual({
      image_crop: [0.1, 0.2, 0.5, 0.6], rot90: 1, flip_h: true, flip_v: false, angle: 3,
    });
  });

  it("maps null to a full-frame view", () => {
    expect(draftThumbView(null)).toEqual({ image_crop: null, rot90: 0, flip_h: false, flip_v: false, angle: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app run test:unit -- roll/livePreview`
Expected: FAIL — cannot find module `./livePreview`.

- [ ] **Step 3: Write the helper**

```ts
// app/src/lib/roll/livePreview.ts
import type { InvertParams, ThumbView } from "../api";
import type { CropRect } from "../crop/types";
import { toneColorOf } from "./apply";

/** Preview params for one frame: the roll draft's tone/color look, but the frame's
 * own film base + white point (so the look is judged on each frame's calibration). */
export function livePreviewParams(draft: InvertParams, frame: InvertParams): InvertParams {
  return { ...frame, ...toneColorOf(draft) };
}

/** The draft crop geometry as a ThumbView for api.thumbnail. */
export function draftThumbView(crop: CropRect | null): ThumbView {
  return {
    image_crop: crop ? [crop.rect.x, crop.rect.y, crop.rect.w, crop.rect.h] : null,
    rot90: crop?.rot90 ?? 0, flip_h: crop?.flipH ?? false, flip_v: crop?.flipV ?? false, angle: crop?.angle ?? 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app run test:unit -- roll/livePreview`
Expected: PASS.

- [ ] **Step 5: Wire the panel, live preview, and Apply into `Roll.svelte`**

Extend `app/src/lib/tabs/Roll.svelte`:

- Add a right-hand `<aside>` rendering `RollAdjust` plus an **Apply look to roll** button (`$t('roll.applyLook')`).
- Live preview: keep a component-local `Record<string, string>` of draft thumbnails. On `rollDraft` change (debounced ~250ms with the existing `debounce` from `catalog.ts`), for each `developedFolderImages` frame call
  `api.thumbnail(frame.id, withEffectiveBase(livePreviewParams($rollDraft.params, editsEntry(frame.id)), imageDir(frame)), draftThumbView($rollDraft.crop))`
  and store the data-URL keyed by id; render `previewMap[img.id] ?? img.thumbnail` in each cell. Cancel/replace in-flight renders on the next change (track a monotonically increasing token; ignore stale resolutions).
- Apply look: on click, compute `ids = $developedFolderImages.map(i => i.id)` and `conflicts = framesWithToneColor($editsById, ids)`. If `conflicts.length > 0`, show `ConfirmOverwrite` with `count={conflicts.length}`; on confirm call `applyLook()`. Else call `applyLook()` directly.
  `applyLook()`: `editsById.set(applyToneColorToAll(get(editsById), ids, $rollDraft.params))`. The write auto-persists. Then write the rendered draft thumbnails back into `images` so the applied look sticks in the filmstrip/grid: for each id with a `previewMap[id]`, `images.update(xs => xs.map(i => i.id === id ? { ...i, thumbnail: previewMap[id] } : i))` and `api.saveThumbnail(id, previewMap[id])`.

Helper inside the component:
```ts
import { get } from "svelte/store";
import { defaultParams } from "$lib/api";
const editsEntry = (id: string) => get(editsById)[id] ?? defaultParams();
```

Use the layout grid `grid-template-columns: 1fr 320px` (sheet | panel), matching Tune's right-panel width.

- [ ] **Step 6: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: open Develop on a developed folder. Drag Exposure/Contrast/Saturation — all thumbnails update to the new look within ~250ms. Click **Apply look to roll** on a clean roll → applies silently. Edit one frame in Tune, return to Develop, change a slider, Apply → the overwrite-confirm appears; Overwrite writes to all, Cancel leaves frames untouched. Switch to Tune and confirm each frame now carries the roll look and can be further tuned.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/tabs/Roll.svelte app/src/lib/roll/livePreview.ts app/src/lib/roll/livePreview.test.ts
git commit -m "feat(develop): live preview + apply look to roll"
```

---

## Milestone 3 — Reference frame: crop / film base / white point → apply to all

Deliverable: tapping a frame opens a full-screen overlay where the user sets crop/rotation/flips, samples film base, and picks white point on that frame, each with an "Apply to roll" that propagates to every frame.

### Task 9: Full-screen frame preview overlay (preview + close)

**Files:**
- Create: `app/src/lib/roll/FramePreview.svelte`
- Modify: `app/src/lib/tabs/Roll.svelte` (replace the Task 3 placeholder)

**Interfaces:**
- Consumes: `rollReferenceId` (draft.ts); `images`, `activeId` (store.ts); `Viewport` (viewport/Viewport.svelte); `withEffectiveBase` (develop/base.ts)
- Produces: `FramePreview.svelte` — renders the frame at `$rollReferenceId` large via `Viewport`, with a Close button that sets `rollReferenceId` back to null.

- [ ] **Step 1: Build the overlay (preview only)**

Create `app/src/lib/roll/FramePreview.svelte`: a fixed full-screen overlay (`position: fixed; inset: 0; z-index: 50; background: #111`). Look at how `app/src/lib/tabs/Develop.svelte` mounts `Viewport` (lines 377-389) and pass the equivalent props for the reference frame using that frame's own committed crop from `$cropById` (so the preview shows the frame as it currently is). Add a Close button (`$t('roll.close')`) that calls `rollReferenceId.set(null)`. Close on Escape too.

- [ ] **Step 2: Mount it from `Roll.svelte`**

Replace the Task 3 placeholder block:

```svelte
{#if $rollReferenceId}
  <!-- FramePreview added in Task 9; placeholder keeps the shell compilable. -->
{/if}
```

with:

```svelte
{#if $rollReferenceId}
  <FramePreview />
{/if}
```

and add `import FramePreview from "$lib/roll/FramePreview.svelte";` to the script.

- [ ] **Step 3: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: tap a frame in the contact sheet → it opens full-screen showing the developed frame; Close (button or Escape) returns to the sheet.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/roll/FramePreview.svelte app/src/lib/tabs/Roll.svelte
git commit -m "feat(develop): full-screen frame preview overlay"
```

### Task 10: Crop / rotation / flips in the frame view → apply to roll

**Files:**
- Modify: `app/src/lib/roll/FramePreview.svelte`
- Modify: `/i18n-strings.csv`

**Interfaces:**
- Consumes: `CropView` + `CropPanel` + crop math (`cropMath.ts`, `transforms.ts`, `presets.ts`); `rollDraft` (draft.ts); `cropById`, `editsById`, `images` (store.ts); `framesWithCrop`, `applyCropToAll` (apply.ts); `ConfirmOverwrite.svelte`
- Produces: crop draft state inside FramePreview + an `Apply crop to roll` action writing `cropById`.

- [ ] **Step 1: Add i18n rows**

```
roll.crop.apply,"Apply crop to roll","应用裁剪到整卷","src/lib/roll/FramePreview.svelte","button"
roll.crop.tool,"Crop","裁剪","src/lib/roll/FramePreview.svelte","button"
```

Run `python3 scripts/gen-i18n.py`; verify in `dict.ts`.

- [ ] **Step 2: Port the crop draft logic**

In `FramePreview.svelte`, add a Crop mode. Copy the crop draft state machine from `app/src/lib/tabs/Develop.svelte` (the `rect/aspect/orientation/rot90/flipH/flipV/angle` locals and the `startCrop`/`draftCrop`/`onPreset`/`onSwap`/`onReset`/`onRotate`/`onFlip`/`onStraighten` functions, lines 88-138). Render `CropView` + `CropPanel` exactly as Develop does (lines 360-363 and 414-416) but seed `startCrop()` from `$rollDraft.crop` (falling back to full frame) instead of `$activeCrop`, and write the committed draft crop into `rollDraft` (`rollDraft.update(d => ({ ...d, crop: draftCrop() }))`) rather than `cropById`.

- [ ] **Step 3: Add the Apply-crop-to-roll action**

Add an **Apply crop to roll** button. On click: `ids = developed folder ids`, `conflicts = framesWithCrop($cropById, ids)`. If conflicts, show `ConfirmOverwrite` (count = conflicts.length); on confirm run `applyCrop()`, else run directly. `applyCrop()`: `cropById.set(applyCropToAll(get(cropById), ids, $rollDraft.crop))` (auto-persists). Reuse the same `ConfirmOverwrite` component; track which apply is pending with a local `pending: "look" | "crop" | "base" | "wp" | null` so the confirm's `confirm` handler dispatches to the right apply.

- [ ] **Step 4: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: open a frame, enter Crop, set a 4:3 crop + a 90° rotation + a flip, Apply crop to roll. Return to the sheet → every thumbnail reflects the crop/rotation. Open another frame → same crop applied. On a roll where some frames already had crops, the overwrite-confirm appears.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/roll/FramePreview.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): roll crop/rotation/flips via reference frame"
```

### Task 11: Film base sampling in the frame view → apply to roll

**Files:**
- Modify: `app/src/lib/roll/FramePreview.svelte`
- Modify: `/i18n-strings.csv`

**Interfaces:**
- Consumes: `BaseView` (develop/BaseView.svelte) OR `api.sampleBaseAt` / `api.autoBaseInfo`; `rollDraft` (draft.ts); `editsById` (store.ts); `framesWithBase`, `applyBaseToAll` (apply.ts)
- Produces: a base picker in the frame view that sets `rollDraft.params.base_override` + an `Apply film base to roll` action.

- [ ] **Step 1: Add i18n rows**

```
roll.base.sample,"Sample film base","采样片基","src/lib/roll/FramePreview.svelte","button"
roll.base.apply,"Apply film base to roll","应用片基到整卷","src/lib/roll/FramePreview.svelte","button"
roll.base.auto,"Auto film base","自动片基","src/lib/roll/FramePreview.svelte","button"
```

Run `python3 scripts/gen-i18n.py`; verify in `dict.ts`.

- [ ] **Step 2: Add a base-sampling mode**

Look at how `app/src/lib/tabs/Develop.svelte` arms base sampling and overlays `BaseView` (lines 86, 390-395) and how `app/src/lib/develop/Basic.svelte` consumes `sampledBase` / `auto_base_info`. In FramePreview, add a "Sample film base" toggle that overlays `BaseView` on the frame; on its `sampled` event set `rollDraft.update(d => ({ ...d, params: { ...d.params, base_override: e.detail } }))`. Add an "Auto film base" button that calls `api.autoBaseInfo($rollReferenceId)` and writes `.base` into the draft the same way.

- [ ] **Step 3: Add the Apply-base-to-roll action**

**Apply film base to roll** button. `ids = developed folder ids`, `conflicts = framesWithBase($editsById, ids)`. Confirm-if-conflicts, then `editsById.set(applyBaseToAll(get(editsById), ids, $rollDraft.params.base_override))`.

- [ ] **Step 4: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: open a frame, Sample film base by dragging over the rebate (or Auto), Apply film base to roll. The whole sheet re-previews with the new base (live preview already merges each frame's base, so after Apply re-render reflects it). Conflicts trigger the confirm.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/roll/FramePreview.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): roll film base via reference frame"
```

### Task 12: White-point pick in the frame view → apply to roll

**Files:**
- Modify: `app/src/lib/roll/FramePreview.svelte`
- Modify: `app/src/lib/roll/RollAdjust.svelte` (add the D_max slider deferred from Task 6)
- Modify: `/i18n-strings.csv`

**Interfaces:**
- Consumes: `api.analyzeWhitePoint`; `rollDraft` (draft.ts); `editsById` (store.ts); `framesWithWhitePoint`, `applyWhitePointToAll` (apply.ts); `withEffectiveBase` (develop/base.ts)
- Produces: a white-point pick in the frame view + `Apply white point to roll` action, plus the D_max slider in `RollAdjust`.

- [ ] **Step 1: Add i18n rows**

```
roll.wp.pick,"Pick white point","拾取白点","src/lib/roll/FramePreview.svelte","button"
roll.wp.apply,"Apply white point to roll","应用白点到整卷","src/lib/roll/FramePreview.svelte","button"
```

Run `python3 scripts/gen-i18n.py`; verify in `dict.ts`.

- [ ] **Step 2: Add the D_max slider to `RollAdjust.svelte`**

Look at how `Basic.svelte` exposes the D_max / white-point override (its Tone/white-point section) for the exact range + format. Add a slider to `RollAdjust` bound through a null-guard: a local `$: dmax = $ps.d_max_override ?? <Basic's measured/default baseline>;` plus an `on:input`/setter that does `ps.update(p => ({ ...p, d_max_override: v }))`. Label `$t('roll.adjust.whitePoint')`. Do not bind a nullable directly.

- [ ] **Step 3: Add the pick interaction in the frame view**

Reuse the Viewport `pointPick` crosshair flow from `app/src/lib/tabs/Develop.svelte` (lines 316-343: arm `pointPick`, on `pointpick` build a small rect around `u,v` and call `api.analyzeWhitePoint`). In FramePreview, on a successful pick set `rollDraft.update(d => ({ ...d, params: { ...d.params, d_max_override: d_max } }))`. Pass `withEffectiveBase($rollDraft.params, imageDir(frame))` as the params to `analyzeWhitePoint` so the measurement uses the draft base.

- [ ] **Step 4: Add the Apply-white-point-to-roll action**

**Apply white point to roll** button. `conflicts = framesWithWhitePoint($editsById, ids)`. Confirm-if-conflicts, then `editsById.set(applyWhitePointToAll(get(editsById), ids, $rollDraft.params.d_max_override))`.

- [ ] **Step 5: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: in the frame view, Pick white point on the exposed leader (or use the D_max slider in the side panel), Apply white point to roll. Conflicts trigger the confirm. Confirm the live sheet and Tune reflect the D_max.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/roll/FramePreview.svelte app/src/lib/roll/RollAdjust.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): roll white point via slider + reference pick"
```

---

## Milestone 4 — Contact-sheet export

Deliverable: an "Export contact sheet" action composites the developed frames into a single image and saves it via the OS dialog.

### Task 13: Contact-sheet layout math

**Files:**
- Create: `app/src/lib/roll/contactSheet.ts`
- Test: `app/src/lib/roll/contactSheet.test.ts`

**Interfaces:**
- Produces:
  - `interface Tile { x: number; y: number; w: number; h: number }`
  - `interface SheetLayout { width: number; height: number; cols: number; rows: number; tiles: Tile[] }`
  - `layoutContactSheet(count: number, opts: { cols: number; tileW: number; tileH: number; gap: number; margin: number }): SheetLayout`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/roll/contactSheet.test.ts
import { describe, it, expect } from "vitest";
import { layoutContactSheet } from "./contactSheet";

describe("layoutContactSheet", () => {
  const opts = { cols: 3, tileW: 100, tileH: 75, gap: 10, margin: 20 };

  it("computes canvas size from cols/rows + gaps + margins", () => {
    const l = layoutContactSheet(6, opts); // 6 frames, 3 cols → 2 rows
    expect(l.cols).toBe(3);
    expect(l.rows).toBe(2);
    // width = 2*margin + 3*tileW + 2*gap = 40 + 300 + 20 = 360
    expect(l.width).toBe(360);
    // height = 2*margin + 2*tileH + 1*gap = 40 + 150 + 10 = 200
    expect(l.height).toBe(200);
  });

  it("places tiles left-to-right, top-to-bottom", () => {
    const l = layoutContactSheet(4, opts);
    expect(l.rows).toBe(2);
    expect(l.tiles[0]).toEqual({ x: 20, y: 20, w: 100, h: 75 });            // r0c0
    expect(l.tiles[1]).toEqual({ x: 130, y: 20, w: 100, h: 75 });           // r0c1 (20+100+10)
    expect(l.tiles[3]).toEqual({ x: 20, y: 105, w: 100, h: 75 });           // r1c0 (20+75+10)
  });

  it("a partial last row still reserves a full row of height", () => {
    const l = layoutContactSheet(5, opts); // 3 cols → 2 rows
    expect(l.rows).toBe(2);
    expect(l.tiles.length).toBe(5);
  });

  it("zero frames yields an empty sheet with just margins", () => {
    const l = layoutContactSheet(0, opts);
    expect(l.rows).toBe(0);
    expect(l.tiles).toEqual([]);
    expect(l.width).toBe(360);   // still cols-wide
    expect(l.height).toBe(40);   // just top+bottom margin
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app run test:unit -- roll/contactSheet`
Expected: FAIL — cannot find module `./contactSheet`.

- [ ] **Step 3: Write the implementation**

```ts
// app/src/lib/roll/contactSheet.ts
export interface Tile { x: number; y: number; w: number; h: number }
export interface SheetLayout { width: number; height: number; cols: number; rows: number; tiles: Tile[] }

/** Lay out `count` equal tiles in a `cols`-wide grid with uniform gaps + margin.
 * Pure geometry — pixel coordinates for a canvas compositor. */
export function layoutContactSheet(
  count: number,
  opts: { cols: number; tileW: number; tileH: number; gap: number; margin: number },
): SheetLayout {
  const { cols, tileW, tileH, gap, margin } = opts;
  const rows = Math.ceil(count / cols);
  const width = 2 * margin + cols * tileW + (cols - 1) * gap;
  const height = 2 * margin + (rows === 0 ? 0 : rows * tileH + (rows - 1) * gap);
  const tiles: Tile[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    tiles.push({ x: margin + c * (tileW + gap), y: margin + r * (tileH + gap), w: tileW, h: tileH });
  }
  return { width, height, cols, rows, tiles };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app run test:unit -- roll/contactSheet`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/roll/contactSheet.ts app/src/lib/roll/contactSheet.test.ts
git commit -m "feat(develop): contact-sheet layout math"
```

### Task 14: Export the contact sheet to an image

**Files:**
- Create: `app/src/lib/roll/exportSheet.ts`
- Modify: `app/src/lib/tabs/Roll.svelte` (add the Export button)
- Modify: `/i18n-strings.csv`

**Interfaces:**
- Consumes: `layoutContactSheet` (contactSheet.ts); `developedFolderImages` (eligible.ts); `editsById`, `cropById`, `folderBaseByPath` (store.ts); `api.thumbnail` (api.ts); `livePreviewParams`/`draftThumbView` are NOT used here — export uses each frame's OWN applied edits (post-apply), not the draft; `withEffectiveBase` (develop/base.ts); `@tauri-apps/plugin-dialog` `save`; `@tauri-apps/plugin-fs` writeFile (check how the existing export writes files — reuse the same dialog/write path as `ExportModal.svelte`).
- Produces: `exportContactSheet(): Promise<void>` — render each developed frame to a tile, composite per `layoutContactSheet`, encode the canvas, write the file.

- [ ] **Step 1: Inspect the existing save path**

Read `app/src/lib/export/ExportModal.svelte` to see exactly how it opens the save dialog (`@tauri-apps/plugin-dialog`) and writes bytes (which Tauri command / fs plugin). Reuse that mechanism so the contact-sheet file write matches the app's conventions (no new Rust command).

- [ ] **Step 2: Add i18n row**

```
roll.export.button,"Export contact sheet","导出印样","src/lib/tabs/Roll.svelte","button"
```

Run `python3 scripts/gen-i18n.py`; verify in `dict.ts`.

- [ ] **Step 3: Write the compositor**

`app/src/lib/roll/exportSheet.ts`:
- Read the developed frames from `get(developedFolderImages)`.
- For each frame, render a tile data-URL via `api.thumbnail(id, withEffectiveBase(editsEntry(id), imageDir(frame)), thumbViewFromCrop(get(cropById)[id]))` where `editsEntry`/`thumbViewFromCrop` mirror Task 8 helpers (the frame's OWN edits + crop, since export happens after Apply). Load each into an `Image`.
- Choose `cols` (e.g. `Math.ceil(Math.sqrt(count))` or a fixed 5) and tile size (e.g. 400×300); call `layoutContactSheet(count, { cols, tileW, tileH, gap: 12, margin: 24 })`.
- Create a `<canvas>` of `layout.width × layout.height`, fill background, and `drawImage` each loaded tile at its `tiles[i]` rect (object-fit: contain inside the tile — letterbox).
- `canvas.toBlob`/`toDataURL` to PNG (or JPEG), open the save dialog (default name `contact-sheet.png`), and write the bytes using the same path identified in Step 1.

- [ ] **Step 4: Add the Export button to `Roll.svelte`**

Add an **Export contact sheet** button (`$t('roll.export.button')`) in the side panel/header that calls `exportContactSheet()`. Disable it when `$developedFolderImages.length === 0`.

- [ ] **Step 5: Type-check + manual smoke**

Run: `npm --prefix app run check`
Expected: no errors.
Manual: on a developed folder, click Export contact sheet → save dialog → open the saved PNG: a grid of all developed frames, each showing its applied look + crop, letterboxed in equal tiles. Verify an empty folder disables the button.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/roll/exportSheet.ts app/src/lib/tabs/Roll.svelte /i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): export contact sheet to image"
```

---

## Final verification

- [ ] Run the full unit suite: `npm --prefix app run test:unit` → all green.
- [ ] Type-check: `npm --prefix app run check` → no errors.
- [ ] Full manual pass: Library → Develop (contact sheet) → adjust look (live on all) → reference frame crop/base/wp → Apply each (with overwrite-confirm where frames pre-edited) → Tune fine-tunes a frame → Export contact sheet. Confirm Tune and Export tabs are unchanged.

## Notes / decisions baked in

- **Internal route name is `"roll"`** (UI label "Develop") to avoid colliding with `"develop"` (Tune).
- **Live preview merges draft tone/color onto each frame's own base/dmax** so the look is judged per-frame; base/wp only change the sheet after their explicit Apply.
- **Each Apply writes only its slice** (tone/color, crop, base, or white point) so a later base push doesn't wipe earlier per-frame tone tuning. Overwrite-confirm is per-slice.
- **No Rust changes** — all rendering/sampling reuses existing commands.
- **Deferred:** the "append film strip" cosmetic on export (per spec).
