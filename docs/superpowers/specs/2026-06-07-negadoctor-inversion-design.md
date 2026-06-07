# Negadoctor (Cineon) inversion — design

**Date:** 2026-06-07
**Status:** approved design, pre-implementation
**Context:** `INVERSION-RESEARCH-HANDOFF.md` (research, citations, code map),
`HANDOFF-color-cast.md` (prior WB/neutrality investigation).

## Goal

Replace the current `density^gamma` tone model — which looks flat/gray and is not a
physical film inverse — with the canonical **Kodak Cineon densitometry** pipeline as
implemented in darktable's `negadoctor`. Ship it as a new, live-toggleable inversion
**mode** so it can be A/B'd against the current output on real scans before it ever
becomes the default. Validate on ≥3–4 real rolls before trusting it.

## Decisions (settled)

1. **Integration:** new `Mode::D` ("Cineon") alongside B/C/Naive. The in-app A/B is a
   single mode-dropdown flip on the same scan. Stocks, base sampling, WB, and finishing
   are untouched. The current default path is not changed in this cut.
2. **Look:** neutral / clean (Filmomat philosophy) — a faithful, low-opinion conversion.
   Creative punch stays in the existing finishing sliders.
3. **D_max:** a fixed, sane constant for this cut, exposed as a slider. No develop-time
   estimator (per-roll auto-estimation is a deferred follow-up).
4. **White balance:** keep the current temp/tint + `as_shot_wb` auto unchanged. The same
   per-channel gain it produces is injected into negadoctor's canonical log-space WB slot.
   This isolates the tone-model change so the A/B measures one variable.

## The math — `invert_d`

Ported from `darktable/src/iop/negadoctor.c` (verified against source). Per channel `c`,
with linear scan input `I[c]` and `Dmin[c]` = the existing sampled `base`:

```
clamped   = max(I[c], THRESHOLD)                 # THRESHOLD = 2.3283064365386963e-10
log_dens  = log10(clamped / Dmin[c])             # = -log10(Dmin/clamped); into log/density space
corrected = log_dens / D_max - log10(wb[c])      # per-channel slope (1/D_max) + log-space WB offset
ten_to_x  = 10^corrected                          # back toward linear (the negative, density-restored)
print_lin = print_exposure*(1.0 + paper_black) - print_exposure*ten_to_x
print_lin = max(print_lin, 0.0)                   # paper inverts the negative
out[c]    = print_lin ^ paper_grade               # paper tone curve (power)
            then highlight soft-clip (see below)
```

Highlight soft-clip (exponential roll-off above `soft_clip`):

```
if out[c] > soft_clip:
    comp    = 1.0 - soft_clip
    out[c]  = soft_clip + (1.0 - exp(-(out[c]-soft_clip)/comp)) * comp
```

Mapping to negadoctor's parameters: `print_exposure` = ASC-CDL slope, `paper_black` =
offset, `paper_grade` = power. The single scalar `D_max` is the white/dynamic-range anchor;
the per-channel `Dmin` (= `base`) is the black/mask anchor. Constant `LOG2_to_LOG10 =
0.3010299957` is reused (the codebase already has `LOG10 = 0.30102999566` for `log10` via
`log2`).

### Why this beats `density^gamma`

The current `tone(v) = (v·exposure·gain − black)^gamma` raises raw **density** to a display
power, which flattens/grays the tone. Negadoctor instead returns density to **linear print
exposure** (`10^`) and applies a real **paper inversion + tone curve**, which restores
contrast and depth.

### White balance placement

The existing `wb = wb_from_kelvin(temp, tint)` produces a per-channel **linear gain**
`[gr, gg, gb]` whose convention (used by Modes B/C) is "gain > 1 brightens that channel
in the positive". It is injected as `offset[c] = -log10(wb[c])` — additive in log space,
the canonical printer-lights / enlarger-filtration slot negadoctor uses. The **negative
sign is required**: the WB offset acts on the negative side (before the paper inversion),
so reducing the density-restored value brightens the positive. With `offset = -log10(wb)`,
`ten_to_x` is divided by `wb[c]`, `print_lin` rises, and the channel brightens — matching
the B/C convention so the same temp/tint values steer color the same direction across modes.

### Display encode

