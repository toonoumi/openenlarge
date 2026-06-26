# Headroom Tone Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the develop tone tools (Contrast / Highlights / Shadows / Whites / Blacks) recover genuine clipped highlight/shadow detail instead of redistributing an already-clipped image.

**Architecture:** Split the Faithful display mapping. INVERT emits the *gamma body* carrying super-white (>1.0) in the existing RGBA16F buffer; the highlight shoulder + look layer + clamp ("display finalize") move to the end of `finish::tone_curve`, after the user's slider ops. The domain change is confined to the display path via a new `invert_d_core` (body) while `invert_d` (display) stays byte-identical, so analysis code (auto-WB, gray-pick, color-match, noise-match) is untouched.

**Tech Stack:** Rust (`film-core` crate, `film_core` + Tauri `app/src-tauri`), WebGL2 GLSL (`app/src/lib/viewport/gl/shaders.ts`), Vitest (TS), `cargo test` (Rust).

**Spec:** `docs/superpowers/specs/2026-06-25-headroom-tone-recovery-design.md`

## Global Constraints

- **CPU/GPU parity:** every constant, function, and order in `engine.rs`/`finish.rs` (CPU export) MUST be mirrored verbatim in `shaders.ts` `INVERT_FRAG`/`FRAG` (GPU proxy preview). Existing parity tests must stay green.
- **Faithful is the sole production path.** `tone_mode` is forced Faithful (`commands.rs:265`, `invert.ts:62`); the finalizer in `finish` assumes a Faithful body. Filmic/HDR/naive/B/C remain reachable only through `invert_d` (display) and are unchanged.
- **Identity invariant:** with all tone sliders at 0, the full pipeline output equals today's — bit-identical in subtractive WB; bit-identical below the shoulder knee in gain WB (production default), with the intended highlight change above the knee.
- **Constants (must match across Rust + GLSL):** `FAITHFUL_GAMMA = 1.590`, `FAITHFUL_KNEE = 0.892`, `LOOK_K = 2.0`, `REC_H_GAIN = 3.0`, `REC_S_GAIN = 0.6`.
- Run `cargo test -p film-core` and `cargo test -p app` (Tauri crate) for Rust; `npm test` in `app/` for TS. Commit after each task.

---

### Task 1: Factor the Faithful curve into `gamma_body` + `shoulder_only` + `display_finalize`

Pure refactor of `engine.rs`: extract the two halves of `gamma_shoulder` and add the SDR display finalizer. `gamma_shoulder` keeps identical behaviour (HDR caller unaffected).

**Files:**
- Modify: `crates/film-core/src/engine.rs` (around `gamma_shoulder` at 239-249, `look_s` at 164-175)
- Test: `crates/film-core/src/engine.rs` (`#[cfg(test)]` module)

**Interfaces:**
- Produces:
  - `pub(crate) fn gamma_body(x: f32) -> f32`
  - `pub(crate) fn shoulder_only(raw: f32, ceil: f32, hi_recovery: f32) -> f32`
  - `pub(crate) fn display_finalize(v: f32) -> f32`
  - `fn gamma_shoulder(x, ceil, hr)` unchanged externally (now `shoulder_only(gamma_body(x), ceil, hr)`)
  - `look_s` becomes `pub(crate)` (signature unchanged: `fn look_s(v: f32, lo_recovery: f32) -> f32`)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `engine.rs`:

```rust
#[test]
fn gamma_shoulder_factors_into_body_and_shoulder() {
    // gamma_shoulder(x, ceil, hr) must equal shoulder_only(gamma_body(x), ceil, hr).
    for &x in &[0.0_f32, 0.1, 0.5, 0.892, 1.0, 1.5, 3.0] {
        for &hr in &[0.0_f32, 1.0] {
            let combined = gamma_shoulder(x, 1.0, hr);
            let split = shoulder_only(gamma_body(x), 1.0, hr);
            assert!((combined - split).abs() < 1e-6, "x={x} hr={hr}: {combined} vs {split}");
        }
    }
}

#[test]
fn display_finalize_matches_old_faithful_tail() {
    // display_finalize(v) == look_s(gamma_shoulder over the body, 0) for hr=lo=0.
    for &raw in &[0.0_f32, 0.3, 0.8, 0.892, 1.0, 1.4, 2.0] {
        let want = look_s(shoulder_only(raw, 1.0, 0.0), 0.0);
        assert!((display_finalize(raw) - want).abs() < 1e-7, "raw={raw}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p film-core gamma_shoulder_factors_into_body_and_shoulder display_finalize_matches_old_faithful_tail`
