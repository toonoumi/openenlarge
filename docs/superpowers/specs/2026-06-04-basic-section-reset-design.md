# Basic Section Reset Button

## Goal

Add a "Reset" button to the right edge of the **Basic** section header in the
develop/edit panel. Clicking it restores every Basic-section control to its
default, leaving all other develop state untouched.

## Scope

A single self-contained change in `app/src/lib/develop/Basic.svelte`. No store,
API, type, or backend changes.

The Basic panel only renders when `$tool === "edit"` (see
`app/src/lib/tabs/Develop.svelte`), so the button is naturally scoped to editing
mode.

## Behavior

Reset acts on the **active image only**, like every other edit. It restores:

- Film Profile (`stock`) → `none`
- Exposure, Contrast, Highlights, Shadows, Whites, Blacks → `0`
- Texture, Vibrance, Saturation → `0`
- Temp / Tint → **re-seeded to the as-shot white point** (identical to pressing
  the existing **Auto** button), not the hard 5500/0 slider defaults.

Values come from `defaultParams()` so the reset never drifts from the canonical
defaults. The fields are applied via `params.update(...)`, then the existing
`autoWb()` helper re-seeds Temp/Tint.

Fields **explicitly preserved** (everything outside Basic): `mode`, `base_rect`,
`black`, `gamma`, `auto_wb`, all tone-curve fields (`tc_*`), and all color-grading
fields (`cg_*`).

## Layout

The header is currently a single `<button>` that toggles the section open/closed.
Buttons can't nest, so the row becomes a flex container with two siblings:

- Left: the existing chevron + "Basic" label toggle (stays a `<button>`).
- Right: the new "Reset" button.

The Reset button reuses the visual style of the existing `.auto` button (small,
bordered, dim text). Clicking Reset must not toggle the section open/closed.

## Edge case

If the active image isn't developed yet, `autoWb()`'s seed call fails silently
(current behavior) and Temp/Tint stay as they are; all other Basic fields still
reset. This matches how the Auto button already behaves.

## Testing

Manual verification in the running app:
1. Adjust several Basic sliders + film profile, click Reset → all return to
   default, Temp/Tint snap to the as-shot point.
2. Adjust a tone-curve / color-grading control, click Reset → those remain
   unchanged.
3. Clicking Reset does not expand/collapse the section.
