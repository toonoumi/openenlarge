# Negadoctor (Cineon) Inversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kodak-Cineon (darktable `negadoctor`) color-negative inversion as a new, live-toggleable `Mode::D`, so it can be A/B'd against the current `density^gamma` model on real scans without changing any existing path.

**Architecture:** Port negadoctor's per-channel math into `film-core` as `invert_d`, mirror it exactly in the WebGL2 `INVERT_FRAG` shader, and thread five new params (`d_max`, `print_exposure`, `paper_black`, `paper_grade`, `soft_clip`) through the CPU→GPU bridge. WB reuses the existing temp/tint gain, injected as a log-space offset. The new mode is selectable in the develop UI; everything else (base sampling, stocks, auto-WB, finishing) is untouched.

**Tech Stack:** Rust (`film-core`, Tauri backend, `nalgebra`, `rayon`), TypeScript + Svelte + WebGL2 (frontend), `vitest`, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-07-negadoctor-inversion-design.md`

---

## File Structure

- `crates/film-core/src/engine.rs` — `Mode::D`, new `InversionParams` fields + `Default`, `invert_d`, `invert_image` dispatch, unit tests. **Source of truth for the math.**
- `app/src-tauri/src/commands.rs` — `mode_from` (`"d"`), `build_params` (Mode D arm).
- `app/src-tauri/src/gpu_upload.rs` — `ResolvedInversion` fields + `resolve_to_uniforms` (`Mode::D → 3`), tests.
- `app/src/lib/viewport/gl/shaders.ts` — `INVERT_FRAG`: new uniforms + `u_mode == 3` branch mirroring `invert_d`.
- `app/src/lib/viewport/gl/invert.ts` — TS `ResolvedInversion` + `InversionUniforms` + `toInversionUniforms`.
- `app/src/lib/viewport/gl/invert.test.ts` — extend the round-trip test.
- `app/src/lib/viewport/gl/renderer.ts` — uniform name list + `gl.uniform1f` setters.
- `app/src/lib/api.ts` — `InvertParams.mode` union adds `"d"`.
- `app/src/lib/develop/Basic.svelte` — inversion-mode `<select>` (Density vs Cineon).
- `crates/film-core/examples/invert_d_png.rs` — CREATE: validation harness (decode → invert_d → PNG).

**Intentional omission:** the spec lists `app/src-tauri/src/session.rs` (`InvertParams`) as a possible touch point for new per-knob slider fields. This minimal cut adds **no UI sliders** — Mode D's `d_max`/`paper_*`/`soft_clip` come from `InversionParams::Default`, and `print_exposure` reuses the existing exposure slider. So `session.rs` is **not** modified here. Tunable sliders (which would add `#[serde(default)]` fields to `InvertParams` in `session.rs` + `api.ts` + `Basic.svelte`) are a deliberate follow-up after the defaults are dialed in during validation.

**WIP guard:** the working tree has uncommitted user WIP in several `app/src-tauri/*` files and `engine.rs`. Edit surgically (targeted `Edit`s only); never `git checkout` these files.

---

## Task 1: `invert_d` + `Mode::D` + new params (film-core, CPU)

**Files:**
- Modify: `crates/film-core/src/engine.rs` (`InversionParams`, `Default`, `Mode`, `invert_image`, add `invert_d`)
- Test: `crates/film-core/src/engine.rs` (`mod tests`)

- [ ] **Step 1: Add the five new fields to `InversionParams`**

In `crates/film-core/src/engine.rs`, inside `pub struct InversionParams { ... }`, after the `wb` field (currently the last field, ~line 26), add:

```rust
    /// Cineon (Mode D) — scalar white / dynamic-range anchor (D_max).
    pub d_max: f32,
    /// Cineon (Mode D) — print exposure (ASC-CDL slope).
    pub print_exposure: f32,
    /// Cineon (Mode D) — paper black (ASC-CDL offset).
    pub paper_black: f32,
    /// Cineon (Mode D) — paper grade (ASC-CDL power; also the display encode).
    pub paper_grade: f32,
    /// Cineon (Mode D) — highlight soft-clip threshold.
    pub soft_clip: f32,
```

- [ ] **Step 2: Add their defaults**

In the `impl Default for InversionParams`, inside the returned struct literal, after `wb: [1.0, 1.0, 1.0],` add:

```rust
            d_max: 2.0,
            print_exposure: 1.0,
            paper_black: 0.0,
            paper_grade: 0.5,
            soft_clip: 0.9,
```

- [ ] **Step 3: Add `Mode::D`**

In `pub enum Mode { ... }`, after `Naive,` add:

```rust
    /// Kodak Cineon densitometry (darktable negadoctor).
    D,
```

- [ ] **Step 4: Write the failing tests**

In `crates/film-core/src/engine.rs`'s `mod tests`, add:

```rust
    #[test]
    fn mode_d_base_pixel_is_black() {
        // I == Dmin → log_dens 0 → ten_to_x 1 → print_lin = pe*(1+pb) - pe = pe*pb = 0.
        let p = InversionParams {
            base: [0.7, 0.6, 0.5],
            ..Default::default()
        };
        let out = invert_d([0.7, 0.6, 0.5], &p);
        for (c, &v) in out.iter().enumerate() {
            assert!(v.abs() < 1e-4, "ch {c} = {v}");
        }
    }

    #[test]
    fn mode_d_darker_negative_is_brighter_positive() {
        // A denser negative (lower transmission) = brighter scene = brighter positive.
        let p = InversionParams {
            base: [1.0, 1.0, 1.0],
            ..Default::default()
        };
        let dim = invert_d([0.5, 0.5, 0.5], &p);
        let bright = invert_d([0.1, 0.1, 0.1], &p);
        assert!(bright[0] > dim[0], "denser neg should be brighter: {bright:?} vs {dim:?}");
    }

    #[test]
    fn mode_d_recovers_neutrals_as_neutral() {
        // base*10^(-k*scene) for a neutral scene must invert back to neutral (wb=1).
        let base = [0.8, 0.55, 0.35];
        let k = 0.6;
        let p = InversionParams { base, ..Default::default() };
        for g in [0.2f32, 0.5, 0.8] {
            let neg = [
                base[0] * 10f32.powf(-k * g),
                base[1] * 10f32.powf(-k * g),
                base[2] * 10f32.powf(-k * g),
            ];
            let out = invert_d(neg, &p);
            let max = out.iter().cloned().fold(f32::MIN, f32::max);
            let min = out.iter().cloned().fold(f32::MAX, f32::min);
            assert!(max - min < 1e-3, "non-neutral recovery at g={g}: {out:?}");
        }
    }

    #[test]
    fn mode_d_wb_gain_brightens_channel() {
        // wb[c] > 1 must BRIGHTEN channel c in the positive (matches B/C convention),
        // even though WB is injected as a log-space offset on the negative side.
        let base = [0.7, 0.6, 0.5];
        let probe = [0.3, 0.25, 0.2];
        let neutral = InversionParams { base, ..Default::default() };
        let warmed = InversionParams { base, wb: [1.5, 1.0, 1.0], ..Default::default() };
        let a = invert_d(probe, &neutral);
        let b = invert_d(probe, &warmed);
        assert!(b[0] > a[0], "R wb 1.5 should brighten R: {} vs {}", b[0], a[0]);
        assert!((b[1] - a[1]).abs() < 1e-6, "G unchanged");
    }
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cargo test -p film-core mode_d`
Expected: FAIL — `cannot find function invert_d` / `no variant D`.

- [ ] **Step 6: Implement `invert_d`**

In `crates/film-core/src/engine.rs`, after `invert_b` (~line 98), add:

```rust
/// Mode D: Kodak Cineon densitometry (darktable negadoctor). Per channel:
/// restore the negative's density in log space, balance via a log-space WB offset,
/// return to linear, then apply a paper inversion + tone curve with a highlight
/// soft-clip. See docs/superpowers/specs/2026-06-07-negadoctor-inversion-design.md.
pub fn invert_d(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    const THRESHOLD: f32 = 2.328_306_4e-10; // negadoctor's -32 EV floor
    std::array::from_fn(|c| {
        let clamped = rgb[c].max(THRESHOLD);
        let dmin = p.base[c].max(EPS);
        let log_dens = (clamped / dmin).log10(); // = -log10(dmin/clamped)
        // WB as a log-space offset; the NEGATIVE sign keeps wb>1 brightening the
        // positive (the offset acts on the negative side, before paper inversion).
        let offset = -p.wb[c].max(EPS).log10();
        let corrected = log_dens / p.d_max.max(EPS) + offset;
        let ten_to_x = 10f32.powf(corrected);
        let print_lin =
            (p.print_exposure * (1.0 + p.paper_black) - p.print_exposure * ten_to_x).max(0.0);
        let out = print_lin.powf(p.paper_grade);
        if out > p.soft_clip {
            let comp = (1.0 - p.soft_clip).max(EPS);
            p.soft_clip + (1.0 - (-(out - p.soft_clip) / comp).exp()) * comp
        } else {
            out
        }
    })
}
```

