# Faithful highlight / shadow recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let lowering the Highlights/Shadows sliders recover engine-clipped white/black detail, by doing the recovery inside the inversion pass (before the Faithful shoulder/toe compress and the clamp) instead of in the post-clamp finish pass.

**Architecture:** The negative half of Highlights → `hi_recovery ∈ [0,1]`, negative Shadows → `lo_recovery ∈ [0,1]`. `hi_recovery` widens `gamma_shoulder`'s rolloff scale (gentler shoulder re-separates crushed highlights); `lo_recovery` softens `look_s`'s toe contrast (re-separates crushed shadows). Both default to 0 (pixel-exact to today). The CPU engine (`engine.rs`) and the GPU shader (`shaders.ts`) stay verbatim mirrors. The finish pass only sees the positive half of those two sliders, so a slider never darkens and recovers at once.

**Tech Stack:** Rust (`film-core` engine + Tauri `src-tauri`), TypeScript + WebGL2 (`app/src`), cargo test, vitest.

## Global Constraints

- **`engine.rs` and `shaders.ts` INVERT_FRAG are verbatim mirrors.** Any constant or formula added to one MUST be added identically to the other (`REC_H_GAIN`, `REC_S_GAIN`, the widened `gamma_shoulder`, the softened `look_s`).
- **Faithful is the sole develop path** (Filmic dormant). Only the Faithful branch of `invert_d` / INVERT_FRAG is touched.
- **Recovery is SDR-only.** The HDR path already expands highlights via `HDR_HEADROOM`; pass `hi_recovery = 0` and skip `look_s` when `p.hdr`.
- **Identity at 0 is a hard regression guard.** `hi_recovery = lo_recovery = 0` must reproduce current output exactly (≤ 1e-6).
- **Recovery amounts are derived, never persisted.** `hi_recovery = clamp(−highlights/100, 0, 1)`, `lo_recovery = clamp(−shadows/100, 0, 1)`. No new session/UI field.
- **Tuning constants** `REC_H_GAIN = 3.0`, `REC_S_GAIN = 0.6` are initial visual-tuning values (Faithful tone is an aesthetic target — see the `faithful-exposure-hue-stable` memory). They may be retuned by eye during the manual GUI smoke; keep the two files in sync.

---

### Task 1: Engine recovery math (`film-core`)

**Files:**
- Modify: `crates/film-core/src/engine.rs` (InversionParams struct ~34-71 + Default ~73-94; constants ~136-138; `look_s` ~146-149; `gamma_shoulder` ~211-220; Faithful branch of `invert_d` ~346-358; existing `look_s` test callers ~1263+)
- Test: same file's `#[cfg(test)] mod tests` (~385)

**Interfaces:**
- Produces: `InversionParams { hi_recovery: f32, lo_recovery: f32, .. }` (default `0.0`); `fn gamma_shoulder(x: f32, ceil: f32, hi_recovery: f32) -> f32`; `fn look_s(v: f32, lo_recovery: f32) -> f32`. `invert_d` honors `p.hi_recovery`/`p.lo_recovery` on the SDR Faithful path.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `crates/film-core/src/engine.rs`:

```rust
#[test]
fn gamma_shoulder_identity_at_zero_recovery() {
    for i in 0..=200 {
        let x = i as f32 / 50.0; // 0..4
        let got = gamma_shoulder(x, 1.0, 0.0);
        let raw = x.max(0.0).powf(1.0 / FAITHFUL_GAMMA);
        let k = FAITHFUL_KNEE;
        let want = if raw <= k { raw.min(1.0) }
                   else { k + (1.0 - k) * (1.0 - (-(raw - k) / (1.0 - k)).exp()) };
        assert!((got - want).abs() < 1e-6, "x={x} got={got} want={want}");
    }
}

#[test]
fn look_s_identity_at_zero_recovery() {
    for i in 0..=100 {
        let v = i as f32 / 100.0;
        let got = look_s(v, 0.0);
        let t = (LOOK_K * 0.5).tanh();
        let want = (0.5 + 0.5 * (LOOK_K * (v - 0.5)).tanh() / t).clamp(0.0, 1.0);
        assert!((got - want).abs() < 1e-6, "v={v} got={got} want={want}");
    }
}

fn faithful_params() -> InversionParams {
    InversionParams { base: [1.0, 1.0, 1.0], d_max: 1.5,
        tone_mode: ToneMode::Faithful, ..Default::default() }
}

#[test]
fn highlight_recovery_separates_crushed_highlights() {
    let p0 = faithful_params();
    let mut p1 = p0.clone(); p1.hi_recovery = 1.0;
    let a = [0.02, 0.02, 0.02]; // dense neg → bright highlight (d≈1.7)
    let b = [0.005, 0.005, 0.005]; // denser → brighter (d≈2.3)
    let sep0 = (invert_d(a, &p0)[0] - invert_d(b, &p0)[0]).abs();
    let sep1 = (invert_d(a, &p1)[0] - invert_d(b, &p1)[0]).abs();
    assert!(sep1 > sep0 + 1e-4, "recovery must separate highlights: sep0={sep0} sep1={sep1}");
}

#[test]
fn shadow_recovery_separates_crushed_shadows() {
    let p0 = faithful_params();
    let mut p1 = p0.clone(); p1.lo_recovery = 1.0;
    let a = [0.85, 0.85, 0.85]; // thin neg → deep shadow
    let b = [0.78, 0.78, 0.78];
    let sep0 = (invert_d(a, &p0)[0] - invert_d(b, &p0)[0]).abs();
    let sep1 = (invert_d(a, &p1)[0] - invert_d(b, &p1)[0]).abs();
    assert!(sep1 > sep0 + 1e-5, "recovery must separate shadows: sep0={sep0} sep1={sep1}");
}

#[test]
fn invert_d_identity_at_zero_recovery() {
    // Whole-pixel regression guard: recovery 0 == current output.
    let p = faithful_params();
    for i in 0..=100 {
        let s = (i as f32 / 100.0).max(1e-4);
        let scan = [s, s * 0.9, s * 0.8];
        let out = invert_d(scan, &p); // hi_recovery=lo_recovery=0 by default
        for c in 0..3 { assert!(out[c].is_finite() && (0.0..=1.0).contains(&out[c])); }
    }
    // (parity vs a frozen baseline is covered by the existing pinned tests;
    //  defaults are 0.0 so behavior is unchanged.)
}

#[test]
fn recovery_neutral_stays_neutral() {
    // Equal per-channel density (neutral scene, wb=1) → identical channels at any
    // recovery, because recovery is the SAME monotone remap on each channel.
    let mut p = faithful_params(); p.hi_recovery = 1.0; p.lo_recovery = 1.0;
    for i in 1..=100 {
        let s = i as f32 / 100.0;
        let out = invert_d([s, s, s], &p);
        let spread = out[0].max(out[1]).max(out[2]) - out[0].min(out[1]).min(out[2]);
        assert!(spread < 1e-6, "neutral must stay neutral at s={s}: {out:?}");
    }
}

#[test]
fn recovery_curves_monotonic_and_in_gamut() {
    let mut p = faithful_params(); p.hi_recovery = 1.0; p.lo_recovery = 1.0;
    let mut prev = -1.0;
    for i in 0..=2000 {
        // decreasing scan = increasing density = increasing output
        let s = 1.0 - i as f32 / 2000.0 * 0.999;
        let v = invert_d([s, s, s], &p)[0];
        assert!((0.0..=1.0).contains(&v), "out of gamut at s={s}: {v}");
        assert!(v >= prev - 1e-5, "non-monotonic at s={s}: {v} < {prev}");
        prev = v;
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core recovery 2>&1 | tail -20; cargo test -p film-core identity_at_zero 2>&1 | tail -20`
Expected: compile error — `gamma_shoulder`/`look_s` take the wrong number of args and `InversionParams` has no `hi_recovery`/`lo_recovery`.

- [ ] **Step 3: Add the fields, constants, and the curve math**