`invert_d`'s output occupies the **same slot** as `invert_b`'s `tone` output — the value
the finishing pass and JPEG encode consume. `paper_grade` subsumes the display-encode role
that today's `gamma = 0.4545` plays in `tone`. Downstream finishing is therefore unchanged
and there is no double-gamma. This must be verified during implementation by confirming the
finishing/JPEG path treats `invert_d` output identically to `invert_b` output (it dispatches
purely on `Mode`, so this holds by construction, but confirm with a parity render).

## New `InversionParams` fields

Added to `crates/film-core/src/engine.rs`:

| field            | type    | role                                  |
|------------------|---------|---------------------------------------|
| `d_max`          | `f32`   | scalar white / dynamic-range anchor   |
| `print_exposure` | `f32`   | ASC-CDL slope                         |
| `paper_black`    | `f32`   | ASC-CDL offset                        |
| `paper_grade`    | `f32`   | ASC-CDL power (incl. display encode)  |
| `soft_clip`      | `f32`   | highlight roll-off threshold          |

`base` (= Dmin) and `wb` are reused. No per-channel `wb_high`/`wb_low` in this cut: the
slope is the uniform `1/D_max` and WB is the log offset.

### Starting defaults (neutral; to be dialed in on real rolls — NOT trusted blind)

`d_max = 2.0`, `print_exposure = 1.0`, `paper_black = 0.0`, `paper_grade ≈ 0.5`,
`soft_clip = 0.9`. These are starting points for the multi-roll validation, not final
values. The hard lesson from the reverted session is: do not lock constants to one frame.

## Files (CPU ↔ GPU parity — every param threaded both ways)

- `crates/film-core/src/engine.rs` — `Mode::D`; new `InversionParams` fields + `Default`;
  `invert_d`; dispatch arm in `invert_image`; unit tests.
- `app/src/lib/viewport/gl/shaders.ts` — `INVERT_FRAG`: `u_mode == 3` branch + new uniforms
  (`u_d_max`, `u_print_exposure`, `u_paper_black`, `u_paper_grade`, `u_soft_clip`),
  mirroring `invert_d` exactly.
- `app/src-tauri/src/gpu_upload.rs` — `ResolvedInversion` struct + `resolve_to_uniforms`
  carry the 5 new fields; map `Mode::D → 3`.
- `app/src/lib/viewport/gl/invert.ts` — TS `ResolvedInversion` interface + `toInversionUniforms`.
- `app/src/lib/viewport/gl/renderer.ts` — uniform name list (~line 151) + `gl.uniform1f`
  setters (~line 274).
- `app/src-tauri/src/commands.rs` — `build_params` (emit `Mode::D` params for `mode == "d"`),
  `default_invert_params`, `mode_from` (`"d" → Mode::D`).
- `app/src-tauri/src/session.rs` — `InvertParams`: new knobs with `#[serde(default)]` so old
  sessions load.
- `app/src/lib/develop/Basic.svelte` + `app/src/lib/api.ts` — "Cineon" mode option and
  sliders (may be minimal/hidden for the first cut).

## Validation (rule #1: do not overfit)

- A `film-core` example/test harness: decode → `invert_d` → PNG, on **≥3–4 real rolls**
  including the blue-mailbox frame `Image 4 (3).dng`. Eyeball the results; no region-stat
  claims (region stats lied last session).
- CPU/GPU parity: same scan + params rendered both ways must match within tolerance.
- Gates: `cargo test -p film-core`,
  `cargo test --manifest-path app/src-tauri/Cargo.toml`,
  `cargo build --manifest-path app/src-tauri/Cargo.toml`,
  `cd app && npx vitest run src/lib/viewport/gl/ && npm run check` (0 errors).

## Deferred (explicitly NOT this cut)

- Gray-edge / unified Minkowski AWB in log space (`INVERSION-RESEARCH-HANDOFF.md` §5b).
- Per-roll D_max auto-estimation (piggyback on `sample_base`'s pass).
- Per-channel printer-lights (`wb_high` / `wb_low`).
- Auto rebate / Dmin detection for hands-off per-roll calibration.
- Manual gray-point picker UI.

## Preserve concurrent WIP

The working tree has uncommitted user WIP in `commands.rs`, `convert.rs`, `cache.rs`,
`catalog.rs`, `encode.rs`, `exif_write.rs`, `metadata.rs`, `session.rs`, `tether.rs`,
`gpu_upload.rs`. Edit surgically; never `git checkout` these wholesale.