- [ ] **Step 7: Add the dispatch arm**

In `invert_image`, in the `let f = match mode { ... }`, add the arm:

```rust
        Mode::D => invert_d,
```

(Place it after `Mode::Naive => invert_naive,`.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cargo test -p film-core`
Expected: PASS — all `mode_d_*` tests green, plus the existing 81.

- [ ] **Step 9: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): add Mode::D negadoctor (Cineon) inversion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend wiring — `mode_from`, `build_params`, GPU bridge

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`mode_from`, `build_params`)
- Modify: `app/src-tauri/src/gpu_upload.rs` (`ResolvedInversion`, `resolve_to_uniforms`)
- Test: `app/src-tauri/src/gpu_upload.rs` (`mod tests`)

- [ ] **Step 1: Map `"d"` to `Mode::D`**

In `app/src-tauri/src/commands.rs`, in `pub(crate) fn mode_from`, change:

```rust
pub(crate) fn mode_from(s: &str) -> Mode {
    match s {
        "c" => Mode::C,
        "d" => Mode::D,
        _ => Mode::B,
    }
}
```

- [ ] **Step 2: Add the Mode D arm to `build_params`**

In `app/src-tauri/src/commands.rs`, in `build_params`, replace the `match stock_from(&p.stock) { ... }` body so Mode D is handled first (it ignores stock and reuses the EV exposure as `print_exposure`):

```rust
pub(crate) fn build_params(p: &InvertParams, base: [f32; 3]) -> InversionParams {
    let exposure = 2f32.powf(p.exposure); // EV stops → linear multiplier
    if p.mode == "d" {
        // Cineon: reuse the exposure slider as print exposure; d_max/paper_* come
        // from InversionParams::Default. WB is set later by the caller.
        return InversionParams {
            base,
            print_exposure: exposure,
            ..Default::default()
        };
    }
    match stock_from(&p.stock) {
        Some(s) if p.mode == "b" => params_for_stock(s, base, exposure, p.black, p.gamma),
        _ => InversionParams {
            base,
            exposure,
            black: p.black,
            gamma: p.gamma,
            ..Default::default()
        },
    }
}
```

- [ ] **Step 3: Write the failing GPU-bridge test**

In `app/src-tauri/src/gpu_upload.rs`'s `mod tests`, add:

```rust
    #[test]
    fn uniforms_mode_d_maps_to_3_with_cineon_defaults() {
        let mut p = sample_invert_params();
        p.stock = "none".into();
        p.mode = "d".into();
        p.exposure = 0.0; // 2^0 = 1.0 print exposure
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.mode, 3, "d → 3");
        assert_eq!(u.base, [0.8, 0.6, 0.4]);
        assert!((u.d_max - 2.0).abs() < 1e-6);
        assert!((u.print_exposure - 1.0).abs() < 1e-6);
        assert!((u.paper_grade - 0.5).abs() < 1e-6);
        assert!((u.soft_clip - 0.9).abs() < 1e-6);
    }
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml uniforms_mode_d`
Expected: FAIL — `no field d_max on ResolvedInversion` / `u.mode` is not 3.

- [ ] **Step 5: Add the fields to `ResolvedInversion`**

In `app/src-tauri/src/gpu_upload.rs`, in `pub struct ResolvedInversion { ... }`, after `pub gamma: f32,` add:

```rust
    pub d_max: f32,
    pub print_exposure: f32,
    pub paper_black: f32,
    pub paper_grade: f32,
    pub soft_clip: f32,