In `crates/film-core/src/engine.rs`, add to the `InversionParams` struct (after `pub hdr: bool,` ~line 66):

```rust
    /// Highlight recovery [0,1] (from −Highlights). Widens the Faithful shoulder
    /// rolloff to re-separate crushed highlights. SDR Faithful only; 0 = identity.
    pub hi_recovery: f32,
    /// Shadow recovery [0,1] (from −Shadows). Softens the look_s toe to re-separate
    /// crushed shadows. SDR Faithful only; 0 = identity.
    pub lo_recovery: f32,
```

Add to `Default` (after `positive: false,` ~line 91):

```rust
            hi_recovery: 0.0,
            lo_recovery: 0.0,
```

Add constants after `const LOOK_K: f32 = 2.0;` (~line 138):

```rust
/// Highlight-recovery shoulder widening: `hi_recovery∈[0,1]` multiplies the
/// gamma_shoulder rolloff scale by `(1 + REC_H_GAIN·hi_recovery)`. Gentler rolloff
/// → brightest densities sit further below the ceiling, re-separating highlights the
/// SDR shoulder crushes flat. 0 → identity. MUST equal shaders.ts REC_H_GAIN.
const REC_H_GAIN: f32 = 3.0;
/// Shadow-recovery toe softening: `lo_recovery∈[0,1]` reduces look_s's toe contrast
/// to `LOOK_K·(1 − REC_S_GAIN·lo_recovery)` (shoulder + mid-gray slope untouched),
/// re-separating shadows the tanh toe compresses. 0 → identity. MUST equal shaders.ts.
const REC_S_GAIN: f32 = 0.6;
```

Replace `look_s` (~146-149):

```rust
fn look_s(v: f32, lo_recovery: f32) -> f32 {
    // Shadow recovery softens the toe (v<0.5) via a smoothstep weight that is 1 at
    // deep shadow and 0 by mid-gray, so the shoulder and the mid-gray slope are
    // untouched (no kink). Normalisation keeps the fixed LOOK_K so white still
    // anchors to 1.0. lo_recovery=0 → the original symmetric tanh exactly.
    let s = ((0.5 - v) / 0.5).clamp(0.0, 1.0);
    let w = s * s * (3.0 - 2.0 * s); // smoothstep: 1 (v=0) → 0 (v≥0.5)
    let k = LOOK_K * (1.0 - REC_S_GAIN * lo_recovery * w);
    let t = (LOOK_K * 0.5).tanh();
    (0.5 + 0.5 * (k * (v - 0.5)).tanh() / t).clamp(0.0, 1.0)
}
```

Replace `gamma_shoulder` (~211-220):

```rust
fn gamma_shoulder(x: f32, ceil: f32, hi_recovery: f32) -> f32 {
    let raw = x.max(0.0).powf(1.0 / FAITHFUL_GAMMA);
    if raw <= FAITHFUL_KNEE {
        raw.min(ceil)
    } else {
        let k = FAITHFUL_KNEE;
        // Recovery widens the rolloff scale: hi_recovery=0 → (1−k) (current curve);
        // larger → gentler shoulder, brightest densities map further below `ceil`.
        let scale = (1.0 - k) * (1.0 + REC_H_GAIN * hi_recovery);
        k + (ceil - k) * (1.0 - (-(raw - k) / scale).exp())
    }
}
```

- [ ] **Step 4: Wire recovery into the Faithful branch of `invert_d`**

In `invert_d`, replace the Faithful `core`/`look_s` block (~346-358) with:

```rust
                // Recovery is SDR-only: HDR already expands highlights via HDR_HEADROOM.
                let hr = if p.hdr { 0.0 } else { p.hi_recovery };
                let core = match p.wb_mode {
                    WbMode::Gain => gamma_shoulder(t_eff, ceil, hr) * p.wb[c],
                    WbMode::Subtractive => {
                        gamma_shoulder(t_eff * p.wb[c].max(EPS).powf(CMY_STRENGTH), ceil, hr)
                    }
                };
                // Look layer (clean-punchy S-curve), SDR only; shadow recovery softens
                // its toe. HDR keeps the headroom-expanded value (no look layer).
                if p.hdr {
                    core
                } else {
                    look_s(core, p.lo_recovery)
                }
```

