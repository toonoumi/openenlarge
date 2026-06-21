# Faithful Look Layer + Sole Develop Path — Design

**Date:** 2026-06-21
**Status:** Approved (design); implementation pending
**Scope:** The film-look layer from the inversion redesign's north star
(`memory/inversion-north-star.md`), plus the decision to make Faithful the **sole**
develop/tune path (Filmic retired from the app). Builds directly on the faithful
fixed-scale core (commit `bb2f803`, `memory/faithful-tone-fixed-scale.md`).

## Goal

Give the Faithful reconstruction core a **clean, punchy default look** — a gentle global
contrast curve that makes the image look like a well-developed photo **without losing any
shadow or highlight detail** ("all the detail preserved, nothing lost, but looks good") —
and make this the **only** tone path the app uses for develop/tune. Filmic is retired from
the UI; the whole catalog refreshes to the new look on app entry.

This is the north star's hard seam in practice: the **reconstruction core** (faithful,
fixed, measured) stays as-is; the **look layer** (taste) is a separate, well-bounded curve
applied on top. Aesthetic target (user-chosen): **clean & punchy / neutral** — natural
contrast and true colors, *not* stylized. Film character / warmth / grain is a later layer.

## Context

- The faithful core (`tone_mode = Faithful`) now renders a flat, neutral, all-detail
  reconstruction via `gamma_shoulder` on a fixed density scale (`FAITHFUL_SCALE = 1/0.700`).
  Verified across stocks; it is robust where Filmic's per-frame `d_max` normalization fails
  (high-key scenes). See `memory/faithful-tone-fixed-scale.md`.
- The user reviewed real renders (`~/Downloads/look_candidates/`, `~/Downloads/look_SF/`) of
  the core plus candidate S-curves at several strengths on the C400/Ektar test frames **and
  their own SF film**, and chose the **MEDIUM** strength as the fixed default.
- Filmic (`tone_mode = Filmic`) is today's default and the legacy fused look. The user has
  decided Faithful core+look becomes the **sole** path; Filmic is retired from the app.
- A thumbnail-versioning mechanism already exists: `film_core::ENGINE_VERSION` (currently
  `1`) is stamped on each baked thumbnail; `catalog.rs::load_images` computes
  `thumb_stale = thumb_version != ENGINE_VERSION`; `Grid.svelte::regenStale` **lazily**
  regenerates stale thumbnails on scroll (see `memory/thumbnail-cache-staleness.md`).

## Approach decisions (locked in brainstorming)

1. **Look = a gentle global S-curve** on the faithful core's per-channel display output
   (Approach 1), applied *after* `gamma_shoulder` and WB. Per-channel and per-pixel, so
   CPU/GPU parity is trivial. Soft toe + soft shoulder → adds mid-contrast, clips nothing.
2. **Fixed tasteful default**, no new slider. Per-image tuning uses the existing
   `finish.rs` contrast/tone controls. (Luminance-only contrast and local contrast are
   explicitly out — see Scope.)
3. **Faithful = core + look** is the **sole** user-facing path. The flat core stays as
   `tone.rs::Transfer::GammaShoulder` for the measurement harness (unchanged) — it is the
   internal building block, not a user mode.
4. **Filmic retired from the UI**, but its engine code (`filmic_s`/`filmic_inv` + the
   `ToneMode::Filmic` arm) stays **dormant** (lowest risk; deletion is a trivial later
   cleanup). Nothing in the app can select it.
5. **Whole catalog refreshes on app entry**: bump `ENGINE_VERSION`, and add an **eager
   startup sweep** that regenerates all developed+stale thumbnails (instead of waiting for
   the lazy on-scroll path).
6. **Saved edits are preserved** — WB, exposure, contrast, crop, dust all still apply; only
   the tone curve switches to Faithful core+look.

## The look curve

In the engine's per-channel SDR display domain (`v ∈ [0,1]`, the value coming out of the
faithful core after `gamma_shoulder` and WB), the look is a **normalized symmetric tanh
S-curve**, pivot 0.5, anchored exactly `0→0` and `1→1`:

```
look_s(v) = 0.5 + 0.5 · tanh(LOOK_K·(v − 0.5)) / tanh(LOOK_K·0.5)      (then clamp [0,1])
LOOK_K = 2.0     // the MEDIUM strength the user chose (~+31% mid-contrast)
```

Properties (unit-tested): `look_s(0)=0`, `look_s(1)=1`, `look_s(0.5)=0.5`; strictly
monotonic; mid-slope > 1 (punch); toe/shoulder slope < 1 (soft, no clipping/crushing);
`LOOK_K → 0` would be the identity (linearity sanity).

### Placement in the Faithful path (`engine.rs::invert_d`, per channel)

The look wraps the existing Faithful arm's per-channel value, in the **SDR** case only:

```
Gain:         v = look_s( gamma_shoulder(t_eff, ceil) · wb[c] )
Subtractive:  v = look_s( gamma_shoulder(t_eff · wb[c]^CMY_STRENGTH, ceil) )
```

- `t_eff = d · FAITHFUL_SCALE · expo_gain` (unchanged).
- **HDR handling:** the look applies only when `ceil == 1.0` (SDR). When `p.hdr` is set
  (the HDR rendition, `ceil = HDR_HEADROOM`), the Faithful path **skips** `look_s` and keeps
  today's headroom-expanded value. Reconciling the look with HDR is a documented follow-up;
  it must not crash or clip. `INVERT_FRAG` (the GPU preview) is always SDR, so it always
  applies the look — matching the CPU SDR export.
- `look_s` already clamps to `[0,1]`, giving the SDR white/black clamp for free.

## CPU/GPU parity

- `shaders.ts` `INVERT_FRAG` mirrors `look_s` verbatim as a GLSL `lookS(float v)` (same
  `LOOK_K`, same tanh form, same clamp) and applies it in the faithful branch exactly as the
  CPU does (Gain and Subtractive arms). GPU is always SDR (`ceil_val = 1.0`).
- The standing contract: CPU `invert_d` Faithful output == GPU `INVERT_FRAG` Faithful output
  at sampled densities (extend the existing parity probe).

## Faithful as the sole path

- **`app/src/lib/api.ts`** `defaultParams`: `tone_mode: "faithful"`.
- **`app/src-tauri/src/commands.rs`** `build_params` (and therefore `resolve_params`, which
  wraps it): **force** `tone_mode = Faithful`, ignoring any `"filmic"` value stored on an
  existing edit's params JSON. This is the single chokepoint that guarantees every CPU and
  GPU render uses Faithful.
- **`app/src/lib/develop/Basic.svelte`**: remove the Filmic|Faithful toggle.
- **i18n**: remove `basic.toneMode` / `basic.toneModeTitle` from `i18n-strings.csv` and
  regenerate `dict.ts` via `scripts/gen-i18n.py` (never hand-edit `dict.ts`).
- **Filmic code**: `filmic_s`, `filmic_inv`, the `ToneMode::Filmic` arm, and the GLSL filmic
  functions remain in place but unreachable from the app. `ToneMode` keeps both variants.

## Catalog force-refresh on entry

- **`crates/film-core/src/lib.rs`**: bump `ENGINE_VERSION` `1 → 2`. Every existing baked
  thumbnail (stamped `1`) now loads with `thumb_stale = true`.
- **Eager startup sweep** (frontend): on catalog load, after the snapshot arrives, enqueue
  regeneration of **every developed + stale** image's thumbnail through the current engine
  (Faithful core+look), reusing the existing per-image `regenStale` logic in
  `Grid.svelte` — driven eagerly for the full set instead of via the on-scroll observer.
  Throttle to a small concurrency so the UI stays responsive; each regenerated thumbnail
  stamps `ENGINE_VERSION` (clearing its stale flag) exactly as the lazy path does today.
- **Live Develop views** need no special handling: they recompute from saved params through
  the engine, so they become Faithful automatically once `build_params` forces it.

## Data flow

```
negative ─► invert_d (Faithful)
              d = log10(base/scan)
              t_eff = d · FAITHFUL_SCALE · expo_gain
              core  = gamma_shoulder(t_eff, ceil)         // measured faithful core
              wb'd  = core · wb   (or wb pre-curve, subtractive)
              v     = SDR ? look_s(wb'd) : wb'd           // ◄── the look layer (SDR only)
            ─► display [0,1]
(mirrored verbatim in shaders.ts INVERT_FRAG, always SDR)

app entry ─► load catalog ─► ENGINE_VERSION bump ⇒ all baked thumbs stale
          ─► eager sweep: regenerate every developed+stale thumb (Faithful core+look)
```