```

- [ ] **Step 6: Populate them + map Mode::D → 3 in `resolve_to_uniforms`**

In `resolve_to_uniforms`, in the `let mode = match mode_from(&p.mode) { ... }`, add `Mode::D => 3,` (after `Mode::Naive => 2,`). Then in the returned `ResolvedInversion { ... }`, after `gamma: ip.gamma,` add:

```rust
        d_max: ip.d_max,
        print_exposure: ip.print_exposure,
        paper_black: ip.paper_black,
        paper_grade: ip.paper_grade,
        soft_clip: ip.soft_clip,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS — `uniforms_mode_d_*` green, existing tests still green.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs
git commit -m "feat(backend): wire Mode::D params through the GPU bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: GPU shader parity + TS uniform plumbing

**Files:**
- Modify: `app/src/lib/viewport/gl/invert.ts` (`ResolvedInversion`, `InversionUniforms`, `toInversionUniforms`)
- Test: `app/src/lib/viewport/gl/invert.test.ts`
- Modify: `app/src/lib/viewport/gl/shaders.ts` (`INVERT_FRAG`)
- Modify: `app/src/lib/viewport/gl/renderer.ts` (uniform list + setters)

- [ ] **Step 1: Extend the failing TS test**

In `app/src/lib/viewport/gl/invert.test.ts`, add the new fields to the `RES` literal (after `mode: 0,`):

```typescript
  d_max: 2.0,
  print_exposure: 1.0,
  paper_black: 0.0,
  paper_grade: 0.5,
  soft_clip: 0.9,
```

And add assertions inside the existing `it(...)`:

```typescript
    expect(u.d_max).toBeCloseTo(2.0);
    expect(u.print_exposure).toBeCloseTo(1.0);
    expect(u.paper_grade).toBeCloseTo(0.5);
    expect(u.soft_clip).toBeCloseTo(0.9);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app && npx vitest run src/lib/viewport/gl/invert.test.ts`
Expected: FAIL — type error / `u.d_max` is `undefined`.

- [ ] **Step 3: Add the fields to the TS interfaces + mapper**

In `app/src/lib/viewport/gl/invert.ts`: in `ResolvedInversion`, after `mode: number;` add:

```typescript
  d_max: number;
  print_exposure: number;
  paper_black: number;
  paper_grade: number;
  soft_clip: number;
```

In `InversionUniforms`, after `mode: number;` add the same five lines. In `toInversionUniforms`, after `mode: r.mode,` add:

```typescript
    d_max: r.d_max,
    print_exposure: r.print_exposure,
    paper_black: r.paper_black,
    paper_grade: r.paper_grade,
    soft_clip: r.soft_clip,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/lib/viewport/gl/invert.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the shader uniforms + Mode D branch**

In `app/src/lib/viewport/gl/shaders.ts`, in `INVERT_FRAG`, after the line `uniform float u_exposure, u_black, u_gamma;` add:

```glsl
uniform float u_d_max, u_print_exposure, u_paper_black, u_paper_grade, u_soft_clip;
```

Then inside `vec3 invert(vec3 rgbIn) { ... }`, immediately after the `r` is computed (after the `clamp(...)` block ending `EPS, 1.0);`) and BEFORE the `if (u_mode == 2)` block, add the Mode D branch:

```glsl
  if (u_mode == 3) {           // Mode D: negadoctor (Cineon). Mirrors engine.rs invert_d.
    const float THRESH = 2.3283064e-10;
    vec3 clamped = max(rgbIn, vec3(THRESH));
    vec3 dmin = max(u_base, vec3(EPS));
    vec3 log_dens = log2(clamped / dmin) * LOG10;          // log10(clamped/dmin)
    vec3 offset = log2(max(u_wb, vec3(EPS))) * (-LOG10);   // -log10(wb)
    vec3 corrected = log_dens / max(u_d_max, EPS) + offset;
    vec3 ten = exp2(corrected / LOG10);                    // 10^corrected
    vec3 print_lin = max(
      vec3(u_print_exposure * (1.0 + u_paper_black)) - u_print_exposure * ten, vec3(0.0));
    vec3 outc = pow(print_lin, vec3(u_paper_grade));
    float comp = max(1.0 - u_soft_clip, EPS);
    vec3 over = u_soft_clip + (1.0 - exp(-(outc - vec3(u_soft_clip)) / comp)) * comp;
    return mix(outc, over, step(vec3(u_soft_clip), outc));  // soft-clip where outc >= soft_clip
  }