Expected: FAIL — `gamma_body`, `shoulder_only`, `display_finalize` not found.

- [ ] **Step 3: Write minimal implementation**

Replace `gamma_shoulder` (lines 238-249) with the factored helpers and finalizer. Keep the existing doc comment on `gamma_shoulder`:

```rust
/// Power-law body of the Faithful curve: `x^(1/γ)`, `x` clamped at 0. The shoulder
/// rolloff is applied separately by `shoulder_only`, so a super-white body (`> 1`)
/// can be carried into the finish stage and only rolled off at display-encode time.
#[inline]
pub(crate) fn gamma_body(x: f32) -> f32 {
    x.max(0.0).powf(1.0 / FAITHFUL_GAMMA)
}

/// Shoulder rolloff of the Faithful curve, applied to the gamma body `raw`.
/// Identity below `FAITHFUL_KNEE`; asymptotic to `ceil` above. `hi_recovery` widens
/// the rolloff scale (0 = current curve). MUST equal shaders.ts `shoulderOnly`.
#[inline]
pub(crate) fn shoulder_only(raw: f32, ceil: f32, hi_recovery: f32) -> f32 {
    if raw <= FAITHFUL_KNEE {
        raw.min(ceil)
    } else {
        let k = FAITHFUL_KNEE;
        let scale = (1.0 - k) * (1.0 + REC_H_GAIN * hi_recovery);
        k + (ceil - k) * (1.0 - (-(raw - k) / scale).exp())
    }
}

/// Faithful reconstruction curve: `shoulder_only(gamma_body(x), ceil, hi_recovery)`.
/// `ceil` is `1.0` for SDR or `HDR_HEADROOM` for HDR. Output is in `[0, ceil]`.
#[inline]
fn gamma_shoulder(x: f32, ceil: f32, hi_recovery: f32) -> f32 {
    shoulder_only(gamma_body(x), ceil, hi_recovery)
}

/// SDR display finalizer: the shoulder rolloff + clean-punchy look layer + clamp,
/// applied to a super-white gamma body `v` to produce the display value in `[0,1]`.
/// Recovery is retired, so the shoulder/toe are fixed (`hi=lo=0`). This is the tail
/// of the old Faithful SDR path, moved out of `invert_d` so the finish tone tools can
/// operate on the body first. MUST equal shaders.ts `displayFinalize` (`lookS(shoulderOnly(v,1,0),0)`).
#[inline]
pub(crate) fn display_finalize(v: f32) -> f32 {
    look_s(shoulder_only(v, 1.0, 0.0), 0.0)
}
```

Change `fn look_s` (line 164) to `pub(crate) fn look_s`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core`
Expected: PASS — new tests pass AND every existing `engine.rs` test (e.g. `gamma_shoulder_identity_at_zero_recovery`) still passes (behaviour of `gamma_shoulder` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "refactor(engine): factor gamma_shoulder into gamma_body + shoulder_only + display_finalize"
```

---

### Task 2: Add `invert_d_core` (body) and keep `invert_d` (display) byte-identical

Split the Faithful SDR output: `invert_d_core` returns the super-white body; `invert_d` becomes `display_finalize(core)` for Faithful SDR and is otherwise unchanged. Retire the SDR recovery tests.

**Files:**
- Modify: `crates/film-core/src/engine.rs` (`invert_d` 286-395, `invert_image` 405-415, recovery tests ~1430-1490)
- Test: `crates/film-core/src/engine.rs`

