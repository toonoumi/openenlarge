# Subtractive color-head WB + OKLab perceptual saturation

**Date:** 2026-06-20
**Status:** Approved (design)

## Problem

A tester compared three renders of the same negative — optical CMY dichroic enlarger
(color head), digital camera, and OpenEnlarge (OE). Two findings:

1. **Temp/tint doesn't feel like a color head.** No matter how they adjust Temp/Tint,
   they can't dial in the optical color-head "feeling."
2. **Saturation reads too low.** Bumping the Saturation slider helps but quickly looks
   fake/neon.

## Root cause

### WB (finding #1)

`wb_from_kelvin` (`crates/film-core/src/wb.rs:37`) is a von-Kries **per-channel gain**
derived from a Tanner-Helland blackbody white point. It is applied as a **multiply on
the positive output, *after* the filmic S-curve**, then clipped to white:

```rust
// engine.rs:167
let v = filmic_s(t) * p.wb[c];
... v.min(1.0)
```

(Mirrored in `shaders.ts:374`.) A real dichroic head does the opposite: CMY filters
change each emulsion layer's **exposure in the density domain, *before* the paper
curve**, so the color shift is coupled to the tone-curve slope and produces neutral
crossovers across shadows → mids → highlights. A post-curve display multiply only lifts
a channel uniformly and clips highlights asymmetrically — which is exactly why it can't
feel like a head.

The current code deliberately chose the post-curve multiply to dodge a "yellow shadow"
bug (a log-space density offset drives one channel to black in the shadows). That
shadow behavior is part of the head look, but the *bug* form of it (one channel crushed
to black) is ugly. The fix anchors black instead of offsetting it (see below).

### Saturation (finding #2)

`apply_saturation` (`crates/film-core/src/finish.rs:472`) is a naive cube-space stretch
in display space, hard-clamped to `[0,1]`:

```rust
let factor = 1.0 + p.saturation + p.vibrance * (1.0 - cur_sat);
std::array::from_fn(|c| (y + (rgb[c] - y) * factor).clamp(0.0, 1.0))
```

(Mirrored in `shaders.ts:183`, `finishAt`.) Pushing it clips a channel at 1.0/0.0 →
hue twist → neon. There is no neutral or skin protection, and it runs *after* the
filmic curve, which has already compressed channel separation at the toe and shoulder.
So colors start desaturated and the only recovery tool is the one that goes garish
fastest.

## Design

Both the Rust core (`engine.rs`, `finish.rs`) and the GPU shader (`shaders.ts`:
`INVERT_FRAG`, `FRAG`) must stay byte-for-byte equivalent in behavior — the GPU pass is
the live proxy preview and Rust is the full-res export.

### Part A — Subtractive "Color head" WB mode

Add a `wb_mode` field to the inversion params: `Gain` (current) and `Subtractive`
(new). The two modes share the **same** `wb` gains computed by `wb_from_kelvin`; only
their *application point* differs.

- **`Gain` (unchanged):** `out = filmic_s(t) · wb[c]`. Bit-identical to today.
- **`Subtractive` (new):** convert each gain to a per-channel **multiply on `t`
  (normalised log-density), applied *before* `filmic_s`**, and drop the post-curve
  multiply:

  ```
  s[c] = pow(wb[c], CMY_STRENGTH)          // gain → per-layer density scale
  t_c  = (d / d_max) · expo_gain · s[c]    // per-layer exposure, like a dichroic filter
  out  = filmic_s(t_c)                      // NO post-curve wb multiply
  ```

Why this resolves the complaint:

- **Anchored black.** `t = 0 ⇒ t_c = 0 ⇒ filmic_s(0) = 0` for any `s[c]`. Black stays
  neutral — no "yellow shadow," no crushed channel. This is precisely why it is safe to
  do in the density domain what the original code avoided.
- **Subtractive crossover.** The shift is coupled to the filmic slope, so shadows, mids
  and highlights move by different amounts (neutral crossover) — the defining
  color-head behavior.
- **No highlight desaturation.** Channels ride the shoulder instead of being multiplied
  past 1.0 and clipped together to white.

`CMY_STRENGTH` is a single tuned constant, defined once in `engine.rs` and mirrored as a
GLSL `const` in `shaders.ts`. It is tuned on real scans / the tester's frames so the
subtractive mid-tone shift is comparable in magnitude to the gain mode at typical
temp/tint settings.

Temp/Tint sliders and auto-WB are unchanged; auto-WB still seeds in gain terms
(gray-world consistency). Only the *interpretation* of the resulting gains changes when
the toggle is on.

**Defaults / back-compat.**

