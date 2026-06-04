# Film Negative Inversion POC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Rust `film-core` library + `film-cli` that inverts a color negative scan using a density-domain (Beer-Lambert) engine, and proves its color is visibly cleaner than a naive flip on real V600 DNG / GFX RAF files.

**Architecture:** A pure, UI-free Rust library crate (`film-core`) holds all decode/engine/calibrate/export logic. A thin `film-cli` binary drives it headlessly: load → sample base → invert (mode B/C/naive) → export 16-bit TIFF. The density engine implements `Ĉ = M_post · log10(M_pre · (I₀/I))`. TDD throughout: the engine is validated against synthetic dye patches; decode/export against a synthesized 16-bit TIFF; real RAW formats validated as integration against the user's files.

**Tech Stack:** Rust (workspace), `nalgebra` (3×3 matrix math), `tiff` (TIFF read/write), `rawler` (RAF/DNG decode), `clap` (CLI), `anyhow`/`thiserror` (errors).

**Reference spec:** `docs/superpowers/specs/2026-06-03-film-inversion-poc-design.md`

---

## File Structure

```
filmrev/
├── Cargo.toml                       # workspace manifest
├── Cargo.lock                       # COMMITTED (binaries)
├── crates/
│   ├── film-core/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs               # re-exports, crate root
│   │       ├── image.rs             # Image type (f32 linear RGB + optional IR)
│   │       ├── engine.rs            # InversionParams, invert_b, invert_c, naive
│   │       ├── calibrate.rs         # sample_base()
│   │       ├── decode.rs            # decode_tiff(), decode_raw()
│   │       └── export.rs            # write_tiff16()
│   └── film-cli/
│       ├── Cargo.toml
│       └── src/main.rs              # clap CLI: `invert`
└── docs/superpowers/...
```

Each `film-core` module has one responsibility and no UI deps. The CLI is the only binary for the POC; the Tauri shell (Phase 7) reuses `film-core` unchanged.

---

## Phase 0 — Workspace scaffold

### Task 0: Create the Cargo workspace

**Files:**
- Create: `Cargo.toml`
- Create: `crates/film-core/Cargo.toml`
- Create: `crates/film-core/src/lib.rs`
- Create: `crates/film-cli/Cargo.toml`
- Create: `crates/film-cli/src/main.rs`
- Modify: `.gitignore` (un-ignore Cargo.lock)

- [ ] **Step 1: Fix .gitignore so Cargo.lock is committed**

Replace the `Cargo.lock` line. Final `.gitignore`:

```
/target
**/target
.DS_Store
/app/node_modules
/app/dist
```

- [ ] **Step 2: Write the workspace manifest**

`Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["crates/film-core", "crates/film-cli"]

[workspace.dependencies]
nalgebra = "0.33"
tiff = "0.9"
rawler = "0.6"
clap = { version = "4", features = ["derive"] }
anyhow = "1"
thiserror = "1"
```

- [ ] **Step 3: Write film-core manifest**

`crates/film-core/Cargo.toml`:

```toml
[package]
name = "film-core"
version = "0.1.0"
edition = "2021"

[dependencies]
nalgebra = { workspace = true }
tiff = { workspace = true }
rawler = { workspace = true }
thiserror = { workspace = true }
```

- [ ] **Step 4: Write film-core lib root**

`crates/film-core/src/lib.rs`:

```rust
pub mod image;
pub mod engine;
pub mod calibrate;
pub mod decode;
pub mod export;

pub use image::Image;
```

Create empty module files so it compiles:

`crates/film-core/src/image.rs`, `engine.rs`, `calibrate.rs`, `decode.rs`, `export.rs` — each containing a single line:

```rust
// implemented in a later task
```

- [ ] **Step 5: Write film-cli manifest + stub**

`crates/film-cli/Cargo.toml`:

```toml
[package]
name = "film-cli"
version = "0.1.0"
edition = "2021"

[dependencies]
film-core = { path = "../film-core" }
clap = { workspace = true }
anyhow = { workspace = true }
```

`crates/film-cli/src/main.rs`:

```rust
fn main() {
    println!("film-cli");
}
```

- [ ] **Step 6: Verify the workspace builds**

Run: `cargo build`
Expected: compiles with no errors (warnings about unused modules are fine).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold Rust workspace (film-core + film-cli)"
```

---

## Phase 1 — Image type

### Task 1: The `Image` type

**Files:**
- Modify: `crates/film-core/src/image.rs`
- Test: inline `#[cfg(test)]` in `image.rs`

- [ ] **Step 1: Write the failing test**