**Interfaces:**
- Consumes: `gamma_body`, `display_finalize` (Task 1).
- Produces:
  - `pub fn invert_d_core(rgb: [f32; 3], p: &InversionParams) -> [f32; 3]` — body for Faithful SDR; current display value for all other modes.
  - `pub fn invert_image_core(img: &crate::Image, p: &InversionParams, _mode: Mode) -> crate::Image`
  - `pub fn invert_d` / `pub fn invert_image` — unchanged signatures, byte-identical output.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn invert_d_equals_display_finalize_of_core_faithful_sdr() {
    let mut p = faithful_params();          // existing test helper (Faithful, SDR)
    p.hi_recovery = 0.0; p.lo_recovery = 0.0;
    for &s in &[0.05_f32, 0.2, 0.5, 0.8, 0.95] {
        let core = invert_d_core([s, s, s], &p);
        let disp = invert_d([s, s, s], &p);
        for c in 0..3 {
            assert!((display_finalize(core[c]) - disp[c]).abs() < 1e-6,
                "s={s} c={c}: finalize(core)={} disp={}", display_finalize(core[c]), disp[c]);
        }
    }
}

#[test]
fn invert_d_core_carries_super_white_on_bright_highlight() {
    let p = faithful_params();
    // A very thin negative (scan ≈ base) is a scene highlight → dense body.
    let core = invert_d_core([0.02, 0.02, 0.02], &p);
    let disp = invert_d([0.02, 0.02, 0.02], &p);
    assert!(core[0] > 1.0, "body should exceed 1.0 (super-white), got {}", core[0]);
    assert!(disp[0] <= 1.0 + 1e-6, "display must stay clamped, got {}", disp[0]);
}
```

(If no `faithful_params()` helper exists, define one in the test module mirroring the existing Faithful test setup used at `engine.rs:1469`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p film-core invert_d_equals_display_finalize_of_core_faithful_sdr invert_d_core_carries_super_white_on_bright_highlight`
Expected: FAIL — `invert_d_core` not found.

- [ ] **Step 3: Write minimal implementation**

In `invert_d`'s Faithful arm (engine.rs 360-391), stop applying the shoulder + look layer; return the body. The current Faithful arm ends with `gamma_shoulder(...)` then `look_s(...)`. Change the SDR branch to compute the body via `gamma_body`:

```rust
ToneMode::Faithful => {
    let ceil = if p.hdr { HDR_HEADROOM } else { 1.0 };
    let l = (10f32.powf(d) - 1.0).max(0.0);
    let lit = l * 2f32.powf(FAITHFUL_EXPO_K * ev);
    let t_eff = (lit + 1.0).log10() * FAITHFUL_SCALE;
    if p.hdr {
        // HDR unchanged: full shoulder into HDR_HEADROOM, no look layer.
        let hr = 0.0;
        match p.wb_mode {
            WbMode::Gain => gamma_shoulder(t_eff, ceil, hr) * p.wb[c],
            WbMode::Subtractive =>
                gamma_shoulder(t_eff * p.wb[c].max(EPS).powf(CMY_STRENGTH), ceil, hr),
        }
    } else {
        // SDR: emit the GAMMA BODY (super-white preserved). The shoulder + look layer
        // + clamp move to `display_finalize`, applied either by `invert_d` (analysis /
        // back-compat) or by `finish::tone_curve` (display path) after the tone tools.
        match p.wb_mode {
            WbMode::Gain => gamma_body(t_eff) * p.wb[c],
            WbMode::Subtractive =>
                gamma_body(t_eff * p.wb[c].max(EPS).powf(CMY_STRENGTH)),
        }
    }
}
```

Rename the existing `fn invert_d` to `pub fn invert_d_core` (keep the whole body above as the core), then add a thin display wrapper:

```rust
/// Display-referred inversion: `invert_d_core` then the SDR display finalize for the
/// Faithful path (other modes already return a display value). Byte-identical to the
/// pre-headroom `invert_d`, so all analysis / back-compat callers are unaffected.
pub fn invert_d(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    let core = invert_d_core(rgb, p);
    if matches!(p.tone_mode, ToneMode::Faithful) && !p.hdr {
        std::array::from_fn(|c| display_finalize(core[c]))
    } else {
        core
    }
}
```

