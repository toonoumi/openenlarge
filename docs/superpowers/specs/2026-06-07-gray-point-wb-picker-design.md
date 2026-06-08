# Gray-point white-balance picker — design

**Date:** 2026-06-07
**Status:** approved design, pre-implementation
**Context:** deferred item from `2026-06-07-negadoctor-inversion-design.md` ("manual gray-point
picker"); both NegBase and Filmomat ship one. Builds on the existing `pointpick` infrastructure.

## Goal

Let the user tap a neutral/gray area of the image to set white balance, so that point renders
neutral. "Click → it's gray," in one click, in whatever inversion mode is active.

## UX

A pipette button beside the existing **Auto** button under White Balance in `Basic.svelte`.
Tap → crosshair cursor (the existing `pointPick` state) → click a neutral area → Temp/Tint
update so that point is neutral, recorded in history like Auto. Tap again / Esc cancels.

## Pick routing (structural change)

`Develop.svelte` currently has a single `pointPicking: boolean` whose pick is hardwired to feed
the ColorMixer's `pc_samples`. Generalize to a target string `pickTarget: '' | 'pc' | 'wb'`:

- `Viewport` receives `pointPick={pickTarget !== ''}` (unchanged crosshair behaviour).
- `onPointPick` routes by `pickTarget`: `'pc'` → push ColorMixer sample (existing behaviour);
  `'wb'` → compute + apply WB (new).
- `ColorMixer` keeps its `onPick`/`picking` props but they now toggle `pickTarget` to `'pc'`.
- `Basic.svelte` gets the same shape: an `onWbPick` callback + `picking` prop (true when
  `pickTarget === 'wb'`), mirroring how `ColorMixer` is wired.

This keeps the ColorMixer picker working and prevents two flags racing on one event.

## WB math (backend command)

New Tauri command `gray_point_wb(params: InvertParams, rgb: [f32; 3]) -> [f32; 2]` returning
`[temp, tint]`. The sampled `rgb` is the displayed positive, encoded by the active mode's output
power. The command:

1. Picks the encode exponent `e`: `paper_grade` for Mode D (`params.mode == "d"`), else `gamma`
   (read off `build_params`). Guard `e` to a sane floor (`max(e, 1e-3)`).
2. Reconstructs the WB-neutral linear inverted value at the point. The displayed pixel is
   `d_c = (P_c · wb_old_c)^e` where `wb_old = wb_from_params(temp, tint)` is the *current* WB,
   so `P_c = d_c^(1/e) / wb_old_c`.
3. Neutralizing gray-world gains on `P` (same convention as `as_shot_wb`): `g_c = mean(P) / P_c`.
4. Converts to Temp/Tint via the existing `film_core::wb::gains_to_cct(g)` and returns `[temp, tint]`.

**Why this is absolute, not relative:** dividing out `wb_old` in step 2 makes `P_c ∝ 1/(print
without WB)_c` — the current Temp/Tint cancels exactly (it is baked into `d_c` and divided back
out). So `g_c` neutralizes the point regardless of where the sliders currently sit: one click =
"make this point gray". Undamped (unlike Auto's gray-world, which damps because it averages a whole
image). Scale of `rgb` is irrelevant (0–255 vs 0–1): the constant factor cancels in `mean(P)/P_c`.
Finishing (saturation, curves) is hue/luma-preserving on neutrals, so it does not disturb the
channel ratios WB depends on.

**Why backend, not pure frontend:** computing gains in the displayed (gamma-encoded) space would
under-correct by the encode exponent. The backend knows the exponent per mode and reuses
`gains_to_cct`, so the pick lands neutral in one click.

## Frontend flow

`Basic.svelte` pipette button → parent sets `pickTarget = 'wb'` → user clicks → `onPointPick`
(target `'wb'`) calls `api.grayPointWb(params, [r,g,b])` → sets `$params.temp`/`$params.tint` →
`reseedActive()` (history), like `autoWb()` does → `pickTarget = ''`.

## Testing

- Rust unit test for `gray_point_wb`: a non-neutral sampled RGB yields gains that, applied to that
  RGB's linearized channels, neutralize it (spread → ~0); a neutral RGB (`[v,v,v]`) returns
  ~`[5500, 0]` (neutral). Mode D vs B/C use the right exponent.
- Frontend: `npm run check` clean; existing vitest green; ColorMixer pick still works (the routing
  refactor must not regress it).

## Files

- `crates/film-core/src/wb.rs` (or a small new fn) — reuse `gains_to_cct`; add the gray-point gain
  helper if it keeps the command thin + unit-testable in `film-core`.
- `app/src-tauri/src/commands.rs` — `gray_point_wb` command + registration in the invoke handler.
- `app/src/lib/api.ts` — `grayPointWb(params, rgb)` wrapper.
- `app/src/lib/tabs/Develop.svelte` — `pointPicking: boolean` → `pickTarget: '' | 'pc' | 'wb'`;
  route `onPointPick`; pass `onWbPick`/`picking` to `Basic`.
- `app/src/lib/develop/Basic.svelte` — pipette button + `onWbPick`/`picking` props.
- `app/src/lib/develop/ColorMixer.svelte` — adjust to set `pickTarget = 'pc'` (if it currently
  toggles the boolean directly).

## Out of scope

- Multi-point / averaged gray sampling (single click for now).
- Neighborhood averaging on the backend (the sampled canvas pixel is used as-is; Viewport may
  already average a small region — reuse whatever `readCanvasPixel` returns).
