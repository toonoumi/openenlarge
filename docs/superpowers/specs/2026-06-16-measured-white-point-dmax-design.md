# Measured White-Point D_max Anchor — Design

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Scope:** Engine + CLI + minimal UI (prototype)

## Motivation

OpenEnlarge derives the roll's density range `D_max` automatically from the
**1st-percentile transmission of scene content inside the crop** (`calibrate::sample_dmax`).
That estimate varies frame to frame: a frame without a true specular highlight
under-reports the available range, so the highlight anchor drifts across a roll.

FreeCCR's manual mode instead anchors the highlight end to a **physical reference** —
the fully-exposed leader (max light → max film density). Because the leader is the
same on every frame of a roll, anchoring to it makes highlight rendering
roll-consistent rather than scene-dependent.

This feature adds an **optional measured white-point** so a user who has shot/scanned
the exposed leader can pin `D_max` from that physical reference instead of relying on
the per-frame percentile estimate. It is opt-in; auto `sample_dmax` remains the default.

## Key existing infrastructure (reused, not rebuilt)

The scalar `D_max` override is **already fully plumbed**:

- `app/src-tauri/src/session.rs:61` — `InvertParams.d_max_override: Option<f32>`
- `app/src-tauri/src/commands.rs:199` — `d_max: p.d_max_override.unwrap_or(1.5)`
- `app/src-tauri/src/commands.rs:214` — `effective_dmax` prefers the override
- `app/src/lib/api.ts:49` — `d_max_override: number | null`
- `app/src/lib/develop/Basic.svelte:101` — `reanalyze()` sets `d_max_override` from the crop
- `app/src/lib/develop/copySettings.ts:16` — included in copy-to-other-images
- GPU shader `app/src/lib/viewport/gl/shaders.ts:237` reads `u_d_max`

So the override path (persistence, copy-settings, GPU live preview, export) already
works. This feature only adds a **new way to produce** the override value.

## Anchor logic

When a white-point rect is sampled, it **replaces** the auto `D_max` for that frame,
flowing through the existing `d_max_override`. Computed like `sample_dmax`, but the
anchor comes from the user's leader rect rather than scene content:

```
white[c] = robust low value (5th percentile) of channel c inside the rect
D_max    = max over channels of  log10( base[c] / white[c] )
D_max    = clamp(D_max, 1.0, 4.0)
```

Three deliberate choices:

1. **Override, not floor/blend.** A clean A/B (physical anchor vs percentile estimate);
   a silent floor would obscure whether the anchor helps. The `[1,4]` clamp is the only
   safety net (matches `sample_dmax`).
2. **Scalar (max-across-channels), not per-channel.** Per-channel `D_max` would bake
   white balance *into the inversion* — the exact FreeCCR behavior OpenEnlarge avoids so
   that "base and WB don't fight." Keeping `D_max` scalar preserves channel coupling; WB
   stays a separate print-side gain.
3. **White-point = robust low value.** The exposed leader is the densest film area, hence
   the *darkest* (lowest RGB) in the scan. A per-channel 5th-percentile rejects dust
   specks while tracking the uniform leader value.

## Components

### 1. Engine — `crates/film-core/src/calibrate.rs`

New public function (the only new math):

```rust
/// D_max from a measured white-point (fully-exposed leader) sampled in `rect`.
/// Mirrors `sample_dmax`, but the anchor comes from the user's leader rect, not
/// scene content. Leader = densest film → darkest scan, so we take a robust low
/// value per channel. Returns the same scalar D_max the engine already consumes.
pub fn dmax_from_white_point(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32
```

- Same 512px downscaled proxy + `scaled_rect` crop mapping as `sample_dmax`.
- Per channel: 5th-percentile of rect pixels = `white[c]` (guard `white[c] >= 1e-5`);
  `density = log10(base[c] / white[c])`; take `max` across channels; `clamp(1.0, 4.0)`.
- Guard: empty rect or `base[c] <= 1e-6` skips that channel (mirrors `sample_dmax`).
- **Unit test:** synthetic image with a known leader value + known base → assert the
  computed `D_max` equals `max_c log10(base/white)` within tolerance; assert clamp
  bounds; assert per-channel-max collapse (one channel dominates).

### 2. CLI — `crates/film-cli`

Add `--white-rect x,y,w,h` (parsed like the existing `--base-rect`). When present,
`D_max` is computed via `dmax_from_white_point` using the already-sampled base, instead
of auto `sample_dmax`. Mutually independent of `--base-rect`. Enables headless
validation on real rolls before any UI work.

### 3. Tauri command — `app/src-tauri/src/commands.rs`

`analyze_white_point(id, params, rect) -> { d_max: f32 }` — a near-clone of the existing
`analyze` command (~line 500): resolve the effective base, call `dmax_from_white_point`,
return the scalar. Registered in the Tauri handler list alongside `analyze`.

### 4. Frontend — minimal UI

- `app/src/lib/api.ts`: `analyzeWhitePoint(id, params, rect)` binding (+ type).
- A **"Sample white-point"** tool button in the develop panel that enters a drag-rect
  mode in the viewport, reusing the existing base-recalibrate drag-rect picker. On
  release: call `analyzeWhitePoint` → `params.update(p => ({...p, d_max_override: d_max}))`
  → `commitActive()` → `autoWb()`. (Same tail as `reanalyze()` at `Basic.svelte:101-103`.)
- One i18n string added via `/i18n-strings.csv` + `scripts/gen-i18n.py`
  (never editing `dict.ts` directly — project convention).

### 5. Auto-reanalyze suppression

`Basic.svelte:111-117` auto-re-runs `reanalyze()` (scene-percentile `D_max`) whenever the
crop changes. After a measured white-point is set, that path would silently clobber the
anchor. 

**Prototype approach:** a frontend-only `whitePointPinned: Set<imageId>` (in the develop
store). Sampling a white-point adds the id; the crop-watcher skips `reanalyze()` for
pinned ids; clearing/re-sampling updates the set. 

**Known limitation (acceptable for prototype):** this pin is **not persisted** — after an
app reload, a crop change could re-clobber the measured `D_max` (the override value itself
*does* persist; only the "don't auto-recompute" intent is lost). The production follow-up
is a persisted `d_max_pinned` flag on `InvertParams` (Rust wire contract + `api.ts` +
`copySettings.ts`), deliberately out of scope here to keep the prototype small.

## Data flow

```
drag leader rect in viewport
  → api.analyzeWhitePoint(id, params, rect)
  → commands::analyze_white_point
  → calibrate::dmax_from_white_point(img, base, rect)  → scalar D_max
  → d_max_override (existing)
  → build_params / GPU u_d_max / export  (all unchanged)
```

## Out of scope

- Per-channel `D_max` (would bake WB into inversion).
- Persisted pin flag / production-grade UI polish.
- HDR or export changes (override already flows through both).
- Black-point sampling (OpenEnlarge already anchors the shadow end via the coherent base).

## Testing

- **Engine unit test** for `dmax_from_white_point` (values, clamp, channel-max).
- **CLI smoke:** run `film-cli` with `--white-rect` over a fixture; assert it produces a
  different, plausible `D_max` than the auto path.
- **Existing tests** for `d_max_override` plumbing (`commands.rs:1802`,
  `gpu_upload.rs:405`) continue to pass unchanged.
- Manual: sample leader on a real roll, confirm highlight consistency across frames vs
  auto.