Add the core image wrapper next to `invert_image`:

```rust
/// Like `invert_image` but returns the super-white BODY (no display finalize). Used
/// only by the display path (feeds `finish_image`, which finalizes after the tone tools).
pub fn invert_image_core(img: &crate::Image, p: &InversionParams, _mode: Mode) -> crate::Image {
    let pixels = img.pixels.par_iter().map(|&px| invert_d_core(px, p)).collect();
    crate::Image { width: img.width, height: img.height, pixels, ir: img.ir.clone() }
}
```

Note: `invert_image` (line 405) already calls `invert_d` — leave it as-is (now the display wrapper).

Delete the four now-invalid SDR recovery tests that set `hi_recovery`/`lo_recovery = 1.0` to assert pre-clamp widening: `highlight_recovery_separates_crushed_highlights` (≈1430), `shadow_recovery_separates_crushed_shadows` (≈1441), `recovery_neutral_stays_neutral` (≈1466), `recovery_curves_monotonic_and_in_gamut` (≈1479). KEEP `gamma_shoulder_identity_at_zero_recovery`, `look_s_identity_at_zero_recovery`, and `invert_d_identity_at_zero_recovery` — those pin unchanged behaviour and must still pass. Recovery is retired; the new recovery behaviour is covered by Task 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core`
Expected: PASS — new tests pass; all surviving `invert_d` tests (which pin display behaviour) still pass because `invert_d` is byte-identical.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): invert_d_core emits super-white body; invert_d stays display-identical"
```

---

### Task 3: Apply `display_finalize` at the end of `finish::tone_curve`; relax per-zone clamp

`finish`'s input becomes the Faithful body. `tone_curve` drops its leading clamp, runs the slider ops on the headroom value, then finalizes to display. `apply_per_zone_wb` stops clamping so super-white survives to `tone_curve`.

**Files:**
- Modify: `crates/film-core/src/finish.rs` (`apply_per_zone_wb` 89-101, `tone_curve` 504-519)
- Test: `crates/film-core/src/finish.rs`

**Interfaces:**
- Consumes: `crate::engine::display_finalize` (Task 1).
- Produces: `tone_curve` semantics — input is a Faithful body (may exceed 1.0), output is display `[0,1]`. At sliders 0, `tone_curve(v) == display_finalize(v)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn tone_curve_default_is_display_finalize() {
    // At sliders 0, tone_curve must equal the moved display finalize (identity invariant).
    let p = FinishParams::default();
    for &v in &[0.0_f32, 0.3, 0.8, 1.0, 1.4, 2.0] {
        let got = tone_curve(v, &p);
        let want = crate::engine::display_finalize(v);
        assert!((got - want).abs() < 1e-6, "v={v}: {got} vs {want}");
    }
}

#[test]
fn lowering_whites_recovers_super_white_detail() {
    // Two distinct super-white bodies collapse to ~white at sliders 0, but lowering
    // Whites pulls them apart below the shoulder → recovered, distinct, lower values.
    let mut lo = FinishParams::default();
    lo.whites = -1.0;                          // wire range is /100; -1.0 == slider -100
    let (a, b) = (1.25_f32, 1.45_f32);
    let da0 = (tone_curve(a, &FinishParams::default()) - tone_curve(b, &FinishParams::default())).abs();
    let da1 = (tone_curve(a, &lo) - tone_curve(b, &lo)).abs();
    assert!(tone_curve(a, &lo) < tone_curve(a, &FinishParams::default()), "whites<0 must darken highlights");
    assert!(da1 > da0 + 1e-4, "lower whites must re-separate detail: {da0} -> {da1}");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p film-core tone_curve_default_is_display_finalize lowering_whites_recovers_super_white_detail`
Expected: FAIL — current `tone_curve` clamps input to `[0,1]` and has no finalizer, so the super-white cases collapse and `da1 == da0`.

- [ ] **Step 3: Write minimal implementation**