Then fix the existing `look_s` test callers (search the file for `look_s(` in `mod tests`, ~1263+) to pass the new arg, e.g. `look_s(x)` → `look_s(x, 0.0)`. These existing tests must still pass unchanged (they assert the identity curve).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p film-core 2>&1 | tail -25`
Expected: PASS — new recovery tests pass, all pre-existing `look_s_*`/Faithful pinned tests still pass.

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): Faithful highlight/shadow recovery in the inversion pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rust orchestration — derive recovery, pass to GPU uniforms, suppress finish negative half

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`build_params` ~252-268; `finish_from` ~531-535)
- Modify: `app/src-tauri/src/gpu_upload.rs` (`ResolvedInversion` struct ~169-191; `resolve_to_uniforms` ~206-227)
- Test: `app/src-tauri/src/commands.rs` `mod tests`

**Interfaces:**
- Consumes: `InversionParams { hi_recovery, lo_recovery }` from Task 1.
- Produces: `build_params` sets `ip.hi_recovery`/`ip.lo_recovery`; `ResolvedInversion { hi_recovery: f32, lo_recovery: f32, .. }` (serde JSON to the frontend); `finish_from` clamps `highlights`/`shadows` to `≥ 0`.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `app/src-tauri/src/commands.rs`:

```rust
#[test]
fn build_params_derives_recovery_from_negative_sliders() {
    let mut p = crate::commands_test_support::sample_invert_params();
    p.highlights = -100.0; p.shadows = -50.0;
    let ip = build_params(&p, [0.8, 0.6, 0.4]);
    assert!((ip.hi_recovery - 1.0).abs() < 1e-6, "hi_recovery={}", ip.hi_recovery);
    assert!((ip.lo_recovery - 0.5).abs() < 1e-6, "lo_recovery={}", ip.lo_recovery);

    p.highlights = 40.0; p.shadows = 0.0; // positive/zero → no recovery
    let ip2 = build_params(&p, [0.8, 0.6, 0.4]);
    assert_eq!(ip2.hi_recovery, 0.0);
    assert_eq!(ip2.lo_recovery, 0.0);
}

