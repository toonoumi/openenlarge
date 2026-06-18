# Highlight & Shadow Clipping Warning (高光/暗部裁切提醒)

**Date:** 2026-06-17
**Status:** Design approved, pending spec review

## Problem

When editing, regions can blow out to pure white (highlight clipping) or crush to
pure black (shadow clipping), losing all detail irrecoverably. Users need a live,
on-screen warning showing exactly which pixels are clipping so they can pull
exposure/tone back before detail is lost.

User request (paraphrased): "Add a highlight and shadow clipping warning — flag the
parts where highlights exceed 253 or 255."

## Goal

A toggleable overlay in the Develop viewport that paints:

- **Highlight clipping** → red, where any channel ≥ the high threshold.
- **Shadow clipping** → blue, where any channel ≤ the low threshold.

Toggled from the histogram corners. Per-channel ("any channel clips"). Threshold
defaults to pure clip (255 / 0); a stricter near-clip mode (253 / 2) is available
per-corner via right-click.

## Non-Goals

- No effect on export. This is a screen-only editing aid; it must never bake into
  output pixels.
- No CPU-fallback rendering. The overlay is GPU-only (see Scope/Limits).
- No adjustable numeric threshold slider — two fixed modes only (255 and 253).

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Toggle UI | Histogram corner triangles (Lightroom-style): top-left = shadow, top-right = highlight |
| Threshold | Two fixed modes, default 255 (pure); 253 strict mode opt-in |
| Strict toggle | Right-click (or long-press) a histogram triangle switches that side between 255 and 253 |
| Channel rule | Any channel clips (per-channel `||`) |
| Colors | Highlight = red `(1.0, 0.15, 0.15)`; shadow = blue `(0.2, 0.45, 1.0)` |
| Render location | Finishing fragment shader `main()`, GPU only |

## Architecture

The display color is computed in the finishing fragment shader's `main()`
(`app/src/lib/viewport/gl/shaders.ts`), where the final 0–1 sRGB color `c` is
produced just before output. Injecting the clipping check there means it is:

- Free (one branch per pixel, no extra passes),
- Correct at every zoom level (operates on the displayed color),
- Live (re-draws on any edit, since it shares the finishing pass).

State is shared between the histogram toggles and the viewport via a small Svelte
store, mirroring the existing `previewSrc` pattern.

```
clipWarn store (store.ts)
   │
   ├──> Histogram.svelte  — corner triangles read state + toggle it
   │
   └──> Develop.svelte    — reads $clipWarn, passes props to <Viewport>
            │
            └──> Viewport.svelte — converts to uniform values, calls renderer.setClip(),
                     includes clip state in finishKey so a toggle forces drawGL()
                        │
                        └──> renderer.ts — setClip() + uniform locations
                                 │
                                 └──> shaders.ts FRAG main() — paints the overlay
```

## Components

### 1. Store — `app/src/lib/store.ts`

```ts
export const clipWarn = writable<{ high: boolean; low: boolean; strict: boolean }>(
  { high: false, low: false, strict: false }
);
```

- `high` — highlight (red) warning on/off.
- `low` — shadow (blue) warning on/off.
- `strict` — when true, thresholds tighten to 253/2 instead of 255/0. A single
  `strict` flag applies to whichever warnings are on (simpler than per-side strict;
  right-clicking either triangle toggles the shared `strict`).

Default all-off so the feature is opt-in and never surprises the user.

### 2. Threshold helper — `app/src/lib/viewport/gl/clip.ts` (new)

A pure function mapping store state → uniform values, unit-testable in isolation:

```ts
export interface ClipUniforms {
  high: number;   // 0 = off; else high threshold in 0..1 (e.g. 1.0 or 253/255)
  low: number;    // low threshold in 0..1 (e.g. 0.0 or 2/255)
  lowOn: number;  // 0 or 1 — shadow warning enabled
}

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

Note `high: 0` doubles as the "highlight off" sentinel — a real threshold is always
> 0, so the shader treats `u_clip_high <= 0.0` as disabled.

### 3. Shader — `app/src/lib/viewport/gl/shaders.ts` (FRAG)

Add uniforms near the other finishing uniforms:

```glsl
uniform float u_clip_high;   // 0 = off; else threshold 0..1
uniform float u_clip_low;    // shadow threshold 0..1
uniform float u_clip_low_on; // 0 or 1
```

In `main()`, after the final `c` is computed (both the texture-on and texture-off
branches) and before `o = vec4(...)`, route through a helper so both output paths
get it:

```glsl
vec3 applyClip(vec3 c) {
  if (u_clip_high > 0.0 && (c.r >= u_clip_high || c.g >= u_clip_high || c.b >= u_clip_high))
    return vec3(1.0, 0.15, 0.15);        // highlight clip → red
  if (u_clip_low_on > 0.5 && (c.r <= u_clip_low || c.g <= u_clip_low || c.b <= u_clip_low))
    return vec3(0.2, 0.45, 1.0);         // shadow clip → blue
  return c;
}
```

`main()` calls `c = applyClip(c)` immediately before writing `o`. The texture
(unsharp) branch applies it to the final sharpened color, so the overlay reflects
what the user actually sees.

### 4. Renderer — `app/src/lib/viewport/gl/renderer.ts`

Mirror the existing uniform plumbing:

- Add `"u_clip_high", "u_clip_low", "u_clip_low_on"` to the finishing-program
  uniform-location lookups in the constructor.
- Add `private clip: ClipUniforms | null = null;` and
  `setClip(c: ClipUniforms) { this.clip = c; }`.
- In `drawFinishPass()`, set the three uniforms (default to off when `this.clip`
  is null, so export and any non-clip caller render normally).

**Export safety:** `renderExport()` never calls `setClip()`, and the uniforms
default to off, so exported pixels are unaffected. Confirm by leaving `this.clip`
untouched in the export path (it sets its own finishing uniforms but not clip).

### 5. Viewport — `app/src/lib/viewport/Viewport.svelte`

- Add props: `export let clipHigh = false; export let clipLow = false; export let clipStrict = false;`
- Derive `clipUniforms({ high: clipHigh, low: clipLow, strict: clipStrict })` and
  call `renderer.setClip(...)` inside `drawGL()`.
- Add the three booleans to `finishKey` so toggling re-runs `drawGL()` (finishing-
  only change, no backend fetch).

### 6. Histogram — `app/src/lib/viewport/Histogram.svelte`

Add two corner triangle buttons over the existing SVG:

- Top-left triangle → toggles `clipWarn.low` on left-click; right-click toggles
  `clipWarn.strict`.
- Top-right triangle → toggles `clipWarn.high` on left-click; right-click toggles
  `clipWarn.strict`.
- Lit (e.g. white/bright) when that warning is active; dimmed when off. A subtle
  visual cue (e.g. a small dot or "253" micro-label) indicates strict mode is on.
- `on:contextmenu|preventDefault` for the right-click strict toggle.

The triangles are small (~10px), positioned absolutely in the histogram's top
corners, and do not obstruct the histogram curves.

### 7. Develop — `app/src/lib/tabs/Develop.svelte`

- `import { clipWarn } from "../store";`
- Pass to `<Viewport>`: `clipHigh={$clipWarn.high} clipLow={$clipWarn.low} clipStrict={$clipWarn.strict}`.

### 8. i18n — tooltips

Add tooltip strings (e.g. `histogram.clipHigh`, `histogram.clipLow`,
`histogram.clipStrictHint`) via `i18n-strings.csv` + `scripts/gen-i18n.py`. Never
edit `dict.ts` directly (regen wipes hand-added keys).

## Scope / Limits

- **GPU path only.** The CPU `<img>` fallback (no WebGL2, or raw view) does not show
  the overlay. Interactive develop is virtually always on the GPU path, so this is
  acceptable. No warning UI is shown for the fallback case; the triangles still
  toggle state harmlessly.
- **Raw view.** In raw mode the finishing shader still runs the final output path,
  so clipping would apply to the raw-encoded color. Acceptable — raw view is a
  developer/debug affordance. (If undesired, gate `applyClip` on `!u_raw` — decide
  during implementation; default is to allow it.)
- Strict mode is a single shared flag, not per-side. Right-clicking either triangle
  toggles it for both warnings.

## Testing

- **Unit:** `clipUniforms()` — off state, high-only, low-only, strict thresholds
  (253/255, 2/255). New `clip.test.ts`.
- **Unit:** `clipWarn` store default is all-off; toggle helpers flip the right field.
- **Visual / manual (run the app):** load a developed image, toggle each triangle,
  confirm red/blue overlay on a known clipped region, confirm right-click switches
  to 253 (more pixels flagged), confirm export output is unaffected.

## Files Touched

| File | Change |
| --- | --- |
| `app/src/lib/store.ts` | New `clipWarn` store |
| `app/src/lib/viewport/gl/clip.ts` | New — `clipUniforms()` helper |
| `app/src/lib/viewport/gl/clip.test.ts` | New — helper unit tests |
| `app/src/lib/viewport/gl/shaders.ts` | `applyClip()` + uniforms in FRAG |
| `app/src/lib/viewport/gl/renderer.ts` | `setClip()` + uniform locations + drawFinishPass |
| `app/src/lib/viewport/Viewport.svelte` | Props + `setClip` in drawGL + finishKey |
| `app/src/lib/viewport/Histogram.svelte` | Corner triangle toggles |
| `app/src/lib/tabs/Develop.svelte` | Pass clip props to Viewport |
| `i18n-strings.csv` (+ regen) | Tooltip strings |
