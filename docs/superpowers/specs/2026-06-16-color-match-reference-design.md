# Match Reference — local color-toning match

**Date:** 2026-06-16
**Status:** Approved (design)
**Area:** AI section (Develop tab), `enhance` tool panel

## Summary

Add a **Match Reference** feature in the AI section, beneath the existing
**Enhance** button. The user imports a reference image from disk; a fully-local
Rust routine analyzes the reference's color toning and the current image, then
returns develop-param values that make the current image's toning match the
reference. The result is applied to the active image's `params` store as a
**single, non-destructive, undoable change**.

No network, no LLM, no API key. The existing Enhance feature (OpenAI) is left
untouched.

## Decisions (locked)

- **Output:** adjust the app's own develop params (non-destructive, editable),
  not a pixel-baked image.
- **Engine:** fully local in Rust. No OpenAI / LLM involvement.
- **Reference source:** a file from disk (file dialog).
- **Match scope (full):** the optimizer may move `temp`, `tint`, `exposure`,
  `contrast`, `saturation`, and the color-grading shadow/highlight wheels
  (`cg_sh_hue/sat/lum`, `cg_hi_hue/sat/lum`).
- **Strength slider:** kept (0–100%, default 100%); blends matched params toward
  the originals.
- **Revert:** plain Ctrl+Z, and it must restore **in one go** — the match is
  applied as exactly one `params.update(...)` + one `commitActive()`, producing a
  single history entry.

## UX

New `.section` in `AiEnhancePanel.svelte`, placed after the Enhance button block
(and before the existing `.hint`), styled with the panel's existing classes:

- **Import reference image** button → `open()` from `@tauri-apps/plugin-dialog`
  with image filters (`jpg, jpeg, png, tif, tiff, webp`). Stores the chosen path.
- Once chosen: show the **filename** and a small **reference thumbnail**
  (a `convertFileSrc(path)` `<img>`), plus a **Match toning** button.
- **Strength** slider (0–100, default 100) shown once a reference is chosen.
- **Match toning** button: busy/spinner styling identical to Enhance
  (`class:busy`, `.spinner`). Disabled while busy or when no reference chosen.
- On click → call the Rust command, then apply returned params (see below).
- Error line (`.err`) and hint text reuse existing styles.

No before/after image toggle here — the change *is* the live develop result, and
undo provides the "before".

### Apply logic (single undo step)

```ts
const matched = await api.colorMatchParams(id, currentParams, refPath, strength);
params.update((p) => ({ ...p, ...matched })); // one atomic update
commitActive();                                // one history entry
```

`matched` is a partial `InvertParams` containing only the scoped keys. Strength
blending is applied **inside Rust** (so the returned params are already blended);
the frontend just merges and commits once.

## Algorithm (Rust: new `app/src-tauri/src/color_match.rs`)

### Reference target stats

1. Decode the reference file via the `image` crate; downscale to a small working
   size (e.g. max 256px long edge) for speed.
2. Convert sRGB → linear → **CIELAB**.
3. Partition pixels into **shadows / midtones / highlights** by `L*`
   (e.g. thresholds at ~33% / ~66% of the L range, or fixed L cuts).
4. Compute per-region **mean L, mean a, mean b**; global **L std-dev**
   (contrast proxy) and **mean chroma** `sqrt(a²+b²)` (saturation proxy).

### Match (bounded coordinate descent)

Evaluation function: render the *current* image to a tiny preview (~200px long
edge) by reusing the existing develop path —
`invert_image(&scaled, &resolved_params, mode)` with a small `out_w/out_h` — then
compute the same Lab region stats on the result.

- **Loss** = weighted sum of squared differences between current and reference
  region stats (region means dominate; contrast and chroma weighted lower).
- **Seed analytically** first: global a/b cast → `temp`/`tint`; overall mean L gap
  → `exposure`; L-std ratio → `contrast`; chroma ratio → `saturation`;
  shadow/highlight a·b offsets → `cg_sh_*` / `cg_hi_*` hue/sat/lum.
- **Refine** by coordinate descent: for each scoped param, step within its valid
  range to reduce loss; shrink step size on no-improvement. Cap total evaluations
  (~40); each eval is a sub-millisecond 200px render.
- Apply **strength**: linearly interpolate each final param between the original
  value and the optimized value by `strength/100`.

Param ranges (from `InvertParams`): `temp` Kelvin, `tint` −150..150, `exposure`
−5..5 EV, `contrast`/`saturation` slider ranges, `cg_*_hue` 0..360,
`cg_*_sat` 0..100, `cg_*_lum` −100..100.

### Returned value

A struct serialized to a partial `InvertParams` JSON object containing only the
scoped keys, already strength-blended.

## Wiring

- **Tauri command** in `commands.rs`:
  `color_match_params(id: String, params: InvertParams, ref_path: String, strength: u8, session: State<Session>) -> Result<MatchedParams, String>`
  → delegates to `color_match::match_to_reference(...)`. Registered in the
  `invoke_handler` list.
- **`api.ts`** binding:
  `colorMatchParams: (id, params, refPath, strength) => invoke("color_match_params", { id, params, refPath, strength })`.
- **i18n:** add keys under `colorMatch.*` to `/i18n-strings.csv`
  (`colorMatch.import`, `colorMatch.match`, `colorMatch.matching`,
  `colorMatch.strength`, `colorMatch.noRef`, `colorMatch.error`,
  `colorMatch.hint`), then run `python3 scripts/gen-i18n.py`. Never edit
  `dict.ts` directly.

## Error handling

- No reference chosen → disabled button (no error path needed) or
  `colorMatch.noRef`.
- Reference fails to decode / unsupported → return `Err` with a readable message;
  surfaced in `.err`.
- Image not developed / unknown id → existing `ensure_resident` / "not developed"
  errors propagate to the `.err` line.
- Optimizer never worsens the seed: keep the best-loss param set seen.

## Testing

- **Rust unit tests** (in `color_match.rs`):
  - Region stats on a synthetic solid-color buffer match expected Lab values.
  - Identity: reference stats == current stats → optimized params ≈ originals
    (no meaningful change).
  - Directional: a reference that is clearly warmer than the current image pushes
    `temp` warmer (and loss strictly decreases from seed to result).
  - Strength=0 returns the original params exactly; strength=100 returns the full
    optimized set.
- **Frontend test** (mirroring `perImage.test.ts`): applying a returned partial
  params object via `params.update` merges the scoped keys and leaves others
  intact; a single `commitActive()` yields exactly one undo step.

## Out of scope (YAGNI)

- In-catalog reference picking (disk file only for now).
- Per-region UI controls / manual override of which params move.
- Pixel-baked output or before/after image toggle.
- Any LLM / network call.
