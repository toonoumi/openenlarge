# Roll-Base Anchor Design

**Status:** Approved design — ready for implementation plan. Written 2026-06-21.

**Goal:** Replace per-image film-base sampling (the source of the "super-pink"
instability) with a single, robust **roll base** computed automatically across
each roll, applied to every frame's inversion and WB seed, with a manual
recalibrate whose scope follows the active view.

**Sub-project context:** This is sub-project **A** of the WB/film-stock work.
Sub-project B (per-stock color matrix `m_post`) and C (ML-WB spike) are separate
spec→plan cycles and are out of scope here. See
`docs/superpowers/specs/2026-06-20-ml-wb-spike-plan.md` for C.

---

## Problem

Today every frame samples its own film base independently at develop time
(`develop_compute` → `auto_base`, `commands.rs:653`). The rebate detector is
robust but not perfect: on a minority of frames (no clear border, a bright scene
cluster that out-scores a dim rebate) it picks a wrong, non-orange base, and that
frame inverts pink. Because the base is per-image, the whole roll wobbles and the
bad frames stand out as "super-pink."

A film roll shares one physical base. Sampling it **once per roll** — robustly,
across all frames — and using that for the whole roll removes the per-frame
wobble: the few bad readings are outvoted instead of shown.

## Existing infrastructure we reuse

- **`folderBaseByPath`** store + `folder_base:{dir}` app_state persistence
  (`store.ts:72`, `catalog.ts:118`). Per-folder base default, today opt-in.
- **`withEffectiveBase(params, dir)`** (`develop/base.ts`): precedence
  per-image override → folder base → `null` (backend auto fallback). Reused
  unchanged — it already gives us the layering we want.
- **`setFolderBase` / `clearFolderBase`** (`develop/base.ts`).
- **Per-frame base + confidence are already computed and stored** on each
  `Developed` (`dev.base`, `dev.base_confidence`; `commands.rs:632-633,721-722`)
  and via `auto_base` (`commands.rs:294`, returns `(base, confidence)` against
  `REBATE_CONFIDENCE`). The aggregate reads these — no re-decoding.
- **Manual rebate picker** (Frame): Basic › Film Base swatch arms `baseSampling`,
  drag-samples on the viewport → `sampledBase` → `applyBaseThisImage()`
  (`Basic.svelte:80,108-114`).
- **Roll reference-edit viewport** (`refId`, `refFrameParams`,
  `analyzeWhitePoint` on `refId`; `Roll.svelte`) — host for the Roll-scope picker.

## Architecture & data flow

### New backend command: `roll_base`

```
roll_base(ids: Vec<String>) -> Option<RollBase>
struct RollBase { base: [f32; 3], frames_used: u32 }
```

- For each resident, developed id, read the stored `dev.base` and
  `dev.base_confidence`.
- Keep only frames clearing `REBATE_CONFIDENCE`.
- Return the **per-channel median** of the kept bases (robust to outliers), with
  `frames_used` = count kept.
- Return `None` if zero frames clear the threshold (rebate-less roll).
- Pure aggregation of already-stored values: no decode, no re-sample.
- Per-image override frames are **included** in the sample (their `dev.base` is a
  genuine rebate reading independent of the override).

### `developAll` becomes two-phase

Today `developAll` interleaves develop + WB/exposure seed + bake per frame
(`workflow.ts:160-198`). The roll base needs every frame sampled first, so:

1. **Phase 1 — develop all:** develop each frame (decode + sample base, as today),
   but do **not** run the WB/exposure seed or the thumbnail re-bake yet.
2. **Compute + set roll base:** `roll_base(ids)` → if `Some`,
   `setFolderBase(dir, base)`. If `None`, leave the folder base unset (per-image
   auto fallback, today's behavior).
3. **Phase 2 — seed all:** run the existing per-frame seed loop (WB seed at the
   final exposure per the 2026-06-21 freeze fix, exposure seed, thumbnail bake).
   Because `withEffectiveBase` already prefers the folder base, every frame seeds
   and bakes against the roll base with **no new wiring** in the seed path.

Per-image overrides still win throughout (override → roll base → auto).

## Manual recalibrate (scope follows the view)

- **Frame view (unchanged):** Basic › Film Base swatch → drag-sample rebate →
  `applyBaseThisImage()` sets that frame's `base_override`. One image only.
- **Roll view:** recalibrate arms the rebate picker on Roll's existing reference
  frame. The pick calls `setFolderBase(dir, base)` and re-seeds the roll —
  re-WB + re-bake every **protected-free** frame (the Phase-2 path). Clearing the
  roll base reverts to the auto-aggregate (recompute `roll_base`).

**Protected frames** (preserved, never re-seeded by a roll-base change): any
frame with a per-image `base_override` **or** a manual WB (`wb_manual === true`,
a deliberate gray-point pick). All other frames are re-seeded.

Precedence (all already modeled by `withEffectiveBase`):
**per-image override → roll base (auto or manually set) → backend per-image auto.**

## Migration (self-healing, no version flag)

The trigger is **absence of a stored `folder_base:{dir}`**:

- New imports set it in `developAll` (above).
- Opening an existing developed roll with no folder base computes `roll_base(ids)`
  once, `setFolderBase`, and re-seeds/re-bakes the **protected-free** frames; the
  result is persisted, so it never recomputes.
- Folders with a manually-set folder base, and protected frames (per-image
  `base_override` or `wb_manual`), are skipped/preserved.

This auto-fixes current pink rolls on first open and respects the
"frozen after develop" north-star as a deliberate one-time pass (precedent:
prior `ENGINE_VERSION` re-bakes).

## Edge cases

- **Rebate-less roll:** `roll_base` → `None` → no folder base → per-image auto
  fallback. No regression.
- **Single-frame folder:** median of one = that frame's base.
- **Frames added to an existing roll:** folder base already set → new frames
  adopt it via `withEffectiveBase`; no silent recompute. Manual Roll recalibrate
  refreshes it.
- **Known limitation:** folder = roll. A folder mixing two stocks gets a
  compromise base — fix by splitting folders or manual recalibrate. Not
  engineered around (YAGNI).

## Parity

The base is a uniform fed identically to the CPU (`invert_image`) and GPU
(`resolve_to_uniforms`) engines — no shader change. CPU/GPU parity preserved.

## Testing

- **Rust unit tests** for `roll_base`:
  - confidence filtering (sub-threshold frames dropped),
  - per-channel median,
  - `None` on zero confident frames,
  - single-frame folder,
  - **outlier rejection:** one pink-outlier frame does not move the median.
- **`film-bench`** stays green (single-frame roll → base unchanged → no ΔE
  regression).
- **Frontend:**
  - `developAll` two-phase ordering (roll base set before the seed loop runs),
  - migration triggers when `folder_base:{dir}` is absent and skips when present.
- **GUI smoke:** import a roll with a known pink frame (gone); Roll recalibrate
  (whole roll); Frame recalibrate (one image); open an existing roll (one-time
  migration fires once).

## Out of scope

- Per-stock color matrix `m_post` (sub-project B).
- ML-WB estimator (sub-project C).
- Any change to the inversion engine math, the WB estimator (`auto_wb_gains`), or
  the freeze fix beyond feeding it the roll base.