```

(Note: `rgbIn` here is the raw negative sample, the same input `r` is derived from — Mode D clamps it independently with `THRESH`, like `invert_d`.)

- [ ] **Step 6: Register + set the uniforms in the renderer**

In `app/src/lib/viewport/gl/renderer.ts`, in the uniform-name array (~line 150-153), add the five names to the list:

```typescript
      "u_d_max","u_print_exposure","u_paper_black","u_paper_grade","u_soft_clip",
```

Then in the INVERT-pass uniform-setting block (after `gl.uniform1f(L.u_gamma, u.gamma); gl.uniform1i(L.u_mode, u.mode);`, ~line 278) add:

```typescript
    gl.uniform1f(L.u_d_max, u.d_max); gl.uniform1f(L.u_print_exposure, u.print_exposure);
    gl.uniform1f(L.u_paper_black, u.paper_black); gl.uniform1f(L.u_paper_grade, u.paper_grade);
    gl.uniform1f(L.u_soft_clip, u.soft_clip);
```

- [ ] **Step 7: Verify the frontend builds + checks clean**

Run: `cd app && npx vitest run src/lib/viewport/gl/ && npm run check`
Expected: PASS — vitest green, `npm run check` reports 0 errors.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/viewport/gl/invert.ts app/src/lib/viewport/gl/invert.test.ts app/src/lib/viewport/gl/shaders.ts app/src/lib/viewport/gl/renderer.ts
git commit -m "feat(gpu): mirror Mode::D negadoctor in INVERT_FRAG + uniforms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: UI mode toggle (Density vs Cineon)

**Files:**
- Modify: `app/src/lib/api.ts` (`InvertParams.mode` union)
- Modify: `app/src/lib/develop/Basic.svelte` (mode `<select>`)

- [ ] **Step 1: Widen the `mode` union**

In `app/src/lib/api.ts`, change `mode: "b" | "c";` to:

```typescript
  mode: "b" | "c" | "d";
```

- [ ] **Step 2: Add the mode select to the develop panel**

In `app/src/lib/develop/Basic.svelte`, immediately after the film-profile `</select>` (line 125) and before the `<!-- Film Base (collapsible) -->` comment, add:

```svelte
      <!-- Inversion engine (A/B): density^gamma vs Cineon/negadoctor -->
      <select bind:value={$params.mode} style="margin-top:8px">
        <option value="b">Density (default)</option>
        <option value="d">Cineon (beta)</option>
      </select>
```

(`$params.mode` is the same store the rest of the panel binds; switching it re-renders live.)

- [ ] **Step 3: Verify the build + check**

Run: `cd app && npm run check`
Expected: PASS — 0 errors (the `"d"` literal now type-checks against the widened union).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/develop/Basic.svelte
git commit -m "feat(ui): add Density/Cineon inversion-engine toggle for live A/B

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Multi-roll validation harness (rule #1)

**Files:**
- Create: `crates/film-core/examples/invert_d_png.rs`

- [ ] **Step 1: Write the example harness**

Create `crates/film-core/examples/invert_d_png.rs`:

```rust
//! Validation harness: decode a scan, run Mode B and Mode D, write side-by-side PNGs.
//! Usage: cargo run -p film-core --example invert_d_png -- <scan...>
//! Look at the PNGs across SEVERAL rolls; do not trust region stats.

use film_core::calibrate::sample_base;
use film_core::decode::{decode_ldr, decode_raw, decode_tiff};
use film_core::engine::{invert_image, InversionParams, Mode};
use std::path::Path;

/// Mirror commands.rs::decode_any's extension dispatch (which is private there).
fn decode_any(path: &Path) -> film_core::Image {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let r = match ext.as_str() {
        "tif" | "tiff" => decode_tiff(path),
        "jpg" | "jpeg" | "png" => decode_ldr(path),
        _ => decode_raw(path),
    };
    r.unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
}

