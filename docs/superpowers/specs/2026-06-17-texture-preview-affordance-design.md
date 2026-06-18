# Texture-preview affordance ("View at 100%") — design

Status: approved design. **Implementation deferred** until the held 0.4.1 release ships
and the concurrent session's in-flight edits land (avoid clobbering shared files —
`Basic.svelte` / `Develop.svelte` / `Viewport.svelte` may be touched there).
Date: 2026-06-17.

## Problem

The Texture slider is a 3×3-texel unsharp mask in the GPU finish shader
(`app/src/lib/viewport/gl/shaders.ts:188-200`). Its spatial frequency is tied to the
resolution of the bound texture. At fit view that's the 2560 proxy, so the previewed
effect targets coarser frequencies than the full-res export — and the fine grain it
should sharpen was already averaged away by the proxy downscale. Worse, at fit the
display itself lacks the pixels to show fine sharpening (below screen Nyquist). So the
fit preview of Texture does not match the exported result. (This is why Lightroom et al.
only let you judge sharpening/texture at 1:1.)

Spec 1's hires-on-zoom already makes the **zoomed** preview accurate: past the zoom
threshold the GPU binds the ≤8192 high-res texture and the unsharp runs on near-native
texels. The only gap is fit view.

## Goal

Give the user a one-tap path from the Texture control to a 1:1 view, where the effect
renders truthfully — without changing the proxy/render pipeline. Performance is
preserved (fit stays on the proxy; the high-res decode is paid only on demand, when the
user opts to inspect).

## Non-goals

- A resolution-scaled unsharp radius to "fake" the effect at fit (rejected — it shows a
  coarse texture that isn't what exports, and can't reveal grain the display can't render).
- A dedicated 1:1 detail-loupe inset (a possible richer follow-up; out of scope here).
- Applying to controls other than Texture (it's the only resolution-dependent control;
  the same channel serves a future Sharpen/Clarity/Noise control).

## Design

Four small, self-contained touches; nothing in the proxy/render pipeline changes.

### 1. `Viewport.svelte` — `zoomTo100()`
Add a public instance method mirroring the existing `resetZoom()` (`:420`):
```ts
export function zoomTo100() {
  startAnim();
  scale = 1.0;
  cx = imgW / 2;
  cy = imgH / 2;
}
```
`scale = 1.0` = 1 image px : 1 device px (matches the tap-to-zoom-in path, `:577-578`).
The existing `hiTier` reactive sees the raised `eff` and loads the high-res texture, so
the unsharp renders on near-native pixels. No other Viewport change.

### 2. `Develop.svelte` — wire the channel
`Develop` already holds the Viewport instance as `vp` (`:252`) and calls `vp?.resetZoom()`
(`:407`). Pass a callback into `<Basic>`:
```svelte
<Basic ... onViewActual={() => vp?.zoomTo100()} />
```

### 3. `Basic.svelte` — the affordance
- Add `export let onViewActual: (() => void) | null = null;` (mirrors the existing
  `onWbPick` prop pattern, `:19`).
- By the Texture slider (`:260`), render a small **"100%"** button + a `HelpDot`
  (`app/src/lib/develop/HelpDot.svelte`, already used in this panel) with copy:
  *"Texture is a fine-detail effect — preview it at 100%."* Button click → `onViewActual?.()`.
- Persistent (always shown with the Texture row); not gated on zoom-state or texture
  value — avoids plumbing the Viewport's `zoomed` state up to `Basic` for marginal gain.

### 4. i18n
Add two keys via the CSV pipeline (`i18n-strings.csv` + `python3 scripts/gen-i18n.py`;
never edit `dict.ts` directly): `basic.textureViewActual` (button, e.g. "100%") and
`basic.textureHint` (HelpDot text). EN + ZH columns.

## Data flow
Texture "100%" button (Basic) → `onViewActual()` → `Develop` → `vp.zoomTo100()` →
`scale = 1.0` → `hiTier` reactive → high-res upload → unsharp on near-native texels →
truthful Texture preview.

## Edge cases
- **Source ≤ 2560:** there's no higher-res tier; the proxy already *is* the source, so
  Texture is already accurate. `zoomTo100()` still just zooms in (harmless).
- **Already zoomed:** clicking re-centers at 100% (mildly redundant, never wrong).
- **Non-interactive/raw/no-WebGL2 viewports:** `zoomTo100` only affects the interactive
  develop canvas; the button lives in the Develop Basic panel, which only renders there.

## Testing
- `npm run check` (svelte-check) clean; existing tests stay green.
- Manual: open a >2560px image at fit, set Texture, click "100%" → viewport snaps to 1:1
  and the texture visibly sharpens (high-res). On a ≤2560px source it simply zooms in.
- No new pure logic worth a unit test (`zoomTo100` is a 3-line setter).