Edit `tone_curve` (finish.rs 504-519): drop the leading clamp, append the finalizer.

```rust
fn tone_curve(v: f32, p: &FinishParams) -> f32 {
    // Input is the Faithful gamma BODY (may exceed 1.0 = super-white). NO leading
    // clamp — the tone tools must see headroom so negative Whites/Contrast can pull
    // blown highlights back below the shoulder and recover detail.
    let mut v = v;
    // Endpoints: strongest at the extremes.
    v += p.whites * 0.20 * v.powi(3);
    v += p.blacks * 0.20 * (1.0 - v).powi(3);
    // Regions: shelf weights that peak AT the extremes (smoothstep, C1).
    v += p.highlights * 0.18 * smoothstep(0.5, 1.0, v);
    v += p.shadows * 0.18 * (1.0 - smoothstep(0.0, 0.5, v));
    // Contrast: linear gain about 0.5.
    v = 0.5 + (v - 0.5) * (1.0 + p.contrast);
    // Display finalize: the Faithful shoulder + look layer + clamp, MOVED here from
    // invert_d so the tone tools above operate on the un-clipped body. MUST mirror the
    // GPU FRAG finalizer. At sliders 0 this reproduces the old invert_d Faithful tail.
    crate::engine::display_finalize(v)
}
```

Edit `apply_per_zone_wb` (finish.rs 97-100): relax the clamp so super-white survives.

```rust
    std::array::from_fn(|c| {
        let gain = w_sh * pz.sh[c] + w_mid * pz.mid[c] + w_hi * pz.hi[c];
        // No [0,1] clamp: per-zone WB runs before tone_curve on the super-white body;
        // clamping here would re-clip the highlight headroom the tone tools recover.
        (rgb[c] * gain).max(0.0)
    })
```

- [ ] **Step 4: Update the finish tests whose contract changed, then run**

`finish_pixel`'s input domain changed (display → body) and default finish is no longer a passthrough identity (it now applies `display_finalize`). Fix the tests that assumed default-identity-on-arbitrary-input:

- `finish_image_default_returns_equal_image` (≈1052): reframe — feed an input image and assert each output channel equals `display_finalize(input_channel)` (per-channel, since saturation/grade are identity at default). Replace the equality-to-input assertion accordingly.
- Any other test asserting `finish_pixel(x, default) == x` (e.g. a brightness/identity probe): change the expectation to `display_finalize` of the (brightness-scaled) body. Tests that compare two finish results to each other (per-zone identity ≈1472, image-vs-scalar parity ≈1184, mixer/saturation relative tests) are unaffected — both sides gain the same finalizer — and should still pass unchanged.

Run: `cargo test -p film-core`
Expected: PASS — new tests pass; reframed tests pass; relative-comparison tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/finish.rs
git commit -m "feat(finish): tone_curve operates on the body, finalizes to display after the tone tools"
```

---

### Task 4: Route the display path to `invert_image_core` and retire the recovery wiring

Switch the eight `invert → finish` display sites to the body variant, zero the retired recovery params, and add an end-to-end identity test.

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`build_params` 257-271; invert sites 1202, 1241, 1426, 1509, 2091, 2181, 3048; recovery tests 3508-3522)
- Modify: `app/src-tauri/src/color_match.rs` (line 147)
- Test: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `invert_image_core` (Task 2), `finish` finalizer (Task 3).

- [ ] **Step 1: Write the failing test**

In the `commands.rs` test module, add an end-to-end identity check (sliders at 0 → today's pipeline) and a recovery check:

```rust
#[test]
fn headroom_pipeline_identity_at_zero_sliders() {
    // Default tone sliders: invert_image_core + finish must equal the legacy
    // invert_image (display) + finish for a representative negative.
    let neg = test_negative();                 // existing small test image helper
    let p = default_invert_params();           // all tone sliders 0
    let ip = build_params(&p, [0.18, 0.12, 0.08]);
    let legacy = finish_image(&invert_image(&neg, &ip, Mode::D), &finish_from(&p));
    let headroom = finish_image(&invert_image_core(&neg, &ip, Mode::D), &finish_from(&p));
    for (a, b) in legacy.pixels.iter().zip(headroom.pixels.iter()) {
        for c in 0..3 { assert!((a[c] - b[c]).abs() < 1e-5, "{a:?} vs {b:?}"); }
    }
}

