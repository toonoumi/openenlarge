# Clipping Warning (Highlight/Shadow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable, GPU-rendered overlay in the Develop viewport that paints highlight-clipping pixels red and shadow-clipping pixels blue, toggled from the histogram corners.

**Architecture:** A `clipWarn` Svelte store holds the toggle state. The histogram corner triangles flip it. `Develop.svelte` passes it as props to `Viewport.svelte`, which converts it (via a pure `clipUniforms()` helper) into three GPU uniforms set in `renderer.ts`'s finishing pass. The finishing fragment shader (`shaders.ts` FRAG) replaces clipped pixels with warning colors right before output. Export is unaffected (the export path never sets the clip uniforms; they default to off).

**Tech Stack:** SvelteKit + TypeScript, WebGL2 (GLSL ES 3.00), Vitest, Python i18n codegen.

## Global Constraints

- Work on `main` (no feature branch) — per project convention.
- Run unit tests from the `app/` directory: `cd app && npm run test:unit`.
- Tests are colocated `*.test.ts` files using Vitest (`import { describe, it, expect } from "vitest"`).
- NEVER edit `app/src/lib/i18n/dict.ts` directly. Edit `i18n-strings.csv` (columns `key,en,zh,file,note`) then run `python3 scripts/gen-i18n.py` from the repo root.
- Do NOT touch the unrelated uncommitted change already in `app/src/lib/viewport/Viewport.svelte`'s working tree — only add the clip-related lines described here. Stage files explicitly by path; never `git add -A`.
- The overlay is GPU-only. The CPU `<img>` fallback intentionally does not render it. No fallback UI.
- Warning colors: highlight = `vec3(1.0, 0.15, 0.15)` (red); shadow = `vec3(0.2, 0.45, 1.0)` (blue).
- Thresholds: normal = 255/0 (uniform `1.0` / `0.0`); strict = 253/2 (`253/255` / `2/255`). `strict` is a single shared flag.

---

### Task 1: `clipUniforms()` helper + tests

Pure function mapping store state → shader uniform values. No GL, no Svelte — fully unit-testable.

**Files:**
- Create: `app/src/lib/viewport/gl/clip.ts`
- Test: `app/src/lib/viewport/gl/clip.test.ts`

**Interfaces:**
- Produces: `interface ClipUniforms { high: number; low: number; lowOn: number }` and `clipUniforms(s: { high: boolean; low: boolean; strict: boolean }): ClipUniforms`.
  - `high`: `0` when highlight warning off (also the shader's "off" sentinel); else the high threshold in 0..1.
  - `low`: shadow threshold in 0..1.
  - `lowOn`: `1` when shadow warning on, else `0`.

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/viewport/gl/clip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clipUniforms } from "./clip";