#[test]
fn finish_from_suppresses_negative_highlights_shadows() {
    let mut p = crate::commands_test_support::sample_invert_params();
    p.highlights = -100.0; p.shadows = -100.0;
    let f = finish_from(&p);
    assert_eq!(f.highlights, 0.0, "negative Highlights is engine recovery, not a finish move");
    assert_eq!(f.shadows, 0.0);

    p.highlights = 50.0; // positive half unchanged
    assert!((finish_from(&p).highlights - 0.5).abs() < 1e-6);
}
```

Add to `mod tests` in `app/src-tauri/src/gpu_upload.rs`:

```rust
#[test]
fn resolve_to_uniforms_carries_recovery() {
    let mut p = crate::commands_test_support::sample_invert_params();
    p.highlights = -100.0; p.shadows = -25.0;
    let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
    assert!((u.hi_recovery - 1.0).abs() < 1e-6);
    assert!((u.lo_recovery - 0.25).abs() < 1e-6);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p app recovery 2>&1 | tail -20` (or the crate name in `app/src-tauri/Cargo.toml`)
Expected: compile error — `ResolvedInversion` has no `hi_recovery`/`lo_recovery`; `build_params` doesn't set them.

- [ ] **Step 3: Derive recovery in `build_params`**

In `app/src-tauri/src/commands.rs`, add to the `InversionParams { .. }` literal in `build_params` (before `..Default::default()`, ~265):

```rust
        // Negative Highlights/Shadows drive engine-side recovery (the positive half
        // stays a finish-pass tone move, see finish_from). −100 → full recovery.
        hi_recovery: (-p.highlights / 100.0).clamp(0.0, 1.0),
        lo_recovery: (-p.shadows / 100.0).clamp(0.0, 1.0),
```

- [ ] **Step 4: Clamp the finish negative half**

In `finish_from` (~531-535), replace the `highlights`/`shadows` lines:

```rust
        // Negative half is engine recovery (build_params); finish only sees the
        // positive half so the slider never darkens AND recovers at once.
        highlights: (p.highlights / 100.0).max(0.0),
        shadows: (p.shadows / 100.0).max(0.0),
```

- [ ] **Step 5: Add the fields to `ResolvedInversion` and populate them**

In `app/src-tauri/src/gpu_upload.rs`, add to the `ResolvedInversion` struct (after `pub tone_mode: u8,` ~190):

```rust
    /// Highlight/shadow recovery [0,1] for the SDR Faithful shoulder/toe. Mirrors
    /// InversionParams.hi_recovery/lo_recovery; consumed by INVERT_FRAG.
    pub hi_recovery: f32,
    pub lo_recovery: f32,
```

In `resolve_to_uniforms`, add to the returned literal (after `tone_mode: 1u8,` ~226). `ip` is `build_params(p, base)` so the values are already derived:

```rust
        hi_recovery: ip.hi_recovery,
        lo_recovery: ip.lo_recovery,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p film-core && cargo test --manifest-path app/src-tauri/Cargo.toml 2>&1 | tail -25`
Expected: PASS, including the new recovery tests and all pre-existing `build_params_*` / `resolve_to_uniforms` tests.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs
git commit -m "feat(develop): derive hi/lo recovery from Highlights/Shadows, route to uniforms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: GPU mirror — shader curves, uniform plumbing, finish clamp

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (INVERT_FRAG uniform block ~395; consts ~430; `lookS` ~433-435; `gammaShoulder` ~436-441; Faithful callers ~523-528)
- Modify: `app/src/lib/viewport/gl/invert.ts` (`ResolvedInversion` ~2-19; `InversionUniforms` ~22-39; `toInversionUniforms` ~41-60)
- Modify: `app/src/lib/viewport/gl/renderer.ts` (uniform-name list ~170-171; `drawInvertPass` set ~384)
- Modify: `app/src/lib/viewport/gl/uniforms.ts` (`finishUniforms` ~11-22)
- Test: `app/src/lib/viewport/gl/invert.test.ts`

**Interfaces:**
- Consumes: `ResolvedInversion { hi_recovery, lo_recovery }` JSON from Task 2.
- Produces: `InversionUniforms { hi_recovery: number, lo_recovery: number }`; INVERT_FRAG honoring `u_hi_recovery`/`u_lo_recovery`; `finishUniforms` clamping `highlights`/`shadows` to `≥ 0`.

- [ ] **Step 1: Write the failing test**

In `app/src/lib/viewport/gl/invert.test.ts`, add `hi_recovery`/`lo_recovery` to the `RES` fixture (after `tone_mode: 1,` ~20) and to the `base` fixture in the "positive flag" block (~28) so the file type-checks:

```ts
  hi_recovery: 0.7,
  lo_recovery: 0.3,
```
(For the `base` fixture use `hi_recovery: 0, lo_recovery: 0,`.)

Add a test inside `describe("toInversionUniforms", ...)`:

```ts
  it("passes hi/lo recovery through", () => {
    const u = toInversionUniforms(RES);
    expect(u.hi_recovery).toBeCloseTo(0.7);
    expect(u.lo_recovery).toBeCloseTo(0.3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/viewport/gl/invert.test.ts 2>&1 | tail -20`
Expected: FAIL — `ResolvedInversion`/`InversionUniforms` have no `hi_recovery`/`lo_recovery` (type error) and `u.hi_recovery` is undefined.

- [ ] **Step 3: Add the fields to the TS types and pass-through**

In `app/src/lib/viewport/gl/invert.ts`, add to `ResolvedInversion` (after `tone_mode: number;` ~18):

```ts
  hi_recovery: number; // [0,1] highlight recovery (SDR Faithful shoulder widening)
  lo_recovery: number; // [0,1] shadow recovery (SDR Faithful toe softening)
```

Add the same two lines to `InversionUniforms` (after `tone_mode: number;` ~38). Add to `toInversionUniforms` returned object (after `tone_mode: 1,` ~58):

```ts
    hi_recovery: r.hi_recovery,
    lo_recovery: r.lo_recovery,
```

- [ ] **Step 4: Add the shader uniforms, constants, and curve math**

In `app/src/lib/viewport/gl/shaders.ts`, add to the INVERT_FRAG uniform declarations (next to `uniform float u_d_max, ...;` ~395):

```glsl
uniform float u_hi_recovery, u_lo_recovery; // [0,1] SDR Faithful highlight/shadow recovery
```

Add constants next to `const float LOOK_K = 2.0;` (~430):

```glsl
const float REC_H_GAIN = 3.0; // MUST equal engine.rs REC_H_GAIN
const float REC_S_GAIN = 0.6; // MUST equal engine.rs REC_S_GAIN
```

Replace `lookS` (~433-435) and `gammaShoulder` (~436-441):

```glsl
float lookS(float v, float lo_recovery) {
  // Shadow recovery softens the toe (v<0.5) via a smoothstep weight (1 deep-shadow
  // → 0 by mid-gray); shoulder + mid slope untouched. lo_recovery=0 → original.
  float s = clamp((0.5 - v) / 0.5, 0.0, 1.0);
  float w = s * s * (3.0 - 2.0 * s);
  float k = LOOK_K * (1.0 - REC_S_GAIN * lo_recovery * w);
  return clamp(0.5 + 0.5 * tanh(k * (v - 0.5)) / tanh(LOOK_K * 0.5), 0.0, 1.0);
}
float gammaShoulder(float x, float ceil_val, float hi_recovery) {
  float raw = pow(max(x, 0.0), 1.0 / FAITHFUL_GAMMA);
  if (raw <= FAITHFUL_KNEE) return min(raw, ceil_val);
  float k = FAITHFUL_KNEE;
  // Recovery widens the rolloff scale (hi_recovery=0 → (1−k), current curve).
  float scale = (1.0 - k) * (1.0 + REC_H_GAIN * hi_recovery);
  return k + (ceil_val - k) * (1.0 - exp(-(raw - k) / scale));
}
```

- [ ] **Step 5: Pass the uniforms into the Faithful callers**

In `shaders.ts`, update the Faithful branch (~521-528). INVERT_FRAG is always SDR (no HDR branch here), so pass the uniforms directly:

```glsl
      if (u_wb_mode == 1) {
        vec3 s = pow(max(u_wb, vec3(EPS)), vec3(CMY_STRENGTH));
        v = vec3(gammaShoulder(te.r * s.r, ceil_val, u_hi_recovery), gammaShoulder(te.g * s.g, ceil_val, u_hi_recovery), gammaShoulder(te.b * s.b, ceil_val, u_hi_recovery));
      } else {
        v = vec3(gammaShoulder(te.r, ceil_val, u_hi_recovery) * u_wb.r, gammaShoulder(te.g, ceil_val, u_hi_recovery) * u_wb.g, gammaShoulder(te.b, ceil_val, u_hi_recovery) * u_wb.b);
      }
      // Look layer (SDR; INVERT_FRAG is always SDR). Mirror: engine.rs look_s.
      v = vec3(lookS(v.r, u_lo_recovery), lookS(v.g, u_lo_recovery), lookS(v.b, u_lo_recovery));
```

- [ ] **Step 6: Register and set the uniforms in the renderer**

In `app/src/lib/viewport/gl/renderer.ts`, add `"u_hi_recovery","u_lo_recovery"` to the INVERT uniform-name list (the array containing `"u_d_max","u_print_exposure",...` ~170-171).

In `drawInvertPass`, after the line that sets `u_tone_mode` (~390), add:

```ts
    gl.uniform1f(L.u_hi_recovery, u.hi_recovery); gl.uniform1f(L.u_lo_recovery, u.lo_recovery);
```

- [ ] **Step 7: Clamp the finish negative half on the GPU side**

In `app/src/lib/viewport/gl/uniforms.ts`, replace the `highlights`/`shadows` lines in `finishUniforms` (~15-16):

```ts
    // Negative half is engine recovery (resolve_to_uniforms); finish sees only the
    // positive half. Mirrors finish_from in commands.rs.
    highlights: Math.max(0, p.highlights / 100),
    shadows: Math.max(0, p.shadows / 100),
```

- [ ] **Step 8: Run tests + type-check to verify they pass**

Run: `cd app && npx vitest run src/lib/viewport/gl/invert.test.ts 2>&1 | tail -20 && npx tsc --noEmit 2>&1 | tail -20`
Expected: PASS (recovery pass-through test green) and no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts app/src/lib/viewport/gl/invert.ts app/src/lib/viewport/gl/renderer.ts app/src/lib/viewport/gl/uniforms.ts app/src/lib/viewport/gl/invert.test.ts
git commit -m "feat(web): mirror Faithful highlight/shadow recovery in the GPU preview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Manual GUI verification + tuning

**Files:** none (verification + optional constant retune in `engine.rs` + `shaders.ts`).

- [ ] **Step 1: Build and run the app**

Run the app (use the project's run skill / `npm run tauri dev` in `app/`). Open a roll with an over-exposed frame (blown sky or specular) and a frame with crushed/blocked shadows.

- [ ] **Step 2: Verify highlight recovery**

Drag **Highlights** negative on the blown frame. Expected: blown white regions regain tonal separation/detail (not just uniform darkening). At Highlights = 0 the image is identical to before this change.

- [ ] **Step 3: Verify shadow recovery**

Drag **Shadows** negative on the crushed frame. Expected: blocked black regions regain separation; true black is not pushed to a milky grey at moderate settings.

- [ ] **Step 4: Verify no regression + parity**

Confirm positive Highlights/Shadows behave as before, and that the GPU preview matches a full-res CPU export (develop the frame and compare — the two paths share the constants).

- [ ] **Step 5: Retune if needed**

If recovery is too weak/strong or shadows go milky, adjust `REC_H_GAIN` / `REC_S_GAIN` in **both** `engine.rs` and `shaders.ts` (keep them equal), rebuild, recheck. Commit any retune:

```bash
git add crates/film-core/src/engine.rs app/src/lib/viewport/gl/shaders.ts
git commit -m "tune(develop): adjust highlight/shadow recovery strength

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Engine-side recovery, clamp only at end of inversion pass → Task 1 (`invert_d` Faithful, SDR clamp at `return clamp(...)` unchanged; recovery happens before it). ✓
- Driven by negative Highlights/Shadows, no new UI → Task 2 (`build_params` derivation), Task 3 (`finishUniforms`). ✓
- Both ends → Task 1 (`gamma_shoulder` highlights, `look_s` shadows). ✓
- Per-direction meaning / no double-action → Task 2 (`finish_from` clamp ≥0), Task 3 (`finishUniforms` clamp ≥0). ✓
- Hue stability → `recovery_neutral_stays_neutral` test (Task 1); holds by construction because neutral content has equal per-channel density so recovery is the same remap per channel. ✓
- CPU/GPU parity → constants + formulas mirrored (Task 1 vs Task 3), `resolve_to_uniforms`/`toInversionUniforms` carry the values, manual parity check (Task 4). ✓
- Tests: identity-at-0, monotonic, recovery-works, hue-stable, gamut-safe, GPU pass-through, manual smoke → covered across Tasks 1–4. ✓
- SDR-only / HDR untouched → `hr = if p.hdr {0.0}` and look_s skipped on HDR (Task 1). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; tuning constants have concrete initial values. ✓

**Type consistency:** `hi_recovery`/`lo_recovery: f32` (Rust `InversionParams` + `ResolvedInversion`) ↔ `number` (TS `ResolvedInversion`/`InversionUniforms`) ↔ `u_hi_recovery`/`u_lo_recovery` (GLSL `float`). `gamma_shoulder(x, ceil, hi_recovery)` and `look_s(v, lo_recovery)` signatures match between `engine.rs` and `shaders.ts` (`gammaShoulder`/`lookS`). ✓