#[test]
fn build_params_zeroes_retired_recovery() {
    let mut p = default_invert_params();
    p.highlights = -100.0; p.shadows = -100.0;
    let ip = build_params(&p, [0.18, 0.12, 0.08]);
    assert_eq!(ip.hi_recovery, 0.0);
    assert_eq!(ip.lo_recovery, 0.0);
}
```

(Reuse whatever small-image/param helpers the existing `commands.rs` tests use; if none, build a 2×2 `Image` and an `InvertParams::default()`-style literal as the neighbouring tests do.)

Note: `headroom_pipeline_identity_at_zero_sliders` holds exactly in subtractive WB and below the shoulder knee in gain WB. Use a negative whose developed values land below the knee (a normal mid-key frame), OR assert with a tolerance that admits the gain-mode highlight delta. Prefer a mid-key `test_negative()` so the strict `1e-5` holds.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app headroom_pipeline_identity_at_zero_sliders build_params_zeroes_retired_recovery`
Expected: FAIL — `build_params` still sets `hi_recovery: -p.highlights/100` (so `build_params_zeroes_retired_recovery` fails), and `invert_image_core` + finish double-or-mismatches until wiring is correct.

- [ ] **Step 3: Write minimal implementation**

In `build_params` (commands.rs 266-269), retire the recovery wiring:

```rust
        // Highlight/shadow recovery is retired — the finish tone tools recover detail
        // on the super-white body instead (see headroom-tone-recovery design). Keep the
        // fields (wire contract) but always zero.
        hi_recovery: 0.0,
        lo_recovery: 0.0,
```

Switch the eight display-path inversions from `invert_image` to `invert_image_core`. Add `invert_image_core` to the import at `commands.rs:16`:

```rust
use film_core::engine::{invert_image, invert_image_core, InversionParams, Mode};
```

Then change these lines (the `invert_image(...)` whose result feeds `finish_image`):
- `commands.rs:1202`, `1241`, `1426`, `1509`, `2091`, `2181`, `3048` → `invert_image_core(...)` (same args).
- `color_match.rs:147` → `invert_image_core(...)`; update its import at `color_match.rs:139` to `use film_core::engine::invert_image_core;`.

Do NOT change the analysis/seed/bake sites (`1952`, `2012`, `2173`, `2464`, `3008`, `3107`, and any in `convert.rs`/`calibrate.rs`) — they consume the display positive.

Update the old recovery-mapping tests at `commands.rs:3508-3522` (`*_drive_engine_recovery` / `finish_from_suppresses_negative_highlights_shadows`): the mapping is gone, so assert `hi_recovery == 0.0 && lo_recovery == 0.0` regardless of slider sign (the `build_params_zeroes_retired_recovery` test covers this; delete or rewrite the obsolete assertions rather than leave them asserting the removed behaviour).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app`
Expected: PASS — identity + zero-recovery tests pass; rewritten recovery tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/color_match.rs
git commit -m "feat(develop): route display path through invert_image_core; retire recovery wiring"
```

---

### Task 5: Mirror the split in the GPU shaders (`shaders.ts`)

Port the body/finalizer split to WebGL2 so the proxy preview matches the CPU export. INVERT_FRAG emits the body; FRAG appends the finalizer; the clip overlay reads the finished display color.

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (`FRAG` 62-308, `INVERT_FRAG` 385-606)
- Test: `app/src/lib/viewport/gl/*.test.ts` (uniform-mapping tests must still pass; GLSL math is verified by GUI smoke)

**Interfaces:**
- Mirrors Task 1-3 Rust math exactly (constants in Global Constraints).

- [ ] **Step 1: INVERT_FRAG — emit the gamma body (no shoulder/look/clamp)**