In `crates/film-core/src/image.rs`:

```rust
//! f32 linear-RGB image with an optional infrared plane.

/// A linear-light RGB image. `pixels` is row-major, length = width*height,
/// each pixel `[r, g, b]` in linear (not gamma) f32. `ir` (if present) is the
/// V600/SilverFast infrared plane, same length, preserved for future dust removal.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<[f32; 3]>,
    pub ir: Option<Vec<f32>>,
}

impl Image {
    pub fn new(width: usize, height: usize) -> Self {
        Image { width, height, pixels: vec![[0.0; 3]; width * height], ir: None }
    }

    pub fn len(&self) -> usize {
        self.pixels.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pixels.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_allocates_black_pixels() {
        let img = Image::new(4, 2);
        assert_eq!(img.width, 4);
        assert_eq!(img.height, 2);
        assert_eq!(img.len(), 8);
        assert_eq!(img.pixels[0], [0.0, 0.0, 0.0]);
        assert!(img.ir.is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p film-core image::`
Expected: PASS (the type and test are written together; this confirms it compiles and is correct).

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/image.rs
git commit -m "feat(core): Image type (f32 linear RGB + optional IR)"
```

---

## Phase 2 — The engine (the heart; full TDD)

### Task 2: `InversionParams` and naive inversion

**Files:**
- Modify: `crates/film-core/src/engine.rs`

- [ ] **Step 1: Write the failing test**

In `crates/film-core/src/engine.rs`:

```rust
//! Density-domain negative inversion.
//!
//! Mode B (density matrix):  Ĉ = M_post · log10(M_pre · (base / I))  then tone.
//! Mode C (naive per-chan):  per-channel log-density, no matrices.
//! Mode "naive flip":        1 - normalized, the strawman baseline.

use nalgebra::{Matrix3, Vector3};

/// All knobs for one inversion. Defaults give a reasonable neutral result.
#[derive(Debug, Clone)]
pub struct InversionParams {
    /// Per-channel film-base value (orange mask), from calibrate::sample_base.
    pub base: [f32; 3],
    /// Pre-log linear mix (sensor↔dye crosstalk). Default = identity.
    pub m_pre: Matrix3<f32>,
    /// Post-log density-space unmix. Default = identity.
    pub m_post: Matrix3<f32>,
    /// Exposure multiplier applied after unmix.
    pub exposure: f32,
    /// Black point subtracted (post-exposure), in [0,1)-ish density-output units.
    pub black: f32,
    /// Output gamma encoding exponent (sRGB-ish ~ 1/2.2 applied as power).
    pub gamma: f32,
}

impl Default for InversionParams {
    fn default() -> Self {
        InversionParams {
            base: [1.0, 1.0, 1.0],
            m_pre: Matrix3::identity(),
            m_post: Matrix3::identity(),
            exposure: 1.0,
            black: 0.0,
            gamma: 1.0 / 2.2,
        }
    }
}

const EPS: f32 = 1e-5;