## Testing

- **`engine.rs` (or `tone.rs`) unit tests** for `look_s`: anchors (`0→0`, `0.5→0.5`,
  `1→1`); strict monotonicity across `[0,1]`; mid-slope > 1 and toe/shoulder slope < 1
  (adds contrast, soft ends); output stays in `[0,1]` (no clip/crush).
- **Faithful composition test**: at a mid value, Faithful-with-look differs from the bare
  core in the expected direction (shadows darker, highlights brighter), and a neutral patch
  stays neutral (per-channel look preserves neutrality: equal inputs → equal outputs).
- **Revisit `faithful_mode_open_shadows_vs_filmic`**: the look adds shadow contrast, so this
  existing assertion (Faithful shadow luma > Filmic) may no longer hold and must be
  re-derived or retargeted to the bare core. The plan resolves the exact change.
- **CPU↔GPU parity**: extend the existing `expo_cct`-style probe so the Faithful+look CPU
  output matches the documented GLSL `lookS` at sampled densities.
- **Sole-path test**: `build_params` returns `tone_mode = Faithful` even when the input
  params JSON specifies `"filmic"`.
- **Catalog test**: an image whose `thumb_version < ENGINE_VERSION` loads with
  `thumb_stale = true` (pins the force-refresh trigger); a freshly stamped row is not stale.
- **HDR sanity**: Faithful with `hdr = true` still produces finite, in-range output (look
  bypassed), and `hdr = false` applies the look.

## Architecture / file structure

- `crates/film-core/src/engine.rs` — `LOOK_K` const + `look_s` fn; apply in the Faithful
  SDR arm (Gain + Subtractive). `ToneMode` unchanged (both variants kept).
- `crates/film-core/src/lib.rs` — `ENGINE_VERSION` `1 → 2`.
- `app/src/lib/viewport/gl/shaders.ts` — GLSL `lookS` mirror + `LOOK_K`; apply in the
  faithful branch of `INVERT_FRAG`.
- `app/src-tauri/src/commands.rs` — `build_params` forces `tone_mode = Faithful`.
- `app/src/lib/api.ts` — `defaultParams.tone_mode = "faithful"`.
- `app/src/lib/develop/Basic.svelte` — remove the tone-mode toggle.
- `i18n-strings.csv` (+ `scripts/gen-i18n.py`) — drop the tone-mode strings; regenerate
  `dict.ts`.
- `app/src/lib/library/Grid.svelte` (+ wherever the catalog snapshot first loads) — eager
  startup sweep regenerating all developed+stale thumbnails.

## Scope boundaries (YAGNI)

**In:** the `look_s` curve (`LOOK_K = 2.0`) baked into Faithful (CPU + GPU + tests);
Faithful forced as the sole path (default + toggle removal + i18n); Filmic dormant;
`ENGINE_VERSION` bump + eager catalog force-refresh on entry; saved edits preserved.

**Out (deliberate):**
- Tunable look-strength slider (fixed default; existing finish controls cover tuning).
- Luminance-only contrast (Approach 2) and local contrast / detail tone-mapping
  (Approach 3 — already covered by the Texture/Clarity control).
- Film character / warmth / grain / stock looks (the *later* look-layer work).
- Deleting the dormant Filmic code (trivial follow-up if wanted).
- The −3 EV auto-exposure headroom limitation on Faithful (separate exposure-layer
  follow-up; the look renders a touch bright until then).
- Reconciling the look with the HDR rendition (documented follow-up; HDR bypasses the look).

## Open items to confirm at review

- `LOOK_K = 2.0` is the user-approved MEDIUM; the curve *form* and acceptance criteria are
  fixed, the literal is the chosen value.
- Whether the eager startup sweep regenerates strictly on first launch after the version
  bump, or re-checks every launch (cheap, since only stale rows regenerate) — the plan picks
  the simplest correct behavior (re-check every launch; only stale rows do work).