In the Faithful branch of `invert()` (shaders.ts ≈521-556), add a `gammaBody` helper near `gammaShoulder` (line 445):

```glsl
float gammaBody(float x) { return pow(max(x, 0.0), 1.0 / FAITHFUL_GAMMA); }
```

Replace the Faithful SDR body computation (the `if (u_tone_mode == 1) { ... }` block that currently does `gammaShoulder(...)` then `lookS(...)` then `clamp`) with: keep HDR untouched (there is no HDR branch in INVERT_FRAG today — it is SDR-only, `ceil_val = 1.0`), and for the SDR path emit the body:

```glsl
      vec3 lScene = max(pow(vec3(10.0), d) - 1.0, 0.0);
      vec3 lit = lScene * exp2(FAITHFUL_EXPO_K * ev);
      vec3 te = log2(lit + 1.0) * LOG10 * FAITHFUL_SCALE;
      if (u_wb_mode == 1) {
        vec3 s = pow(max(u_wb, vec3(EPS)), vec3(CMY_STRENGTH));
        v = vec3(gammaBody(te.r * s.r), gammaBody(te.g * s.g), gammaBody(te.b * s.b));
      } else {
        v = vec3(gammaBody(te.r) * u_wb.r, gammaBody(te.g) * u_wb.g, gammaBody(te.b) * u_wb.b);
      }
      return v;   // super-white body, UNCLAMPED — finish FRAG finalizes to display.
```

Remove the `lookS(...)` line and the `return clamp(v, 0.0, 1.0);` for this branch only (other modes keep their clamps). `u_hi_recovery`/`u_lo_recovery` are now unused in INVERT_FRAG (always 0) — leave the uniforms declared.

- [ ] **Step 2: FRAG — add finalizer helpers and append to `tone()`**

FRAG (shaders.ts 16-308) is a separate program and lacks `lookS`/`shoulderOnly`. Add, near the top of FRAG after the uniforms, the constants and helpers (verbatim mirror of engine):

```glsl
const float FAITHFUL_GAMMA = 1.590;
const float FAITHFUL_KNEE = 0.892;
const float LOOK_K = 2.0;
float shoulderOnly(float raw, float ceil_val) {
  if (raw <= FAITHFUL_KNEE) return min(raw, ceil_val);
  float k = FAITHFUL_KNEE;
  float scale = (1.0 - k);                  // hi_recovery retired → 0
  return k + (ceil_val - k) * (1.0 - exp(-(raw - k) / scale));
}
float lookS(float v) {                       // lo_recovery retired → 0
  return clamp(0.5 + 0.5 * tanh(LOOK_K * (v - 0.5)) / tanh(LOOK_K * 0.5), 0.0, 1.0);
}
float displayFinalize(float v) { return lookS(shoulderOnly(v, 1.0)); }
```

Edit `tone()` (FRAG 62-73): drop the leading `clamp`, append the finalizer:

```glsl
float tone(float v) {
  v += u_whites * 0.20 * v * v * v;
  v += u_blacks * 0.20 * pow(1.0 - v, 3.0);
  v += u_highlights * 0.18 * smoothstep(0.5, 1.0, v);
  v += u_shadows * 0.18 * (1.0 - smoothstep(0.0, 0.5, v));
  v = 0.5 + (v - 0.5) * (1.0 + u_contrast);
  return displayFinalize(v);
}
```

Edit `applyPerZoneWb` (FRAG 83-91): change the final `return clamp(rgb * gain, 0.0, 1.0);` to `return max(rgb * gain, vec3(0.0));` (headroom-safe, mirrors Rust).

- [ ] **Step 3: Clip overlay — test the finished display color, not `u_src`**

`u_src` in FRAG is now the super-white body, so `clipCode(texture(u_src,...))` (FRAG 286-293, called at 303) would misfire. Switch it to the finished display color `c`:

In `main()` (FRAG 301-307) change:

```glsl
void main() {
  vec3 c = finishAt(v_uv);
  int code = clipCode(c);                    // test the finished DISPLAY color (was texture(u_src))
  if (u_finish_mode == 1) { o = vec4(c, float(code)); return; }
  o = vec4(clipOverlay(c, code), 1.0);
}
```

