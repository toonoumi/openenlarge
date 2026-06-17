# AI Dust Removal → Live, Undoable Main-Display Toggle

**Date:** 2026-06-16
**Status:** Approved (design); pending implementation plan

## Problem

The "AI dust removal" button currently runs a separate path: `autodust_detect`
returns a standalone **preview image** and stashes a full-res healed image in
`session.pending_upscale` for a dedicated **Save/export** button. The result
never reaches the main develop viewport and is not part of the undo history.

We want the AI dust button to behave like the existing **IR removal** control:
clicking it applies the heal to the **main display**, the sensitivity slider
adjusts it live, and **Cmd+Z** reverts it. The standalone preview image and the
export button are removed.

## Goals

- Clicking **AI dust removal** toggles auto-dust on/off; the heal shows on the
  main viewport (no separate preview image).
- The sensitivity slider adjusts the heal live (commit on pointer-release).
- The state is per-image and fully undoable/redoable via Cmd+Z.
- Remove the preview `<img>`, pixel-count line, and the **Save** (export) button
  from `AutoDustPanel.svelte`.

## Non-goals

- No change to the manual brush-stroke eraser or the IR-removal control.
- No change to the upscaler, which keeps using `pending_upscale` /
  `save_upscaled`.
- No attempt to make CPU inference fast; live sensitivity dragging is not a goal
  (slider still commits on release).
- No GPU/DirectML work (Windows runs ONNX on CPU, per the prior fix).

## Key insight

The detector's defect mask is **independent of tone/color** — a dust speck is at
the same pixel regardless of the develop curve. The detector probability map is
already cached per `(id, dims)` in `session.autodust_prob`. So the heal can be
computed at the **bake** stage (geometry + dust heal on the working image),
which is already separate from the GPU tone/color finish and only re-runs when
dust state changes (`dustRev`) — not on every tone tweak. This mirrors how the
existing brush MI-GAN heal already works.

## Design

### Data model (`app/src/lib/develop/dust.ts`)

Reuse the **existing** `autoDust: { enabled: boolean; sensitivity: number }` on
`DustEdits` — no new fields. Helpers already exist
(`setAutoDustEnabled`, `setAutoDustSensitivity`). Undo already snapshots the
whole `DustEdits` (`history.ts` `EditSnapshot.dust`), so enabling auto-dust or
moving the slider is captured with no undo changes.

Toggling `autoDust.enabled` or changing `autoDust.sensitivity` must bump
`dustRev` so the viewport re-renders and `commitActive()` snapshots the change.

### Render / bake integration (Rust)

The bake/render spec gains an auto-dust descriptor, e.g.
`auto_dust: { enabled: bool, sensitivity: f32 }`, threaded through:

- `working_baked_pixels` / `BakeSpec` and `bake_for_view`
  (`app/src-tauri/src/commands.rs`, GPU path).
- `render_view` / `ViewSpec` (CPU fallback path).

When `auto_dust.enabled`:

1. Ensure the detector probability map for `(id, dims)` is available — reuse the
   `session.autodust_prob` cache; run `autodust::engine::detect` once on a
   finished full-res positive if not cached (same as today).
2. Threshold the prob map at `sensitivity` via
   `film_core::dust::prob_defect_mask` (with the existing area-scaled
   `MAX_BLOB`) to get a defect mask.
3. **Union** that defect mask with the manual brush-stroke mask, and run the
   existing MI-GAN bake heal over the combined mask (the same heal the brush
   path uses). Manual strokes and auto-detected defects heal together.

This requires no new inference path — it reuses `autodust::engine` (detector +
MI-GAN) and the bake-stage heal. The heal only re-runs when `dustRev` changes
(auto-dust toggle, sensitivity, or strokes), not on tone/color edits.

Requires the AI models to be installed; when not installed, `auto_dust.enabled`
is a no-op in the render (the panel still gates on install state).

### Frontend (`app/src/lib/develop/AutoDustPanel.svelte` + `Develop.svelte`)

- Replace the "Detect" button with a **toggle** labelled "AI dust removal",
  shown active when `autoDust.enabled`. On click, emit an event that
  `Develop.svelte` handles with `setAutoDustEnabled` + `dustRev` bump.
- Keep the install/download gate and the sensitivity slider; the slider emits
  `autoDust.sensitivity` (commit on `change`, as today) and re-renders live.
- **Remove:** the `result` preview `<img>`, the pixel-count line, the **Save**
  button, the `saveResult()` function, and the `save` / `ExportFormat` imports.
- `Develop.svelte` passes `autoDust` (enabled + sensitivity) to the panel and
  wires the toggle/sensitivity events into `dustById` (it already passes
  `dust.autoDust.sensitivity`).

### Cleanup

- Remove the `autodust_detect` command (`commands.rs`) and its `api.ts` wrapper
  (`autodustDetect`) — detection now happens inside the bake.
- Stop the autodust flow from writing `session.pending_upscale`. **Keep**
  `pending_upscale` and `save_upscaled` — the upscaler still uses them
  (`upscale_image` stashes, `save_upscaled` saves).
- Keep `autodust_status` / `download_autodust` and the `autodust_prob` cache.

### Undo / redo

No changes required. `autoDust.enabled` and `autoDust.sensitivity` are part of
`DustEdits`, which `EditSnapshot` already captures; the existing
pointerup/click/change → `commitActive()` batching snapshots the new state, and
Cmd+Z/redo apply prior snapshots and bump `dustRev`.

## Data flow (after change)

1. User clicks **AI dust removal** → `setAutoDustEnabled(true)` → `dustById`
   updated → `dustRev` bumped.
2. Viewport re-bakes: bake spec carries `auto_dust { enabled, sensitivity }`.
3. Bake: detector prob map (cached) → mask at sensitivity → union with stroke
   mask → MI-GAN heal on working image → GPU invert + finish (tone/color).
4. Main viewport shows the healed, finished image.
5. `commitActive()` snapshots the new `DustEdits`; **Cmd+Z** restores the prior
   snapshot (auto-dust off) and re-renders.

## Testing

- **Rust unit:** `prob_defect_mask` thresholding + mask-union logic (defect mask
  ∪ stroke mask) produce expected healed-pixel sets; existing
  `autodust::engine` tests stay green.
- **Rust:** bake path with `auto_dust.enabled` and no installed models is a
  no-op (doesn't error).
- **Frontend/manual:** toggling AI dust updates the viewport; sensitivity slider
  changes the heal on release; Cmd+Z reverts the toggle and the slider step;
  the preview image and Save button are gone. Verify on macOS (CoreML) and on
  Windows (CPU) per the prior DirectML fix.
- **Regression:** upscaler Save/export still works (`pending_upscale` intact).

## Risks

- **CPU latency on Windows:** detector (~150 MB U-Net) + MI-GAN per toggle /
  sensitivity-release is a couple seconds. Acceptable; slider commits on release
  only. Show the existing busy/spinner state during bake.
- **Mask union correctness:** auto and manual masks must align in the same image
  space before healing; covered by unit tests.