/// Naive baseline: normalize against base, then invert by `1 - x`. No log, no
/// matrices. This is the strawman the density engine must beat.
pub fn invert_naive(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let norm = (rgb[c] / p.base[c].max(EPS)).clamp(0.0, 1.0);
        out[c] = 1.0 - norm;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_inverts_white_base_to_black() {
        // A pixel equal to the base (max transmission) should invert to ~black.
        let p = InversionParams { base: [0.8, 0.6, 0.4], ..Default::default() };
        let out = invert_naive([0.8, 0.6, 0.4], &p);
        for c in 0..3 {
            assert!(out[c].abs() < 1e-4, "channel {c} = {}", out[c]);
        }
    }

    #[test]
    fn naive_inverts_dark_pixel_to_bright() {
        let p = InversionParams { base: [0.8, 0.8, 0.8], ..Default::default() };
        let out = invert_naive([0.0, 0.0, 0.0], &p);
        for c in 0..3 {
            assert!((out[c] - 1.0).abs() < 1e-4, "channel {c} = {}", out[c]);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p film-core engine::`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(core): InversionParams + naive baseline inversion"
```

---

### Task 3: Mode C — per-channel log-density inversion

**Files:**
- Modify: `crates/film-core/src/engine.rs`

- [ ] **Step 1: Write the failing test**

Append to `engine.rs` (above the `#[cfg(test)]` block, add the function; inside the test module, add the test):

```rust
/// Apply exposure, black point, and output gamma to a linear density-output value.
fn tone(mut v: f32, p: &InversionParams) -> f32 {
    v = (v * p.exposure - p.black).max(0.0);
    v.powf(p.gamma)
}

/// Mode C: per-channel log-density. density = log10(base / I); higher film
/// density (less transmission) → brighter positive. Normalized by base density.
pub fn invert_c(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let t = (rgb[c] / p.base[c].max(EPS)).clamp(EPS, 1.0);
        let density = -t.log10(); // 0 at base, grows as pixel darkens
        out[c] = tone(density, p);
    }
    out
}
```

Test inside the `tests` module:

```rust
    #[test]
    fn mode_c_base_pixel_is_zero_density() {
        // gamma 1.0 to test raw density mapping
        let p = InversionParams {
            base: [0.5, 0.5, 0.5],
            gamma: 1.0,
            ..Default::default()
        };
        let out = invert_c([0.5, 0.5, 0.5], &p);
        for c in 0..3 {
            assert!(out[c].abs() < 1e-4, "channel {c} = {}", out[c]);
        }
    }

    #[test]
    fn mode_c_darker_pixel_has_higher_output() {
        let p = InversionParams { base: [1.0, 1.0, 1.0], gamma: 1.0, ..Default::default() };
        let bright = invert_c([0.5, 0.5, 0.5], &p);
        let dark = invert_c([0.1, 0.1, 0.1], &p);
        assert!(dark[0] > bright[0]);
    }
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p film-core engine::`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(core): mode C per-channel log-density inversion"
```

---

### Task 4: Mode B — density matrix inversion

**Files:**
- Modify: `crates/film-core/src/engine.rs`

- [ ] **Step 1: Write the failing test**

Add the function (above `#[cfg(test)]`):

```rust
/// Mode B: Ĉ = M_post · log10(M_pre · (base / I)), then per-channel tone.
///
/// Steps mirror the spec:
///  1. normalize r = base / I   (removes orange mask)
///  2. linear mix  M_pre · r    (sensor↔dye crosstalk; identity by default)
///  3. log10                    (into Beer-Lambert density space)
///  4. density unmix M_post     (identity by default)
///  5. tone (exposure, black, gamma)
pub fn invert_b(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    // 1. normalize: base/I in (0,1] for a darker-than-base pixel.
    let r = Vector3::new(
        (rgb[0] / p.base[0].max(EPS)).max(EPS),
        (rgb[1] / p.base[1].max(EPS)).max(EPS),
        (rgb[2] / p.base[2].max(EPS)).max(EPS),
    );
    // 2. pre-log linear mix
    let mixed = p.m_pre * r;
    // 3. log10 → density (negate so density grows as transmission drops)
    let dens = Vector3::new(
        -(mixed[0].max(EPS)).log10(),
        -(mixed[1].max(EPS)).log10(),
        -(mixed[2].max(EPS)).log10(),
    );
    // 4. density-space unmix
    let unmixed = p.m_post * dens;
    // 5. tone each channel
    [
        tone(unmixed[0], p),
        tone(unmixed[1], p),
        tone(unmixed[2], p),
    ]
}
```

Tests inside `tests`:

```rust
    #[test]
    fn mode_b_identity_matrices_match_mode_c() {
        // With identity M_pre/M_post, mode B must equal mode C exactly.
        let p = InversionParams { base: [0.7, 0.6, 0.5], gamma: 1.0, ..Default::default() };
        let probe = [0.3, 0.25, 0.2];
        let b = invert_b(probe, &p);
        let c = invert_c(probe, &p);
        for ch in 0..3 {
            assert!((b[ch] - c[ch]).abs() < 1e-5, "ch {ch}: b={} c={}", b[ch], c[ch]);
        }
    }

    #[test]
    fn mode_b_base_pixel_is_black() {
        let p = InversionParams { base: [0.7, 0.6, 0.5], gamma: 1.0, ..Default::default() };
        let out = invert_b([0.7, 0.6, 0.5], &p);
        for ch in 0..3 {
            assert!(out[ch].abs() < 1e-4, "ch {ch} = {}", out[ch]);
        }
    }
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p film-core engine::`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(core): mode B density-matrix inversion"
```

---

### Task 5: Image-level inversion + the synthetic-patch validation

**Files:**
- Modify: `crates/film-core/src/engine.rs`

This task proves the engine on simulated dye patches (the spec's eq. 8 idea): build a
synthetic negative from known "scene" colors via a forward model, invert it, and assert we
recover neutrals as neutral.

- [ ] **Step 1: Write the failing test**

Add an enum + whole-image function (above `#[cfg(test)]`):

```rust
/// Which inversion to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Density-matrix (the product engine).
    B,
    /// Per-channel log-density baseline.
    C,
    /// 1 - x strawman.
    Naive,
}

/// Invert a whole image in place-ish (returns a new Image, same dims).
pub fn invert_image(img: &crate::Image, p: &InversionParams, mode: Mode) -> crate::Image {
    let f = match mode {
        Mode::B => invert_b,
        Mode::C => invert_c,
        Mode::Naive => invert_naive,
    };
    let pixels = img.pixels.iter().map(|&px| f(px, p)).collect();
    crate::Image { width: img.width, height: img.height, pixels, ir: img.ir.clone() }
}
```

Test inside `tests`:

```rust
    use crate::Image;

    /// Forward model: a neutral scene exposure `e` (per channel) recorded on film
    /// becomes a negative pixel = base * 10^(-k*e) — darker where scene was bright.
    fn synth_negative(scene: [f32; 3], base: [f32; 3], k: f32) -> [f32; 3] {
        [
            base[0] * 10f32.powf(-k * scene[0]),
            base[1] * 10f32.powf(-k * scene[1]),
            base[2] * 10f32.powf(-k * scene[2]),
        ]
    }

    #[test]
    fn mode_b_recovers_neutrals_as_neutral() {
        let base = [0.8, 0.55, 0.35]; // strong orange mask
        let k = 0.6;
        // Build a 1x3 negative from three neutral grays.
        let scene_grays = [[0.2, 0.2, 0.2], [0.5, 0.5, 0.5], [0.8, 0.8, 0.8]];
        let mut img = Image::new(3, 1);
        for (i, g) in scene_grays.iter().enumerate() {
            img.pixels[i] = synth_negative(*g, base, k);
        }
        let p = InversionParams { base, gamma: 1.0, ..Default::default() };
        let out = invert_image(&img, &p, Mode::B);
        // Each recovered pixel must be neutral: channels equal within tolerance.
        for px in &out.pixels {
            let max = px.iter().cloned().fold(f32::MIN, f32::max);
            let min = px.iter().cloned().fold(f32::MAX, f32::min);
            assert!(max - min < 1e-3, "non-neutral recovery: {px:?}");
        }
    }

    #[test]
    fn mode_b_recovers_monotonic_brightness_order() {
        // Brighter scene → brighter recovered positive.
        let base = [0.8, 0.55, 0.35];
        let k = 0.6;
        let mut img = Image::new(3, 1);
        img.pixels[0] = synth_negative([0.2; 3], base, k);
        img.pixels[1] = synth_negative([0.5; 3], base, k);
        img.pixels[2] = synth_negative([0.8; 3], base, k);
        let p = InversionParams { base, gamma: 1.0, ..Default::default() };
        let out = invert_image(&img, &p, Mode::B);
        assert!(out.pixels[0][0] < out.pixels[1][0]);
        assert!(out.pixels[1][0] < out.pixels[2][0]);
    }
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p film-core engine::`
Expected: PASS. (This is the core proof: with the orange mask removed and identity matrices, neutral scenes recover as neutral and brightness order is preserved.)

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(core): whole-image invert + synthetic dye-patch validation"
```

---

## Phase 3 — Calibration (base sampling)

### Task 6: `sample_base`

**Files:**
- Modify: `crates/film-core/src/calibrate.rs`

- [ ] **Step 1: Write the failing test**

`crates/film-core/src/calibrate.rs`:

```rust
//! Estimating the film base (orange mask) from a region of the scan.

use crate::Image;

/// A rectangular region in pixel coords (inclusive top-left, exclusive bottom-right).
#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

/// Estimate per-channel film base from `rect` as a high percentile (95th) of the
/// region — robust to a few dark specks while tracking the bright clear-base value.
/// If `rect` is None, uses the whole image.
pub fn sample_base(img: &Image, rect: Option<Rect>) -> [f32; 3] {
    let r = rect.unwrap_or(Rect { x: 0, y: 0, w: img.width, h: img.height });
    let mut chans: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for yy in r.y..(r.y + r.h).min(img.height) {
        for xx in r.x..(r.x + r.w).min(img.width) {
            let px = img.pixels[yy * img.width + xx];
            for c in 0..3 {
                chans[c].push(px[c]);
            }
        }
    }
    let mut base = [0.0f32; 3];
    for c in 0..3 {
        chans[c].sort_by(|a, b| a.partial_cmp(b).unwrap());
        let idx = ((chans[c].len() as f32) * 0.95) as usize;
        let idx = idx.min(chans[c].len().saturating_sub(1));
        base[c] = chans[c][idx];
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_base_returns_high_percentile() {
        // 10x1 image: channel 0 ramps 0.0..0.9; 95th percentile ≈ top value.
        let mut img = Image::new(10, 1);
        for i in 0..10 {
            let v = i as f32 / 10.0;
            img.pixels[i] = [v, 0.5, 0.5];
        }
        let base = sample_base(&img, None);
        assert!(base[0] >= 0.8, "got {}", base[0]);
        assert!((base[1] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn sample_base_respects_rect() {
        let mut img = Image::new(4, 4);
        // make a bright 2x2 corner, rest dark
        for y in 0..4 {
            for x in 0..4 {
                img.pixels[y * 4 + x] = if x < 2 && y < 2 { [0.9, 0.9, 0.9] } else { [0.1, 0.1, 0.1] };
            }
        }
        let base = sample_base(&img, Some(Rect { x: 0, y: 0, w: 2, h: 2 }));
        assert!((base[0] - 0.9).abs() < 1e-6);
    }
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cargo test -p film-core calibrate::`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(core): sample_base (95th-percentile film-base estimate)"
```

---

## Phase 4 — Export

### Task 7: `write_tiff16`

**Files:**
- Modify: `crates/film-core/src/export.rs`

- [ ] **Step 1: Write the failing test**

`crates/film-core/src/export.rs`:

```rust
//! Write an Image to a 16-bit RGB TIFF.

use crate::Image;
use std::path::Path;
use tiff::encoder::{colortype, TiffEncoder};

/// Encode a linear (or already-toned) Image as 16-bit RGB TIFF. Values are
/// clamped to [0,1] and scaled to u16. IR plane is not written (preserved only
/// in-memory for future use).
pub fn write_tiff16(img: &Image, path: &Path) -> Result<(), tiff::TiffError> {
    let mut file = std::fs::File::create(path).map_err(tiff::TiffError::IoError)?;
    let mut enc = TiffEncoder::new(&mut file)?;
    let mut data: Vec<u16> = Vec::with_capacity(img.len() * 3);
    for px in &img.pixels {
        for c in 0..3 {
            let v = (px[c].clamp(0.0, 1.0) * 65535.0).round() as u16;
            data.push(v);
        }
    }
    enc.write_image::<colortype::RGB16>(img.width as u32, img.height as u32, &data)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::decode_tiff;

    #[test]
    fn roundtrip_tiff16() {
        let mut img = Image::new(2, 1);
        img.pixels[0] = [1.0, 0.0, 0.5];
        img.pixels[1] = [0.25, 0.75, 0.0];
        let dir = std::env::temp_dir();
        let path = dir.join("filmrev_roundtrip.tiff");
        write_tiff16(&img, &path).unwrap();
        let back = decode_tiff(&path).unwrap();
        assert_eq!(back.width, 2);
        assert_eq!(back.height, 1);
        // 16-bit quantization tolerance
        assert!((back.pixels[0][0] - 1.0).abs() < 1e-3);
        assert!((back.pixels[0][2] - 0.5).abs() < 1e-3);
        assert!((back.pixels[1][1] - 0.75).abs() < 1e-3);
    }
}
```

NOTE: this test depends on `decode_tiff` (Task 8). Write it now; it will fail to compile until Task 8 lands. Run it at the end of Task 8.

- [ ] **Step 2: Verify it compiles up to the missing symbol**

Run: `cargo build -p film-core`
Expected: FAIL with "cannot find function `decode_tiff`". (Confirms export code itself is sound.)

- [ ] **Step 3: Commit (export code only; test will go green after Task 8)**

```bash
git add crates/film-core/src/export.rs
git commit -m "feat(core): write_tiff16 (16-bit RGB TIFF export)"
```

---

## Phase 5 — Decode

### Task 8: `decode_tiff` (deterministic, TDD)

**Files:**
- Modify: `crates/film-core/src/decode.rs`

- [ ] **Step 1: Write the implementation + test**

`crates/film-core/src/decode.rs`:

```rust
//! Decode scan files into a linear-RGB Image.
//!
//! `decode_tiff` handles plain 8/16-bit RGB TIFF and scanner *linear* DNGs that
//! the `tiff` crate can read directly. `decode_raw` (Task 10) handles Bayer
//! RAF/DNG via rawler.

use crate::Image;
use std::path::Path;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::ColorType;

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("tiff error: {0}")]
    Tiff(#[from] tiff::TiffError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported color type: {0:?}")]
    UnsupportedColor(ColorType),
}

/// Decode an 8- or 16-bit RGB(A) TIFF / linear DNG into a normalized f32 Image.
/// A 4th (alpha/IR) channel, if present, is captured into `ir`.
pub fn decode_tiff(path: &Path) -> Result<Image, DecodeError> {
    let file = std::fs::File::open(path)?;
    let mut dec = Decoder::new(file)?;
    let (w, h) = dec.dimensions()?;
    let color = dec.colortype()?;
    let (channels, max) = match color {
        ColorType::RGB(8) => (3usize, 255.0f32),
        ColorType::RGB(16) => (3, 65535.0),
        ColorType::RGBA(8) => (4, 255.0),
        ColorType::RGBA(16) => (4, 65535.0),
        other => return Err(DecodeError::UnsupportedColor(other)),
    };
    let result = dec.read_image()?;
    let floats: Vec<f32> = match result {
        DecodingResult::U8(v) => v.into_iter().map(|x| x as f32 / max).collect(),
        DecodingResult::U16(v) => v.into_iter().map(|x| x as f32 / max).collect(),
        _ => return Err(DecodeError::UnsupportedColor(color)),
    };
    let n = (w as usize) * (h as usize);
    let mut pixels = Vec::with_capacity(n);
    let mut ir: Option<Vec<f32>> = if channels == 4 { Some(Vec::with_capacity(n)) } else { None };
    for i in 0..n {
        let base = i * channels;
        pixels.push([floats[base], floats[base + 1], floats[base + 2]]);
        if let Some(ir) = ir.as_mut() {
            ir.push(floats[base + 3]);
        }
    }
    Ok(Image { width: w as usize, height: h as usize, pixels, ir })
}
```

- [ ] **Step 2: Run the export roundtrip test (now compiles)**

Run: `cargo test -p film-core`
Expected: PASS — including `export::tests::roundtrip_tiff16` from Task 7.

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/decode.rs crates/film-core/src/export.rs
git commit -m "feat(core): decode_tiff (8/16-bit RGB/RGBA + IR) and green export roundtrip"
```

---

### Task 9: CLI `invert` command (drives the whole pipeline on a TIFF)

**Files:**
- Modify: `crates/film-cli/src/main.rs`

- [ ] **Step 1: Write the CLI**

`crates/film-cli/src/main.rs`:

```rust
use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use film_core::calibrate::{sample_base, Rect};
use film_core::decode::decode_tiff;
use film_core::engine::{invert_image, InversionParams, Mode};
use film_core::export::write_tiff16;
use std::path::PathBuf;

#[derive(Copy, Clone, Debug, ValueEnum)]
enum CliMode { B, C, Naive }

impl From<CliMode> for Mode {
    fn from(m: CliMode) -> Self {
        match m { CliMode::B => Mode::B, CliMode::C => Mode::C, CliMode::Naive => Mode::Naive }
    }
}

#[derive(Parser)]
#[command(name = "film-cli", about = "Invert a color negative scan")]
struct Cli {
    /// Input TIFF / linear DNG
    input: PathBuf,
    /// Output 16-bit TIFF
    #[arg(short, long)]
    output: PathBuf,
    /// Inversion mode
    #[arg(long, value_enum, default_value = "b")]
    mode: CliMode,
    /// Optional base-sample rect: x,y,w,h (defaults to whole image)
    #[arg(long, value_delimiter = ',')]
    base_rect: Option<Vec<usize>>,
    #[arg(long, default_value = "1.0")]
    exposure: f32,
    #[arg(long, default_value = "0.0")]
    black: f32,
    #[arg(long, default_value = "0.4545")]
    gamma: f32,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let img = decode_tiff(&cli.input).with_context(|| format!("decoding {:?}", cli.input))?;

    let rect = cli.base_rect.as_ref().and_then(|v| {
        if v.len() == 4 { Some(Rect { x: v[0], y: v[1], w: v[2], h: v[3] }) } else { None }
    });
    let base = sample_base(&img, rect);
    eprintln!("film base (orange mask) = {base:?}");

    let params = InversionParams {
        base,
        exposure: cli.exposure,
        black: cli.black,
        gamma: cli.gamma,
        ..Default::default()
    };
    let out = invert_image(&img, &params, cli.mode.into());
    write_tiff16(&out, &cli.output).context("writing output")?;
    eprintln!("wrote {:?} ({} mode)", cli.output, format!("{:?}", cli.mode).to_lowercase());
    Ok(())
}
```

This requires `pub use` of the modules. Verify `film-core/src/lib.rs` exposes `calibrate`, `decode`, `engine`, `export` (done in Task 0). Ensure `Rect`, `Mode`, etc. are `pub` (they are).

- [ ] **Step 2: Build**

Run: `cargo build`
Expected: compiles.

- [ ] **Step 3: Manual smoke test on a synthesized negative**

Create a tiny synthetic negative TIFF using the test helper path, or reuse the roundtrip temp file. Simplest: run on any RGB TIFF you have:

Run: `cargo run -p film-cli -- <some.tiff> -o /tmp/out_b.tiff --mode b`
Expected: prints "film base ... = [...]" and "wrote ... (b mode)", and `/tmp/out_b.tiff` exists.

- [ ] **Step 4: Commit**

```bash
git add crates/film-cli/src/main.rs
git commit -m "feat(cli): invert command (decode → sample base → invert → export)"
```

---

### Task 10: `decode_raw` — real RAF/DNG via rawler (integration against user files)

**Files:**
- Modify: `crates/film-core/src/decode.rs`
- Modify: `crates/film-cli/src/main.rs` (dispatch by extension)

This is validated against the user's real files (V600 SilverFast DNG, GFX100RF RAF), not a
synthetic unit test, because RAW decode depends on real camera/scanner data.

- [ ] **Step 1: Add rawler-based decode**

Append to `crates/film-core/src/decode.rs`:

```rust
/// Decode a Bayer RAW (RAF) or DNG via rawler into a linear f32 Image.
/// Demosaics to RGB. The result is camera-native linear RGB (no white balance,
/// no color matrix applied) — exactly what the inversion engine wants.
pub fn decode_raw(path: &Path) -> Result<Image, DecodeError> {
    use rawler::decoders::*;
    use rawler::imgop::develop::RawDevelop;

    let raw = rawler::decode_file(path).map_err(|e| {
        DecodeError::Io(std::io::Error::new(std::io::ErrorKind::Other, format!("rawler: {e:?}")))
    })?;
    // Develop to linear RGB without gamma/output transform.
    let dev = RawDevelop::default();
    let img = dev.develop_intermediate(&raw).map_err(|e| {
        DecodeError::Io(std::io::Error::new(std::io::ErrorKind::Other, format!("develop: {e:?}")))
    })?;
    let rgb = img.to_dynamic_image().ok_or_else(|| {
        DecodeError::Io(std::io::Error::new(std::io::ErrorKind::Other, "no image"))
    })?;
    let rgb16 = rgb.to_rgb16();
    let (w, h) = (rgb16.width() as usize, rgb16.height() as usize);
    let mut pixels = Vec::with_capacity(w * h);
    for p in rgb16.pixels() {
        pixels.push([
            p[0] as f32 / 65535.0,
            p[1] as f32 / 65535.0,
            p[2] as f32 / 65535.0,
        ]);
    }
    Ok(Image { width: w, height: h, pixels, ir: None })
}
```

NOTE: rawler's exact develop API (`RawDevelop`, `develop_intermediate`, `to_dynamic_image`)
may differ by version; if the names differ, consult `cargo doc -p rawler --open` and adapt to
the closest "decode → demosaiced linear RGB" path. The contract this function must satisfy:
return an `Image` of linear RGB in [0,1]. Keep the signature identical.

- [ ] **Step 2: Dispatch by extension in the CLI**

In `crates/film-cli/src/main.rs`, replace the `decode_tiff(&cli.input)...` line with:

```rust
    let ext = cli.input.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let img = match ext.as_str() {
        "tif" | "tiff" => decode_tiff(&cli.input),
        _ => film_core::decode::decode_raw(&cli.input),
    }
    .with_context(|| format!("decoding {:?}", cli.input))?;
```

Add `use film_core::decode::decode_tiff;` is already present; `decode_raw` is referenced fully-qualified.

NOTE on the SilverFast DNG: if it is a *linear* DNG, `decode_tiff` may also read it. Try
`--` it first via the `tiff` path by temporarily renaming, but the default dispatch sends
`.dng` to `decode_raw`. If rawler refuses the linear DNG, add `"dng"` to the `decode_tiff`
arm and re-test.

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: compiles (after any rawler API name fixups from Step 1's note).

- [ ] **Step 4: Integration test on real files**

Ask the user to drop their files in `~/Repos/filmrev/samples/` (gitignored). Then:

Run: `cargo run -p film-cli --release -- samples/v600_silverfast.dng -o /tmp/v600_b.tiff --mode b`
Run: `cargo run -p film-cli --release -- samples/gfx_negative.raf -o /tmp/gfx_b.tiff --mode b`
Expected: both succeed, print a plausible orange-ish base (R > G > B), and produce viewable positives.

- [ ] **Step 5: Add samples/ to .gitignore and commit**

```bash
echo "/samples" >> .gitignore
git add crates/film-core/src/decode.rs crates/film-cli/src/main.rs .gitignore
git commit -m "feat(core): decode_raw (RAF/DNG via rawler) + CLI extension dispatch"
```

---

## Phase 6 — Validation deliverable (B vs C vs naive)

### Task 11: `--compare` mode emits all three side by side

**Files:**
- Modify: `crates/film-cli/src/main.rs`

- [ ] **Step 1: Add a compare flag**

Add to the `Cli` struct:

```rust
    /// Emit B, C, and naive outputs side by side (writes <output stem>_{b,c,naive}.tiff)
    #[arg(long)]
    compare: bool,
```

In `main`, after computing `base`/`params`, branch:

```rust
    if cli.compare {
        let stem = cli.output.file_stem().and_then(|s| s.to_str()).unwrap_or("out").to_string();
        let dir = cli.output.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        for (mode, suffix) in [(Mode::B, "b"), (Mode::C, "c"), (Mode::Naive, "naive")] {
            let out = invert_image(&img, &params, mode);
            let path = dir.join(format!("{stem}_{suffix}.tiff"));
            write_tiff16(&out, &path).context("writing compare output")?;
            eprintln!("wrote {:?}", path);
        }
        return Ok(());
    }
```

- [ ] **Step 2: Build**

Run: `cargo build`
Expected: compiles.

- [ ] **Step 3: Run the comparison on a real file**

Run: `cargo run -p film-cli --release -- samples/v600_silverfast.dng -o /tmp/v600.tiff --compare`
Expected: writes `/tmp/v600_b.tiff`, `/tmp/v600_c.tiff`, `/tmp/v600_naive.tiff`.

- [ ] **Step 4: Visual + neutral-patch judgement (the POC verdict)**

Open the three in an image viewer. Verdict criteria (the win condition):
- B: neutral areas (gray card / concrete / sky) are visibly more neutral than naive.
- B vs C: B should show less residual color crosstalk in saturated regions.
- naive: expected to look wrong (color cast) — confirms the baseline is beaten.

Record observations in a short note `docs/superpowers/poc-findings.md` (create it) with which
file, which mode looked best, and any obvious next tuning (M_pre/M_post, per-stock base).

- [ ] **Step 5: Commit**

```bash
git add crates/film-cli/src/main.rs docs/superpowers/poc-findings.md
git commit -m "feat(cli): --compare emits B/C/naive side by side; record POC findings"
```

---

## Phase 7 — (Later) Tauri shell

> Out of scope for the physics-quality POC verdict, included for continuity. Build only after
> Phase 6 confirms the color is right. Reuses `film-core` unchanged.

### Task 12: Minimal Tauri app wrapping film-core

**Files:**
- Create: `app/` via `cargo create-tauri-app`
- Modify: `app/src-tauri/Cargo.toml` (add `film-core` path dep)
- Create: `app/src-tauri/src/commands.rs` (Tauri commands calling film-core)

- [ ] **Step 1: Scaffold**

Run: `cd app && cargo create-tauri-app .` (choose: TypeScript + a minimal frontend framework).

- [ ] **Step 2: Add film-core dependency**

In `app/src-tauri/Cargo.toml`:

```toml
film-core = { path = "../../crates/film-core" }
```

- [ ] **Step 3: Expose an `invert` Tauri command**

`app/src-tauri/src/commands.rs` — a command that takes input path + params, runs the engine on
a downscaled **proxy** (per spec §5), returns a PNG/JPEG preview as base64 for display; a
separate `export` command runs full-res `write_tiff16`. (Detailed proxy + command code to be
specified in a follow-up plan once Phase 6 sets the engine defaults.)

- [ ] **Step 4: Commit**

```bash
git add app
git commit -m "feat(app): minimal Tauri shell wrapping film-core"
```

> Phase 7 deliberately defers detailed code: the UI defaults (which sliders, proxy size,
> preview format) should be informed by what Phase 6 reveals about the engine. Treat Phase 7
> as a stub to be expanded in its own plan.

---

## Definition of Done (POC)

- [ ] `cargo test` green (engine validated on synthetic dye patches; TIFF roundtrip).
- [ ] `film-cli invert --compare` runs on the real V600 DNG and GFX RAF.
- [ ] Mode B's neutrals are visibly more neutral than naive flip; findings recorded in
      `docs/superpowers/poc-findings.md`.
- [ ] Assumptions in spec §9 (positive-vs-negative scan; 4th IR channel) confirmed against the
      real files and noted.