fn encode(img: &film_core::Image, path: &str) {
    let mut buf = vec![0u8; img.width * img.height * 3];
    for (i, px) in img.pixels.iter().enumerate() {
        for c in 0..3 {
            buf[i * 3 + c] = (px[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    image::save_buffer(
        path,
        &buf,
        img.width as u32,
        img.height as u32,
        image::ColorType::Rgb8,
    )
    .expect("write png");
    eprintln!("wrote {path}");
}

fn main() {
    for path in std::env::args().skip(1) {
        let full = decode_any(Path::new(&path));
        let base = sample_base(&full, None);
        eprintln!("{path}: base = {base:?}");
        let stem = std::path::Path::new(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("scan");

        let pb = InversionParams { base, ..Default::default() };
        encode(&invert_image(&full, &pb, Mode::B), &format!("/tmp/{stem}_B.png"));

        let pd = InversionParams { base, ..Default::default() };
        encode(&invert_image(&full, &pd, Mode::D), &format!("/tmp/{stem}_D.png"));
    }
}
```

- [ ] **Step 2: Confirm the public decode fns + `image` crate are reachable**

The harness deliberately re-implements `decode_any`'s extension dispatch locally, because the real one is a private fn in `commands.rs` (the backend), not in `film-core`. The pieces it relies on are confirmed present: `decode_tiff` / `decode_raw` / `decode_ldr` are `pub` in `crates/film-core/src/decode.rs`, and `image` is a normal dependency in `crates/film-core/Cargo.toml` (available to examples). Re-confirm before building:

Run: `grep -n "pub fn decode_tiff\|pub fn decode_raw\|pub fn decode_ldr" crates/film-core/src/decode.rs; grep -n "^image" crates/film-core/Cargo.toml`
Expected: all three decode fns are `pub`; `image` is listed. If `image::save_buffer`/`ColorType` fail to resolve (version skew), swap `encode` for this binary-PPM (P6) writer, which needs no external crate:

```rust
fn encode(img: &film_core::Image, path: &str) {
    use std::io::Write;
    let path = path.replace(".png", ".ppm");
    let mut f = std::fs::File::create(&path).expect("create");
    write!(f, "P6\n{} {}\n255\n", img.width, img.height).unwrap();
    let mut buf = Vec::with_capacity(img.width * img.height * 3);
    for px in &img.pixels {
        for c in 0..3 { buf.push((px[c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8); }
    }
    f.write_all(&buf).unwrap();
    eprintln!("wrote {path}");
}
```

- [ ] **Step 3: Build the example**

Run: `cargo build -p film-core --example invert_d_png`
Expected: compiles clean.

- [ ] **Step 4: Run on ≥3–4 real rolls (manual visual check)**

Run (substitute real scans, including the blue-mailbox frame):

```bash
cargo run -p film-core --example invert_d_png -- \
  "/Volumes/Disk2/Film Scans/ny2026-3/Image 4 (3).dng" \
  <scan-from-roll-2> <scan-from-roll-3> <scan-from-roll-4>
```

Open the `/tmp/*_B.png` vs `/tmp/*_D.png` pairs and compare. Expected: Mode D is not flat/gray, holds neutral on near-neutral subjects (asphalt), does not go dark/coffee across rolls, and survives the blue-dominated frame without crushing the blue to gray. **If any roll regresses, tune the starting defaults (`paper_grade`, `d_max`, `print_exposure`, `soft_clip`) in `InversionParams::Default` and re-run before proceeding — do not lock numbers to one frame.**

- [ ] **Step 5: Commit the harness**

```bash
git add crates/film-core/examples/invert_d_png.rs
git commit -m "test(film-core): add Mode B/D side-by-side validation harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Live in-app A/B (manual)**

Run the app (`cd app && npm run tauri dev` or the project's run skill). Open a developed scan, toggle the new **Density ↔ Cineon** select, and confirm: the viewport updates live, GPU (Cineon) output visually matches the CPU PNG from Step 4 for the same scan (parity), and exporting the Cineon result produces the same look. Record findings; if GPU and CPU diverge, re-check the shader against `invert_d` (likely a `10^` / `LOG10` or soft-clip mismatch).

---

## Final Verification

- [ ] `cargo test -p film-core` — green
- [ ] `cargo test --manifest-path app/src-tauri/Cargo.toml` — green
- [ ] `cargo build --manifest-path app/src-tauri/Cargo.toml` — green
- [ ] `cd app && npx vitest run src/lib/viewport/gl/ && npm run check` — green, 0 errors
- [ ] Visual A/B done on ≥3–4 rolls; Mode D does not regress (Task 5 Step 4)
- [ ] CPU/GPU parity confirmed in-app (Task 5 Step 6)
- [ ] Existing Mode B/C/stock output unchanged (the toggle defaults to "b")