`clipCode`'s thresholds (`CLIP_HI = 0.992`, `CLIP_LO`, strict variants) are display-domain and stay as-is — they now correctly reflect post-finish detail loss (so lowering Whites/Highlights clears the warning, matching the recovery). Leave the doc comment updated to say it reads the finished display color.

- [ ] **Step 4: Run TS tests + typecheck**

Run: `cd app && npm test && npm run check`
Expected: PASS — uniform-mapping/`invert.ts` tests unaffected (no uniform contract change); shaders compile (GLSL is validated at runtime, so also do the GUI smoke in Step 5).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts
git commit -m "feat(gpu): mirror body/finalizer split in INVERT_FRAG + FRAG; clip overlay on finished color"
```

---

### Task 6: Bump `ENGINE_VERSION` and verify CPU/GPU parity end to end

The gain-mode highlight rendering changes above the shoulder knee, so cached thumbnails baked at the old version are stale. Bump the version (triggers background regen) and do a final parity + GUI check.

**Files:**
- Modify: `crates/film-core/src/lib.rs` (`ENGINE_VERSION` ≈ line with `pub const ENGINE_VERSION: u32 = 4;`)

**Interfaces:** none.

- [ ] **Step 1: Bump the version + history note**

In `crates/film-core/src/lib.rs`, change `ENGINE_VERSION` from `4` to `5` and append to the history doc comment:

```rust
/// 5 = Headroom tone recovery: the Faithful shoulder + look layer move from invert_d
/// to the end of finish::tone_curve, so the tone tools recover clipped highlight/shadow
/// detail on the super-white body. EV-0/slider-0 is identical except gain-mode highlights
/// above the knee (WB now precedes the rolloff); those thumbnails regenerate on entry (2026-06-25).
pub const ENGINE_VERSION: u32 = 5;
```

- [ ] **Step 2: Full Rust test suite (CPU parity)**

Run: `cargo test -p film-core -p filmrev`
Expected: PASS — all suites green, including `finish_image_matches_scalar_per_pixel*` (CPU image-vs-scalar parity).

- [ ] **Step 3: GUI smoke test (GPU↔CPU parity + recovery)**

Build and run the app (see the project `run` skill / `npm run tauri dev` in `app/`). Verify by eye:
1. Open a developed frame; with all tone sliders at 0 the image looks unchanged vs. before (default look preserved).
2. On a frame with blown highlights (bright sky/window), lower **Whites**, then **Highlights**, then **Contrast** — each should pull back genuine, increasingly-separated white detail (not just grey-down the white blob).
3. Toggle the highlight clip warning: lowering Whites/Highlights should clear the red overlay as detail returns.
4. Confirm the proxy preview and a full-res export of the same frame match (no GPU/CPU divergence).

- [ ] **Step 4: Commit**

```bash
git add crates/film-core/src/lib.rs
git commit -m "chore(engine): ENGINE_VERSION 5 — headroom tone recovery regenerates thumbnails"
```

---

## Self-Review

- **Spec coverage:** body-core/display split (Tasks 1-2), finalizer in `tone_curve` + per-zone clamp relax (Task 3), display-path routing + retired recovery (Task 4), GPU mirror + clip overlay (Task 5), ENGINE_VERSION + parity/GUI (Task 6). Gain-mode caveat is encoded in the identity test's frame choice (Task 4 Step 1). All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows real code; tests have concrete assertions.
- **Type consistency:** `invert_d_core`/`invert_image_core`/`display_finalize`/`gamma_body`/`shoulder_only` names are used consistently across Tasks 1-5; GLSL `gammaBody`/`shoulderOnly`/`lookS`/`displayFinalize` mirror them.
- **Known soft spots for the implementer:** (a) reuse existing test helpers in each crate rather than the placeholder names `faithful_params`/`test_negative`/`default_invert_params` if the real ones differ; (b) the gain-mode identity test must use a mid-key frame so the strict tolerance holds.