- Rust serde `#[serde(default)]` for `wb_mode` resolves to **`Gain`**, so any existing
  session JSON that lacks the field loads exactly as it renders today — no existing edit
  or baked thumbnail shifts.
- The **frontend default params** for a freshly-opened, never-developed image set
  `wb_mode = Subtractive`, so new work gets the color-head look out of the box.

### Part B — OKLab perceptual saturation

Replace `apply_saturation`'s display-space cube stretch with chroma scaling in OKLab:

```
display → linear → OKLab (L, a, b)
C = hypot(a, b);  h = atan2(b, a)
factor  = 1 + saturation + vibrance · (1 − C / C_REF)   // same slider semantics
factor *= neutralProtect(C)     // smooth ramp 0→1 over low chroma: neutrals/skies clean
factor *= skinDamp(h)           // gentle cut near skin hue → believable faces
C' = C · factor
(a, b) rescaled to C';  L unchanged                     // luma fixed → no exposure drift
OKLab → linear → soft gamut roll-off → display
```

- **Gamut roll-off** is what kills neon: chroma that lands outside `[0,1]` after
  conversion is compressed back *along the hue line* toward the boundary, instead of
  clamped per-channel (per-channel clamp is what twists hue and goes garish).
- **Neutral protection** (`neutralProtect`) ramps the boost in from ~0 at very low
  chroma, so near-neutral skies, grays and whites are not pushed into colored noise.
- **Skin damping** (`skinDamp`) reduces the boost within a hue window centered on skin
  (≈ 25–55° in OKLab hue, tuned), so faces stay believable under heavy pushes. The
  tester explicitly asked to protect skin/neutrals.
- **L (luma) is held fixed**, so pushing Saturation enriches color without drifting
  exposure.

Both sliders keep their current ranges and meaning: `saturation` is a uniform chroma
gain, `vibrance` is weighted by `(1 − C/C_REF)` so already-vivid pixels move less. At 0
the transform is identity, so existing edits are unchanged.

`C_REF` and the OKLab matrices/constants are defined once in `finish.rs` and mirrored as
GLSL in `shaders.ts`.

## Scope / files

**Rust (`crates/film-core/`):**
- `engine.rs` — add `WbMode` enum + `wb_mode` to `InversionParams`; subtractive branch
  in `invert_d`; `CMY_STRENGTH` const. Default `Gain`.
- `finish.rs` — rewrite `apply_saturation` to OKLab + helpers (`linear↔oklab`,
  `neutralProtect`, `skinDamp`, gamut roll-off); `C_REF`, skin-hue consts; tests.

**Tauri (`app/src-tauri/`):**
- `commands.rs` — `wb_mode` through `InvertParams` → `resolve_params`/`build_params`.
- `session.rs` — `wb_mode` in stored params, serde default `Gain`.

**GPU (`app/src/lib/viewport/gl/`):**
- `shaders.ts` — `INVERT_FRAG`: `u_wb_mode` uniform + subtractive branch mirroring
  `invert_d`. `FRAG`/`finishAt`: OKLab saturation mirroring `apply_saturation`.
- `renderer.ts` — wire `u_wb_mode` uniform.

**UI (`app/src/lib/develop/`):**
- `Basic.svelte` — "Color head" toggle near Temp/Tint; `wb_mode` default `Subtractive`
  for new images. Saturation slider unchanged.
- i18n: add strings to `/i18n-strings.csv`, run `scripts/gen-i18n.py` (never edit
  `dict.ts` directly).

## Testing & verification

- **Unit (Rust):**
  - Subtractive mode: pure black (`d = 0`) stays neutral `[0,0,0]` for any temp/tint.
  - Subtractive mode at neutral WB (`wb = [1,1,1]`) equals Gain mode (both reduce to
    `filmic_s(t)`).
  - OKLab saturation: positive `saturation` raises OKLab chroma; result never exceeds
    gamut after roll-off; hue is preserved (no twist) for a saturated test color;
    `saturation = vibrance = 0` is identity; near-neutral pixel barely moves; skin-hue
    pixel boosted less than a non-skin pixel at equal chroma.
- **GPU/CPU parity:** existing parity tests (CPU `finish_image` vs the documented shader
  behavior) extended for the new saturation; subtractive WB verified by matching a
  handful of pixels between `invert_d` and the shader math.
- **App:** build, open the tester's negative, A/B the Color head toggle against the
  optical print frame; push Saturation and confirm it enriches without neon and keeps
  skin/skies clean. Capture before/after against the tester's three comparison frames.

## Out of scope

- Dedicated 3-slider C/M/Y filtration UI (a literal head). The subtractive temp/tint
  reaches the look; a CC-unit trio can come later if requested.
- Re-tuning the filmic curve itself (FILMIC_K/PIVOT/WHITE_T) — unchanged here.