describe("clipUniforms", () => {
  it("all off → high 0, lowOn 0", () => {
    const u = clipUniforms({ high: false, low: false, strict: false });
    expect(u.high).toBe(0);
    expect(u.lowOn).toBe(0);
  });

  it("highlight on, normal threshold → high 1.0", () => {
    const u = clipUniforms({ high: true, low: false, strict: false });
    expect(u.high).toBe(1.0);
    expect(u.lowOn).toBe(0);
  });

  it("shadow on, normal threshold → lowOn 1, low 0", () => {
    const u = clipUniforms({ high: false, low: true, strict: false });
    expect(u.lowOn).toBe(1);
    expect(u.low).toBe(0);
  });

  it("strict tightens thresholds to 253/255 and 2/255", () => {
    const u = clipUniforms({ high: true, low: true, strict: true });
    expect(u.high).toBeCloseTo(253 / 255, 6);
    expect(u.low).toBeCloseTo(2 / 255, 6);
    expect(u.lowOn).toBe(1);
  });

  it("strict but highlight off → high stays 0 (off sentinel)", () => {
    const u = clipUniforms({ high: false, low: true, strict: true });
    expect(u.high).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm run test:unit -- clip.test.ts`
Expected: FAIL — cannot resolve `./clip` / `clipUniforms is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/viewport/gl/clip.ts`:

```ts
/** GPU uniform values for the clipping-warning overlay. */
export interface ClipUniforms {
  /** 0 = highlight warning off (shader off-sentinel); else high threshold in 0..1. */
  high: number;
  /** Shadow threshold in 0..1. */
  low: number;
  /** 1 = shadow warning on, 0 = off. */
  lowOn: number;
}

/** Map clip-warning toggle state to shader uniform values.
 *  Normal mode flags pure clip (255 / 0); strict mode flags near-clip (253 / 2). */
export function clipUniforms(s: { high: boolean; low: boolean; strict: boolean }): ClipUniforms {
  const hi = s.strict ? 253 / 255 : 1.0;
  const lo = s.strict ? 2 / 255 : 0.0;
  return {
    high: s.high ? hi : 0,
    low: lo,
    lowOn: s.low ? 1 : 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm run test:unit -- clip.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/gl/clip.ts app/src/lib/viewport/gl/clip.test.ts
git commit -m "feat(viewport): clipUniforms helper for clipping-warning thresholds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `clipWarn` store

Shared toggle state for the histogram triangles and the viewport.

**Files:**
- Modify: `app/src/lib/store.ts` (add near `previewSrc` at line 122)

**Interfaces:**
- Produces: `clipWarn: Writable<{ high: boolean; low: boolean; strict: boolean }>`, default `{ high: false, low: false, strict: false }`.

- [ ] **Step 1: Add the store**

In `app/src/lib/store.ts`, immediately after the `previewSrc` export (line 122), add:

```ts
// Clipping-warning overlay toggles (Develop viewport). `high`/`low` enable the
// highlight (red) / shadow (blue) overlays; `strict` tightens the threshold from
// pure clip (255/0) to near-clip (253/2). Shared by Histogram (corner triangles)
// and Develop → Viewport.
export const clipWarn = writable<{ high: boolean; low: boolean; strict: boolean }>(
  { high: false, low: false, strict: false }
);
```

(`writable` is already imported at line 1.)

- [ ] **Step 2: Verify it compiles**

Run: `cd app && npm run check`
Expected: No new errors referencing `store.ts` / `clipWarn`.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/store.ts
git commit -m "feat(store): clipWarn toggle state for clipping warning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Shader — paint clipped pixels in FRAG

Add the clip uniforms and an `applyClip()` helper that replaces clipped pixels with the warning colors, applied on both output paths in `main()`.

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (FRAG: uniform block ~line 39; `applyClip` helper before `void main()` at line 171; both writes to `o` in `main()`)

**Interfaces:**
- Produces (GLSL): uniforms `u_clip_high` (float), `u_clip_low` (float), `u_clip_low_on` (float); function `vec3 applyClip(vec3 c)`.

- [ ] **Step 1: Add the uniform declarations**

In `app/src/lib/viewport/gl/shaders.ts`, in the FRAG shader, after the point-color uniform block (after line 39, `uniform float u_pc_range[8];`), add:

```glsl
// Clipping-warning overlay. u_clip_high <= 0.0 disables the highlight overlay;
// otherwise any channel >= u_clip_high paints red. u_clip_low_on > 0.5 enables the
// shadow overlay (any channel <= u_clip_low paints blue).
uniform float u_clip_high;
uniform float u_clip_low;
uniform float u_clip_low_on;
```

- [ ] **Step 2: Add the `applyClip` helper**

In the FRAG shader, immediately before `void main() {` (line 171), add:

```glsl
vec3 applyClip(vec3 c) {
  if (u_clip_high > 0.0 && (c.r >= u_clip_high || c.g >= u_clip_high || c.b >= u_clip_high))
    return vec3(1.0, 0.15, 0.15);   // highlight clip → red
  if (u_clip_low_on > 0.5 && (c.r <= u_clip_low || c.g <= u_clip_low || c.b <= u_clip_low))
    return vec3(0.2, 0.45, 1.0);    // shadow clip → blue
  return c;
}
```

- [ ] **Step 3: Apply it on both output paths in `main()`**

In the FRAG `main()`, the no-texture early return is currently:

```glsl
  if (abs(u_texture) < 1e-5) { o = vec4(c, 1.0); return; }
```

Change it to:

```glsl
  if (abs(u_texture) < 1e-5) { o = vec4(applyClip(c), 1.0); return; }
```

And the final unsharp output is currently:

```glsl
  o = vec4(clamp(c + k * (c - b), 0.0, 1.0), 1.0);
```

Change it to:

```glsl
  o = vec4(applyClip(clamp(c + k * (c - b), 0.0, 1.0)), 1.0);
```

- [ ] **Step 4: Verify it compiles**

Run: `cd app && npm run check`
Expected: No new TypeScript errors (the shader is a template string; this confirms no syntax breakage in the module). Shader compilation itself is verified at runtime in Task 7.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts
git commit -m "feat(shader): applyClip overlay for highlight/shadow clipping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Renderer — `setClip()` + uniform wiring

Plumb the three uniforms through `FinishRenderer`, defaulting to off so export and non-clip callers are unaffected.

**Files:**
- Modify: `app/src/lib/viewport/gl/renderer.ts` (import; field; constructor uniform locations ~line 135; `setClip` method; `drawFinishPass` ~line 349)

**Interfaces:**
- Consumes: `ClipUniforms` from `./clip` (Task 1).
- Produces: `FinishRenderer.setClip(c: ClipUniforms): void`. When never called, the finishing pass sets `u_clip_high=0, u_clip_low=0, u_clip_low_on=0` (overlay off).

- [ ] **Step 1: Import the type**

At the top of `app/src/lib/viewport/gl/renderer.ts`, add to the existing imports:

```ts
import type { ClipUniforms } from "./clip";
```

- [ ] **Step 2: Add the field**

In the `FinishRenderer` class fields (near `private cm: ColorMixUniforms | null = null;`), add:

```ts
  private clip: ClipUniforms | null = null;
```

- [ ] **Step 3: Register the uniform locations**

In the constructor, the finishing-program location loop currently ends with:

```ts
    for (const u of [
      "u_cm_hue","u_cm_sat","u_cm_lum","u_pc_count","u_pc_hue","u_pc_sat","u_pc_lum",
      "u_pc_hue_shift","u_pc_sat_shift","u_pc_lum_shift","u_pc_variance","u_pc_range",
    ]) this.loc[u] = gl.getUniformLocation(prog, u);
```

Add the clip uniforms to that array so they become:

```ts
    for (const u of [
      "u_cm_hue","u_cm_sat","u_cm_lum","u_pc_count","u_pc_hue","u_pc_sat","u_pc_lum",
      "u_pc_hue_shift","u_pc_sat_shift","u_pc_lum_shift","u_pc_variance","u_pc_range",
      "u_clip_high","u_clip_low","u_clip_low_on",
    ]) this.loc[u] = gl.getUniformLocation(prog, u);
```

- [ ] **Step 4: Add the `setClip` setter**

Next to `setColorGrade` / `setColorMix` (line ~204), add:

```ts
  setClip(c: ClipUniforms) { this.clip = c; }
```

- [ ] **Step 5: Set the uniforms in the finishing pass**

In `drawFinishPass()`, after the color-mix `if (cm) { ... }` block and before `gl.drawArrays(...)`, add:

```ts
    const clip = this.clip;
    gl.uniform1f(this.loc.u_clip_high, clip ? clip.high : 0);
    gl.uniform1f(this.loc.u_clip_low, clip ? clip.low : 0);
    gl.uniform1f(this.loc.u_clip_low_on, clip ? clip.lowOn : 0);
```

- [ ] **Step 6: Verify it compiles**

Run: `cd app && npm run check`
Expected: No new errors in `renderer.ts`.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/viewport/gl/renderer.ts
git commit -m "feat(renderer): setClip wiring for clipping-warning uniforms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Viewport — props + setClip in drawGL + finishKey

Pass the toggle state into the renderer and re-draw on change.

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte` (import; props ~line 45; `drawGL` line 163; `finishKey` line 367)

**Interfaces:**
- Consumes: `clipUniforms` from `./gl/clip` (Task 1); `renderer.setClip` (Task 4).
- Produces: props `clipHigh`, `clipLow`, `clipStrict` (all `boolean`, default `false`) on `<Viewport>`.

- [ ] **Step 1: Import the helper**

In `app/src/lib/viewport/Viewport.svelte`, add to the script imports (near the other `./gl/...` imports, e.g. after line 8):

```ts
  import { clipUniforms } from "./gl/clip";
```

- [ ] **Step 2: Add the props**

After the `autoDustSensitivity` prop (line 45), add:

```ts
  /** Clipping-warning overlay toggles (GPU path only). */
  export let clipHigh = false;
  export let clipLow = false;
  export let clipStrict = false;
```

- [ ] **Step 3: Set the clip uniforms in `drawGL`**

In `drawGL()` (line 163), after `renderer.setColorMix(colorMix(params));` and before `renderer.draw();`, add:

```ts
    renderer.setClip(clipUniforms({ high: clipHigh, low: clipLow, strict: clipStrict }));
```

- [ ] **Step 4: Re-draw when toggles change**

`finishKey` (line 347) drives a GPU redraw with no backend fetch. Append the three clip booleans to the array, immediately before the closing `].join("|");` (after the `JSON.stringify(params.pc_samples),` line):

```ts
    clipHigh, clipLow, clipStrict,
```

So the tail of the array reads:

```ts
    JSON.stringify(params.pc_samples),
    clipHigh, clipLow, clipStrict,
  ].join("|");
```

- [ ] **Step 5: Verify it compiles**

Run: `cd app && npm run check`
Expected: No new errors in `Viewport.svelte`.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(viewport): wire clipping-warning toggles into GPU draw

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: i18n tooltip strings

Add tooltip strings via the CSV + codegen workflow.

**Files:**
- Modify: `i18n-strings.csv` (repo root)
- Generated (do not hand-edit): `app/src/lib/i18n/dict.ts`

**Interfaces:**
- Produces: i18n keys `histogram.clipHigh`, `histogram.clipLow`, `histogram.clipStrictHint` usable via `$t(...)` in Task 7.

- [ ] **Step 1: Add the CSV rows**

Append to `i18n-strings.csv` (match the existing `key,en,zh,file,note` column format and quoting):

```csv
histogram.clipHigh,"Highlight clipping (right-click: 253)","高光裁切（右键：253）","src/lib/viewport/Histogram.svelte","tooltip"
histogram.clipLow,"Shadow clipping (right-click: 253)","暗部裁切（右键：253）","src/lib/viewport/Histogram.svelte","tooltip"
histogram.clipStrictHint,"Strict 253/2 threshold","严格 253/2 阈值","src/lib/viewport/Histogram.svelte","tooltip"
```

- [ ] **Step 2: Regenerate the dictionary**

Run: `python3 scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` regenerates with the three new keys. Confirm with:

Run: `grep -n "clipHigh\|clipLow\|clipStrictHint" app/src/lib/i18n/dict.ts`
Expected: three matches.

- [ ] **Step 3: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "chore(i18n): clipping-warning tooltip strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Histogram corner triangles + Develop wiring

Add the toggle UI and connect the store to the viewport. This is the integration task — its deliverable is verified by running the app.

**Files:**
- Modify: `app/src/lib/viewport/Histogram.svelte` (script import; markup; styles)
- Modify: `app/src/lib/tabs/Develop.svelte` (import; `<Viewport>` props ~line 354)

**Interfaces:**
- Consumes: `clipWarn` store (Task 2); i18n keys (Task 6); `clipHigh/clipLow/clipStrict` props (Task 5).

- [ ] **Step 1: Wire the store into the Histogram script**

In `app/src/lib/viewport/Histogram.svelte`, add to the `<script>` imports:

```ts
  import { clipWarn } from "../store";
  import { t } from "$lib/i18n";
```

And add the toggle handlers below the existing reactive block (after line 27):

```ts
  const toggleHigh = () => clipWarn.update((c) => ({ ...c, high: !c.high }));
  const toggleLow = () => clipWarn.update((c) => ({ ...c, low: !c.low }));
  const toggleStrict = () => clipWarn.update((c) => ({ ...c, strict: !c.strict }));
```

- [ ] **Step 2: Add the corner triangle buttons to the markup**

In `Histogram.svelte`, replace the `<div class="hist">…</div>` block with:

```svelte
<div class="hist">
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
    <polyline points={rPath} class="r" />
    <polyline points={gPath} class="g" />
    <polyline points={bPath} class="b" />
  </svg>
  <button
    class="clip tl" class:on={$clipWarn.low} class:strict={$clipWarn.strict}
    title={$t("histogram.clipLow")} aria-label={$t("histogram.clipLow")}
    on:click={toggleLow} on:contextmenu|preventDefault={toggleStrict}
  ></button>
  <button
    class="clip tr" class:on={$clipWarn.high} class:strict={$clipWarn.strict}
    title={$t("histogram.clipHigh")} aria-label={$t("histogram.clipHigh")}
    on:click={toggleHigh} on:contextmenu|preventDefault={toggleStrict}
  ></button>
</div>
```

- [ ] **Step 3: Add the triangle styles**

In `Histogram.svelte`'s `<style>`, add `position: relative;` to `.hist` and append the button styles:

```css
  .hist { position: relative; }
  .clip { position: absolute; top: 4px; width: 0; height: 0; padding: 0; border: none;
    background: none; cursor: pointer; opacity: 0.5; z-index: 1; }
  .clip:hover { opacity: 0.85; }
  .clip.on { opacity: 1; }
  /* Triangles pointing into the histogram from each top corner. */
  .clip.tl { left: 4px; border-top: 9px solid #5a9cff; border-right: 9px solid transparent; }
  .clip.tr { right: 4px; border-top: 9px solid #ff5a5a; border-left: 9px solid transparent; }
  /* Strict (253) mode: outline the active triangle's corner. */
  .clip.on.strict { filter: drop-shadow(0 0 0 #fff) drop-shadow(0 0 2px #fff); }
```

Note: the existing `.hist` rule already sets other properties — add `position: relative;` to it rather than creating a duplicate selector. Keep the existing `height/border-radius/background/padding/margin-bottom`.

- [ ] **Step 4: Pass the store to the Viewport in Develop**

In `app/src/lib/tabs/Develop.svelte`, add to the script imports (near the other `../store` imports):

```ts
  import { clipWarn } from "../store";
```

Then on the `<Viewport ...>` element (line 354), add three attributes (e.g. after `pointPick={pickTarget !== ""}`):

```svelte
                  clipHigh={$clipWarn.high} clipLow={$clipWarn.low} clipStrict={$clipWarn.strict}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd app && npm run check`
Expected: No new errors in `Histogram.svelte` or `Develop.svelte`.

- [ ] **Step 6: Run the full unit suite**

Run: `cd app && npm run test:unit`
Expected: All tests pass (including `clip.test.ts` from Task 1).

- [ ] **Step 7: Manual verification (run the app)**

Run the app (`cd app && npm run tauri dev`), open a developed image in Develop, then:
- Click the top-right (red) triangle → blown-out highlights paint red; click again → off.
- Click the top-left (blue) triangle → crushed shadows paint blue; click again → off.
- Right-click either triangle (strict 253/2) → noticeably more pixels flagged; the active triangle shows the strict cue.
- Export the image (or open the export modal preview) → exported output has NO red/blue overlay (export path is unaffected).
- Zoom in/out → the overlay stays pixel-accurate at every zoom level.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/viewport/Histogram.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(histogram): clipping-warning corner toggles + Develop wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** store (T2), helper (T1), shader (T3), renderer (T4), viewport props/finishKey (T5), histogram triangles + right-click strict (T7), Develop wiring (T7), i18n (T6), export safety (T4 default-off + T7 manual check), GPU-only scope (no fallback UI, as specified). All spec sections map to a task.
- **Type consistency:** `ClipUniforms { high, low, lowOn }` defined in T1, imported in T4/T5; uniform names `u_clip_high/u_clip_low/u_clip_low_on` consistent across T3 (declare/use), T4 (locations/set). Store shape `{ high, low, strict }` consistent across T2, T5, T7.
- **Raw-view note:** Per spec, the overlay is allowed to apply in raw view (no `!u_raw` gate). `applyClip` lives in the finishing FRAG `main()`, which runs for all finishing output; acceptable as a debug affordance.
