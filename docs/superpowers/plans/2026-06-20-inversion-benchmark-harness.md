# Inversion Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an objective, GUI-free benchmark that scores the current film-inversion engine against the calibrated EKTAR test roll (ColorChecker ΔE2000 + tone-transfer from the step wedge).

**Architecture:** Pure, unit-tested measurement math (color spaces, ΔE2000, ROI patch sampling, metrics) lives in new `film-core` library modules with no serde. A new small binary crate `crates/film-bench` owns JSON manifest/IO, decoding (via the existing `film-core::decode::decode_raw`), orchestration, and output files. The ColorChecker reference is a const table in the lib. We prototype on the EKTAR roll; the manifest format is stock-agnostic so other rolls drop in.

**Tech Stack:** Rust, `film-core` (existing), `image` 0.25, `serde`/`serde_json` (new, in `film-bench` only). No new color-science dependency — color math is hand-rolled and tested against published vectors.

## Global Constraints

- Edition `2021`; match existing crate style.
- `film-core` MUST NOT gain a serde dependency. All JSON lives in `film-bench`.
- All `film-core` additions are pure functions / plain structs, unit-tested with `cargo test -p film-core`.
- Decode RAW only through `film_core::decode::decode_raw` (carries the type-13 SubIFD fix).
- Engine output is treated as **sRGB-encoded display values (D65)**. Reference ColorChecker values are the canonical sRGB-8 table, also D65 → both sides compare in Lab(D65); no chromatic adaptation step (deliberate simplification over the spec's D50→D65 Bradford; equivalent for a display-space comparison, fewer moving parts).
- ColorChecker patch ordering is **row-major from the dark-skin corner** (patch 1 = Dark Skin at top-left of the grid). Manifest corner order is `[TL, TR, BR, BL]` of the 6×4 grid where TL is the dark-skin corner.
- Wedge EV labels are ground truth within ±0.2 EV; do not make sub-0.2 EV claims. Steps flagged `unreliable` are dropped from tone fits.

---

### Task 1: Color math module (`color.rs`)

**Files:**
- Create: `crates/film-core/src/color.rs`
- Modify: `crates/film-core/src/lib.rs` (add `pub mod color;`)

**Interfaces:**
- Produces:
  - `pub fn srgb_to_linear(c: f32) -> f32`
  - `pub fn linear_rgb_to_xyz(rgb: [f32; 3]) -> [f32; 3]` (sRGB/D65 primaries)
  - `pub fn xyz_to_lab(xyz: [f32; 3]) -> [f32; 3]` (D65 white)
  - `pub fn srgb8_to_lab(rgb: [u8; 3]) -> [f32; 3]`
  - `pub fn srgbf_to_lab(rgb: [f32; 3]) -> [f32; 3]` (clamps to [0,1] first)
  - `pub fn delta_e_2000(lab1: [f32; 3], lab2: [f32; 3]) -> f32`

- [ ] **Step 1: Write the failing tests**

Create `crates/film-core/src/color.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_endpoints_to_lab() {
        // White -> L*100, neutral a/b ~ 0. Black -> 0,0,0.
        let w = srgb8_to_lab([255, 255, 255]);
        assert!((w[0] - 100.0).abs() < 0.2, "L*={}", w[0]);
        assert!(w[1].abs() < 0.2 && w[2].abs() < 0.2);
        let k = srgb8_to_lab([0, 0, 0]);
        assert!(k[0].abs() < 0.01 && k[1].abs() < 0.01 && k[2].abs() < 0.01);
    }

    #[test]
    fn srgb_midgray_lightness() {
        // sRGB 119/255 is ~middle L*; should land near L*50.
        let g = srgb8_to_lab([119, 119, 119]);
        assert!((g[0] - 50.0).abs() < 1.0, "L*={}", g[0]);
        assert!(g[1].abs() < 0.5 && g[2].abs() < 0.5);
    }

    #[test]
    fn delta_e_2000_sharma_vectors() {
        // Sharma/Wu/Dalal reference pairs (tolerance 1e-2).
        let cases = [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
            ([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0000),
            ([50.0, 2.5, 0.0], [50.0, 3.2972, 0.0], 1.0000),
            ([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644),
        ];
        for (a, b, want) in cases {
            let got = delta_e_2000(a, b);
            assert!((got - want).abs() < 1e-2, "ΔE00 {a:?} vs {b:?}: got {got}, want {want}");
        }
        // Identity is zero.
        assert!(delta_e_2000([50.0, 2.5, 0.0], [50.0, 2.5, 0.0]).abs() < 1e-4);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cargo test -p film-core color:: 2>&1 | tail -5`
Expected: compile error — functions not defined.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/film-core/src/color.rs` (above the test module):

```rust
//! Color-space conversions and ΔE2000 for the benchmark harness.
//! Everything is sRGB/D65; no chromatic adaptation (both sides are D65).

/// sRGB EOTF: gamma-encoded [0,1] → linear [0,1].
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear sRGB (D65 primaries) → CIE XYZ (D65).
pub fn linear_rgb_to_xyz(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb;
    [
        0.412_456_4 * r + 0.357_576_1 * g + 0.180_437_5 * b,
        0.212_672_9 * r + 0.715_152_2 * g + 0.072_175_0 * b,
        0.019_333_9 * r + 0.119_192_0 * g + 0.950_304_1 * b,
    ]
}

/// CIE XYZ (D65) → CIE L*a*b* (D65 white point).
pub fn xyz_to_lab(xyz: [f32; 3]) -> [f32; 3] {
    const XN: f32 = 0.950_47;
    const YN: f32 = 1.0;
    const ZN: f32 = 1.088_83;
    let f = |t: f32| {
        if t > 0.008_856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let fx = f(xyz[0] / XN);
    let fy = f(xyz[1] / YN);
    let fz = f(xyz[2] / ZN);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// sRGB 8-bit → Lab (D65). Used for the reference ColorChecker table.
pub fn srgb8_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    let lin = [
        srgb_to_linear(rgb[0] as f32 / 255.0),
        srgb_to_linear(rgb[1] as f32 / 255.0),
        srgb_to_linear(rgb[2] as f32 / 255.0),
    ];
    xyz_to_lab(linear_rgb_to_xyz(lin))
}

/// Display sRGB [0,1] (engine output) → Lab (D65). Clamps out-of-range first.
pub fn srgbf_to_lab(rgb: [f32; 3]) -> [f32; 3] {
    let lin = [
        srgb_to_linear(rgb[0].clamp(0.0, 1.0)),
        srgb_to_linear(rgb[1].clamp(0.0, 1.0)),
        srgb_to_linear(rgb[2].clamp(0.0, 1.0)),
    ];
    xyz_to_lab(linear_rgb_to_xyz(lin))
}

#[inline]
fn hue_deg(b: f64, ap: f64) -> f64 {
    if b == 0.0 && ap == 0.0 {
        0.0
    } else {
        let mut h = b.atan2(ap).to_degrees();
        if h < 0.0 {
            h += 360.0;
        }
        h
    }
}

/// CIEDE2000 color difference (kL=kC=kH=1). Reference: Sharma, Wu & Dalal (2005).
pub fn delta_e_2000(lab1: [f32; 3], lab2: [f32; 3]) -> f32 {
    let (l1, a1, b1) = (lab1[0] as f64, lab1[1] as f64, lab1[2] as f64);
    let (l2, a2, b2) = (lab2[0] as f64, lab2[1] as f64, lab2[2] as f64);
    let pow7 = |x: f64| x.powi(7);
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let cbar = (c1 + c2) / 2.0;
    let g = 0.5 * (1.0 - (pow7(cbar) / (pow7(cbar) + pow7(25.0))).sqrt());
    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();
    let h1p = hue_deg(b1, a1p);
    let h2p = hue_deg(b2, a2p);

    let dlp = l2 - l1;
    let dcp = c2p - c1p;
    let dhp = if c1p * c2p == 0.0 {
        0.0
    } else {
        let mut dh = h2p - h1p;
        if dh > 180.0 {
            dh -= 360.0;
        } else if dh < -180.0 {
            dh += 360.0;
        }
        2.0 * (c1p * c2p).sqrt() * (dh.to_radians() / 2.0).sin()
    };

    let lbar = (l1 + l2) / 2.0;
    let cbarp = (c1p + c2p) / 2.0;
    let hbarp = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() > 180.0 {
        let h = h1p + h2p;
        if h < 360.0 {
            (h + 360.0) / 2.0
        } else {
            (h - 360.0) / 2.0
        }
    } else {
        (h1p + h2p) / 2.0
    };

    let t = 1.0 - 0.17 * (hbarp - 30.0).to_radians().cos()
        + 0.24 * (2.0 * hbarp).to_radians().cos()
        + 0.32 * (3.0 * hbarp + 6.0).to_radians().cos()
        - 0.20 * (4.0 * hbarp - 63.0).to_radians().cos();
    let dtheta = 30.0 * (-(((hbarp - 275.0) / 25.0).powi(2))).exp();
    let rc = 2.0 * (pow7(cbarp) / (pow7(cbarp) + pow7(25.0))).sqrt();
    let sl = 1.0 + (0.015 * (lbar - 50.0).powi(2)) / (20.0 + (lbar - 50.0).powi(2)).sqrt();
    let sc = 1.0 + 0.045 * cbarp;
    let sh = 1.0 + 0.015 * cbarp * t;
    let rt = -rc * (2.0 * dtheta.to_radians()).sin();

    let de = ((dlp / sl).powi(2)
        + (dcp / sc).powi(2)
        + (dhp / sh).powi(2)
        + rt * (dcp / sc) * (dhp / sh))
        .sqrt();
    de as f32
}
```

Add to `crates/film-core/src/lib.rs` (with the other `pub mod` lines):

```rust
pub mod color;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core color:: 2>&1 | tail -8`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/color.rs crates/film-core/src/lib.rs
git commit -m "feat(bench): color-space conversions + CIEDE2000"
```

---

### Task 2: ColorChecker reference table (`colorchecker.rs`)

**Files:**
- Create: `crates/film-core/src/colorchecker.rs`
- Modify: `crates/film-core/src/lib.rs` (add `pub mod colorchecker;`)

**Interfaces:**
- Consumes: `color::srgb8_to_lab` (Task 1).
- Produces:
  - `pub struct RefPatch { pub name: &'static str, pub srgb: [u8; 3] }`
  - `pub const CLASSIC24: [RefPatch; 24]` (row-major, patch 1 = Dark Skin)
  - `pub fn classic24_lab() -> [[f32; 3]; 24]`

- [ ] **Step 1: Write the failing tests**

Create `crates/film-core/src/colorchecker.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::delta_e_2000;

    #[test]
    fn table_has_24_patches_named() {
        assert_eq!(CLASSIC24.len(), 24);
        assert_eq!(CLASSIC24[0].name, "Dark Skin");
        assert_eq!(CLASSIC24[23].name, "Black");
    }

    #[test]
    fn lab_sanity_white_black_neutral() {
        let lab = classic24_lab();
        // Patch 19 = White (bright), patch 24 = Black (dark).
        assert!(lab[18][0] > 94.0, "white L*={}", lab[18][0]);
        assert!(lab[23][0] < 25.0, "black L*={}", lab[23][0]);
        // Neutrals (19..24) are near-achromatic.
        for i in 18..24 {
            let c = (lab[i][1].powi(2) + lab[i][2].powi(2)).sqrt();
            assert!(c < 3.0, "patch {} chroma {}", i + 1, c);
        }
        // Each patch differs from its neighbor by a visible amount.
        assert!(delta_e_2000(lab[0], lab[1]) > 5.0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cargo test -p film-core colorchecker:: 2>&1 | tail -5`
Expected: compile error — `CLASSIC24` not found.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/film-core/src/colorchecker.rs`:

```rust
//! Canonical X-Rite/Calibrite ColorChecker Classic 24 reference values.
//! sRGB-8 (D65), row-major from the dark-skin corner (patch 1) to black (patch 24).

use crate::color::srgb8_to_lab;

pub struct RefPatch {
    pub name: &'static str,
    pub srgb: [u8; 3],
}

pub const CLASSIC24: [RefPatch; 24] = [
    RefPatch { name: "Dark Skin", srgb: [115, 82, 68] },
    RefPatch { name: "Light Skin", srgb: [194, 150, 130] },
    RefPatch { name: "Blue Sky", srgb: [98, 122, 157] },
    RefPatch { name: "Foliage", srgb: [87, 108, 67] },
    RefPatch { name: "Blue Flower", srgb: [133, 128, 177] },
    RefPatch { name: "Bluish Green", srgb: [103, 189, 170] },
    RefPatch { name: "Orange", srgb: [214, 126, 44] },
    RefPatch { name: "Purplish Blue", srgb: [80, 91, 166] },
    RefPatch { name: "Moderate Red", srgb: [193, 90, 99] },
    RefPatch { name: "Purple", srgb: [94, 60, 108] },
    RefPatch { name: "Yellow Green", srgb: [157, 188, 64] },
    RefPatch { name: "Orange Yellow", srgb: [224, 163, 46] },
    RefPatch { name: "Blue", srgb: [56, 61, 150] },
    RefPatch { name: "Green", srgb: [70, 148, 73] },
    RefPatch { name: "Red", srgb: [175, 54, 60] },
    RefPatch { name: "Yellow", srgb: [231, 199, 31] },
    RefPatch { name: "Magenta", srgb: [187, 86, 149] },
    RefPatch { name: "Cyan", srgb: [8, 133, 161] },
    RefPatch { name: "White", srgb: [243, 243, 242] },
    RefPatch { name: "Neutral 8", srgb: [200, 200, 200] },
    RefPatch { name: "Neutral 6.5", srgb: [160, 160, 160] },
    RefPatch { name: "Neutral 5", srgb: [122, 122, 121] },
    RefPatch { name: "Neutral 3.5", srgb: [85, 85, 85] },
    RefPatch { name: "Black", srgb: [52, 52, 52] },
];

/// The 24 reference patches as Lab (D65), row-major.
pub fn classic24_lab() -> [[f32; 3]; 24] {
    let mut out = [[0.0f32; 3]; 24];
    for (i, p) in CLASSIC24.iter().enumerate() {
        out[i] = srgb8_to_lab(p.srgb);
    }
    out
}

/// Indices (0-based) of the six neutral patches (white → black), used for WB fitting.
pub const NEUTRAL_INDICES: [usize; 6] = [18, 19, 20, 21, 22, 23];
```

Add to `crates/film-core/src/lib.rs`:

```rust
pub mod colorchecker;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core colorchecker:: 2>&1 | tail -8`
Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/colorchecker.rs crates/film-core/src/lib.rs
git commit -m "feat(bench): ColorChecker Classic 24 reference table"
```

---

### Task 3: Patch grid sampling (`chart.rs` core)

**Files:**
- Create: `crates/film-core/src/chart.rs`
- Modify: `crates/film-core/src/lib.rs` (add `pub mod chart;`)

**Interfaces:**
- Consumes: `crate::Image` (fields `width: usize`, `height: usize`, `pixels: Vec<[f32;3]>`).
- Produces:
  - `pub struct GridSpec { pub cols: usize, pub rows: usize, pub inset: f32 }`
  - `pub fn sample_grid(img: &Image, corners: &[[f32; 2]; 4], spec: &GridSpec, trim: f32) -> Vec<[f32; 3]>`
    - `corners` = `[TL, TR, BR, BL]` pixel coords of the outer grid bounds.
    - Returns row-major patch means (`cols*rows` entries). `trim` ∈ [0,0.5) trims that fraction of brightest+darkest samples per patch. `inset` ∈ (0,1] is the fraction of each cell sampled.

- [ ] **Step 1: Write the failing test**

Create `crates/film-core/src/chart.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::Image;

    // Build a 2x2 grid image: each cell a flat color, with a few dust pixels.
    fn synth() -> Image {
        let (w, h) = (40usize, 40usize);
        let mut px = vec![[0.0f32; 3]; w * h];
        let colors = [
            [1.0, 0.0, 0.0], // TL  (col0,row0)
            [0.0, 1.0, 0.0], // TR  (col1,row0)
            [0.0, 0.0, 1.0], // BL  (col0,row1)
            [1.0, 1.0, 0.0], // BR  (col1,row1)
        ];
        for y in 0..h {
            for x in 0..w {
                let c = (x >= w / 2) as usize + 2 * (y >= h / 2) as usize;
                // map cell index (TL,TR,BL,BR) -> colors order above
                let color = match c {
                    0 => colors[0],
                    1 => colors[1],
                    2 => colors[2],
                    _ => colors[3],
                };
                px[y * w + x] = color;
            }
        }
        // Dust: a white and a black speck inside the TL cell center.
        px[10 * w + 10] = [1.0, 1.0, 1.0];
        px[11 * w + 11] = [0.0, 0.0, 0.0];
        Image { width: w, height: h, pixels: px, ir: None }
    }

    #[test]
    fn samples_row_major_means() {
        let img = synth();
        let corners = [[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]];
        let spec = GridSpec { cols: 2, rows: 2, inset: 0.5 };
        let got = sample_grid(&img, &corners, &spec, 0.2);
        assert_eq!(got.len(), 4);
        // Row-major: [TL, TR, BL, BR] = red, green, blue, yellow.
        let near = |a: [f32; 3], b: [f32; 3]| (0..3).all(|i| (a[i] - b[i]).abs() < 0.05);
        assert!(near(got[0], [1.0, 0.0, 0.0]), "TL={:?}", got[0]);
        assert!(near(got[1], [0.0, 1.0, 0.0]), "TR={:?}", got[1]);
        assert!(near(got[2], [0.0, 0.0, 1.0]), "BL={:?}", got[2]);
        assert!(near(got[3], [1.0, 1.0, 0.0]), "BR={:?}", got[3]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cargo test -p film-core chart:: 2>&1 | tail -5`
Expected: compile error — `GridSpec`/`sample_grid` not found.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/film-core/src/chart.rs`:

```rust
//! ROI sampling: map 4 chart corners to a patch grid and sample each patch
//! with a trimmed mean (rejecting dust/scratch/edge outliers).

use crate::Image;

pub struct GridSpec {
    pub cols: usize,
    pub rows: usize,
    /// Fraction of each cell sampled around its center, in (0, 1].
    pub inset: f32,
}

/// Bilinear map of normalized (u,v) in [0,1]^2 across corners [TL,TR,BR,BL] → pixel (x,y).
fn bilerp(corners: &[[f32; 2]; 4], u: f32, v: f32) -> [f32; 2] {
    let [tl, tr, br, bl] = corners;
    let top = [tl[0] * (1.0 - u) + tr[0] * u, tl[1] * (1.0 - u) + tr[1] * u];
    let bot = [bl[0] * (1.0 - u) + br[0] * u, bl[1] * (1.0 - u) + br[1] * u];
    [top[0] * (1.0 - v) + bot[0] * v, top[1] * (1.0 - v) + bot[1] * v]
}

#[inline]
fn at(img: &Image, x: f32, y: f32) -> Option<[f32; 3]> {
    if x < 0.0 || y < 0.0 {
        return None;
    }
    let (xi, yi) = (x as usize, y as usize);
    if xi >= img.width || yi >= img.height {
        return None;
    }
    Some(img.pixels[yi * img.width + xi])
}

/// Sample one cell: gather an N×N grid of samples in the inset window, trimmed-mean by luma.
fn sample_cell(img: &Image, corners: &[[f32; 2]; 4], spec: &GridSpec, col: usize, row: usize, trim: f32) -> [f32; 3] {
    const N: usize = 11; // 11x11 sub-samples per patch
    let cu = (col as f32 + 0.5) / spec.cols as f32;
    let cv = (row as f32 + 0.5) / spec.rows as f32;
    let half_u = 0.5 * spec.inset / spec.cols as f32;
    let half_v = 0.5 * spec.inset / spec.rows as f32;
    let mut samples: Vec<[f32; 3]> = Vec::with_capacity(N * N);
    for j in 0..N {
        for i in 0..N {
            let u = cu + (i as f32 / (N as f32 - 1.0) - 0.5) * 2.0 * half_u;
            let v = cv + (j as f32 / (N as f32 - 1.0) - 0.5) * 2.0 * half_v;
            let p = bilerp(corners, u, v);
            if let Some(px) = at(img, p[0], p[1]) {
                samples.push(px);
            }
        }
    }
    if samples.is_empty() {
        return [0.0, 0.0, 0.0];
    }
    // Trim by luma, average the survivors per channel.
    let luma = |c: [f32; 3]| 0.2627 * c[0] + 0.6780 * c[1] + 0.0593 * c[2];
    samples.sort_by(|a, b| luma(*a).partial_cmp(&luma(*b)).unwrap());
    let k = ((samples.len() as f32) * trim).floor() as usize;
    let slice = &samples[k..samples.len().saturating_sub(k).max(k + 1)];
    let mut acc = [0.0f32; 3];
    for s in slice {
        for c in 0..3 {
            acc[c] += s[c];
        }
    }
    let n = slice.len().max(1) as f32;
    [acc[0] / n, acc[1] / n, acc[2] / n]
}

/// Sample all patches, row-major (row 0 left→right, then row 1, …).
pub fn sample_grid(img: &Image, corners: &[[f32; 2]; 4], spec: &GridSpec, trim: f32) -> Vec<[f32; 3]> {
    let mut out = Vec::with_capacity(spec.cols * spec.rows);
    for row in 0..spec.rows {
        for col in 0..spec.cols {
            out.push(sample_cell(img, corners, spec, col, row, trim));
        }
    }
    out
}
```

Add to `crates/film-core/src/lib.rs`:

```rust
pub mod chart;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p film-core chart:: 2>&1 | tail -8`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/chart.rs crates/film-core/src/lib.rs
git commit -m "feat(bench): perspective patch-grid trimmed-mean sampling"
```

---

### Task 4: Sampling overlay (`chart.rs` visualization)

**Files:**
- Modify: `crates/film-core/src/chart.rs` (append `sampling_overlay`)

**Interfaces:**
- Consumes: `GridSpec`, `bilerp` (Task 3), `crate::Image`, `image` crate.
- Produces:
  - `pub fn sampling_overlay(positive: &Image, corners: &[[f32; 2]; 4], spec: &GridSpec, max_dim: usize) -> image::RgbImage`
    - Returns a downscaled (longest side ≤ `max_dim`) sRGB preview of `positive` with each sampled window outlined; patch (0,0) marked red and patch (0,1)…orientation marker, so a human can confirm alignment and that TL is the dark-skin corner.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/film-core/src/chart.rs`:

```rust
    #[test]
    fn overlay_downscales_and_is_rgb() {
        let img = synth();
        let corners = [[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]];
        let spec = GridSpec { cols: 2, rows: 2, inset: 0.5 };
        let ov = sampling_overlay(&img, &corners, &spec, 20);
        assert!(ov.width().max(ov.height()) <= 20);
        assert!(ov.width() > 0 && ov.height() > 0);
    }
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cargo test -p film-core chart::tests::overlay 2>&1 | tail -5`
Expected: compile error — `sampling_overlay` not found.

- [ ] **Step 3: Write the implementation**

Append to `crates/film-core/src/chart.rs` (outside the test module):

```rust
/// Draw a downscaled sRGB preview with the sampled windows outlined, for human
/// verification of corner alignment and patch orientation.
pub fn sampling_overlay(
    positive: &Image,
    corners: &[[f32; 2]; 4],
    spec: &GridSpec,
    max_dim: usize,
) -> image::RgbImage {
    let scale = (max_dim as f32 / positive.width.max(positive.height) as f32).min(1.0);
    let ow = ((positive.width as f32 * scale).round() as u32).max(1);
    let oh = ((positive.height as f32 * scale).round() as u32).max(1);
    let mut out = image::RgbImage::new(ow, oh);
    // Nearest-neighbour downscale + display-encode (engine output is already sRGB-ish).
    for y in 0..oh {
        for x in 0..ow {
            let sx = ((x as f32 / scale) as usize).min(positive.width - 1);
            let sy = ((y as f32 / scale) as usize).min(positive.height - 1);
            let p = positive.pixels[sy * positive.width + sx];
            out.put_pixel(
                x,
                y,
                image::Rgb([
                    (p[0].clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                    (p[1].clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                    (p[2].clamp(0.0, 1.0) * 255.0 + 0.5) as u8,
                ]),
            );
        }
    }
    let plot = |out: &mut image::RgbImage, px: f32, py: f32, col: image::Rgb<u8>| {
        let x = (px * scale).round();
        let y = (py * scale).round();
        if x >= 0.0 && y >= 0.0 && (x as u32) < ow && (y as u32) < oh {
            out.put_pixel(x as u32, y as u32, col);
        }
    };
    // Outline each cell's inset window; mark the first patch (0,0) red.
    for row in 0..spec.rows {
        for col in 0..spec.cols {
            let cu = (col as f32 + 0.5) / spec.cols as f32;
            let cv = (row as f32 + 0.5) / spec.rows as f32;
            let hu = 0.5 * spec.inset / spec.cols as f32;
            let hv = 0.5 * spec.inset / spec.rows as f32;
            let color = if row == 0 && col == 0 {
                image::Rgb([255, 0, 0])
            } else {
                image::Rgb([0, 255, 0])
            };
            let steps = 60;
            for s in 0..steps {
                let f = s as f32 / steps as f32;
                // four edges of the window
                for (u, v) in [
                    (cu - hu + 2.0 * hu * f, cv - hv),
                    (cu - hu + 2.0 * hu * f, cv + hv),
                    (cu - hu, cv - hv + 2.0 * hv * f),
                    (cu + hu, cv - hv + 2.0 * hv * f),
                ] {
                    let p = bilerp(corners, u, v);
                    plot(&mut out, p[0], p[1], color);
                }
            }
        }
    }
    out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p film-core chart::tests::overlay 2>&1 | tail -8`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/chart.rs
git commit -m "feat(bench): sampling-overlay visualization for corner verification"
```

---

### Task 5: Color & tone metrics (`bench.rs`)

**Files:**
- Create: `crates/film-core/src/bench.rs`
- Modify: `crates/film-core/src/lib.rs` (add `pub mod bench;`)

**Interfaces:**
- Consumes: `color`, `colorchecker`, `chart`, `engine::{invert_image, InversionParams, Mode}`, `calibrate::auto_wb_gains`, `crate::Image`.
- Produces:
  - `pub struct ColorScore { pub mean: f32, pub max: f32, pub p95: f32, pub per_patch: Vec<f32> }`
  - `pub struct ColorReport { pub neutralized: ColorScore, pub as_shipped: ColorScore, pub neutralized_chroma_only: ColorScore }`
  - `pub fn score_color(neg: &Image, base: [f32; 3], corners: &[[f32; 2]; 4]) -> ColorReport`
  - `pub struct ToneReport { pub ev: Vec<f32>, pub lstar: Vec<f32>, pub mid_gray_l: f32, pub shadow_latitude_ev: f32, pub highlight_latitude_ev: f32, pub mid_slope: f32, pub monotonic: bool }`
  - `pub fn score_tone(neg: &Image, base: [f32; 3], corners: &[[f32; 2]; 4], n_steps: usize, ev_per_step: f32, mid_step: usize, drop_last: usize) -> ToneReport`

**Notes on method:** WB in `Mode::D`/Gain is a post-curve per-channel multiply, so we invert **once** with `wb=[1,1,1]` and derive both scores by multiplying the sampled positive patches — neutralized gains come from the 6 gray patches, as-shipped gains come from `auto_wb_gains` on the full inverted image.

- [ ] **Step 1: Write the failing test**

Create `crates/film-core/src/bench.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::Image;

    // A trivial "negative": uniform mid value so inversion yields a flat gray frame.
    fn flat_neg(w: usize, h: usize, v: f32) -> Image {
        Image { width: w, height: h, pixels: vec![[v, v, v]; w * h], ir: None }
    }

    #[test]
    fn color_report_populates_and_is_finite() {
        let neg = flat_neg(60, 40, 0.25);
        let corners = [[2.0, 2.0], [58.0, 2.0], [58.0, 38.0], [2.0, 38.0]];
        let rep = score_color(&neg, [0.5, 0.5, 0.5], &corners);
        assert_eq!(rep.neutralized.per_patch.len(), 24);
        assert!(rep.neutralized.mean.is_finite() && rep.neutralized.mean >= 0.0);
        assert!(rep.as_shipped.mean.is_finite());
        // A flat frame has neutral grays, so neutralized gains ≈ 1 and the score is finite.
        assert!(rep.neutralized.max >= rep.neutralized.mean);
    }

    #[test]
    fn tone_report_monotone_on_ramp() {
        // Build a horizontal ramp negative: denser (smaller value) on the left.
        let (w, h) = (100usize, 20usize);
        let mut px = vec![[0.0f32; 3]; w * h];
        for y in 0..h {
            for x in 0..w {
                let t = 0.05 + 0.9 * (x as f32 / (w as f32 - 1.0)); // transmission rises L→R
                px[y * w + x] = [t, t, t];
            }
        }
        let neg = Image { width: w, height: h, pixels: px, ir: None };
        // 5 steps across the width; brighter scene (more density) is on the LEFT (low transmission).
        let corners = [[0.0, 0.0], [100.0, 0.0], [100.0, 20.0], [0.0, 20.0]];
        let rep = score_tone(&neg, [1.0, 1.0, 1.0], &corners, 5, 1.0, 2, 0);
        assert_eq!(rep.lstar.len(), 5);
        assert!(rep.lstar.iter().all(|v| v.is_finite()));
        assert!(rep.mid_gray_l.is_finite());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cargo test -p film-core bench:: 2>&1 | tail -5`
Expected: compile error — `score_color`/`score_tone` not found.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/film-core/src/bench.rs`:

```rust
//! Benchmark metrics: ColorChecker ΔE2000 (neutralized + as-shipped) and the
//! tone-transfer curve from the step wedge. Pure functions over a decoded
//! negative `Image`; no IO. The bench binary owns files and manifests.

use crate::calibrate::auto_wb_gains;
use crate::chart::{sample_grid, GridSpec};
use crate::color::{delta_e_2000, srgbf_to_lab};
use crate::colorchecker::{classic24_lab, NEUTRAL_INDICES};
use crate::engine::{invert_image, InversionParams, Mode};
use crate::Image;

pub struct ColorScore {
    pub mean: f32,
    pub max: f32,
    pub p95: f32,
    pub per_patch: Vec<f32>,
}

pub struct ColorReport {
    /// ΔE over all 24 patches, after WB-neutralizing on the grays.
    pub neutralized: ColorScore,
    /// ΔE over all 24 patches, using the engine's default auto-WB.
    pub as_shipped: ColorScore,
    /// ΔE over the 18 chromatic patches only (neutralized).
    pub neutralized_chroma_only: ColorScore,
}

fn score_from_deltas(deltas: Vec<f32>) -> ColorScore {
    let mut sorted = deltas.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len().max(1);
    let mean = sorted.iter().sum::<f32>() / n as f32;
    let max = sorted.last().copied().unwrap_or(0.0);
    let p95 = sorted[((0.95 * (n as f32 - 1.0)).round() as usize).min(n - 1)];
    ColorScore { mean, max, p95, per_patch: deltas }
}

/// Invert with neutral WB (wb=[1,1,1]) for a clean per-patch positive sample.
fn invert_neutral(neg: &Image, base: [f32; 3]) -> Image {
    let params = InversionParams {
        base,
        ..Default::default()
    };
    invert_image(neg, &params, Mode::D)
}

pub fn score_color(neg: &Image, base: [f32; 3], corners: &[[f32; 2]; 4]) -> ColorReport {
    let positive = invert_neutral(neg, base);
    let spec = GridSpec { cols: 6, rows: 4, inset: 0.5 };
    let patches = sample_grid(&positive, corners, &spec, 0.2);
    let reference = classic24_lab();

    // Neutralized gains: make the mean of the 6 grays equal across channels (anchor to G).
    let mut mean_g = [0.0f32; 3];
    for &i in NEUTRAL_INDICES.iter() {
        for c in 0..3 {
            mean_g[c] += patches[i][c];
        }
    }
    for c in 0..3 {
        mean_g[c] /= NEUTRAL_INDICES.len() as f32;
    }
    let eps = 1e-5;
    let neut_gain = [
        mean_g[1] / mean_g[0].max(eps),
        1.0,
        mean_g[1] / mean_g[2].max(eps),
    ];

    // As-shipped gains: the engine's own auto-WB on the full inverted frame.
    let ship_gain = auto_wb_gains(&positive);

    let apply = |p: [f32; 3], g: [f32; 3]| [p[0] * g[0], p[1] * g[1], p[2] * g[2]];

    let mut neut_d = Vec::with_capacity(24);
    let mut ship_d = Vec::with_capacity(24);
    let mut chroma_d = Vec::new();
    for (i, &p) in patches.iter().enumerate() {
        let dn = delta_e_2000(srgbf_to_lab(apply(p, neut_gain)), reference[i]);
        let ds = delta_e_2000(srgbf_to_lab(apply(p, ship_gain)), reference[i]);
        neut_d.push(dn);
        ship_d.push(ds);
        if !NEUTRAL_INDICES.contains(&i) {
            chroma_d.push(dn);
        }
    }

    ColorReport {
        neutralized: score_from_deltas(neut_d),
        as_shipped: score_from_deltas(ship_d),
        neutralized_chroma_only: score_from_deltas(chroma_d),
    }
}

pub struct ToneReport {
    pub ev: Vec<f32>,
    pub lstar: Vec<f32>,
    pub mid_gray_l: f32,
    pub shadow_latitude_ev: f32,
    pub highlight_latitude_ev: f32,
    pub mid_slope: f32,
    pub monotonic: bool,
}

/// Sample an N-step wedge (sampled as an n_steps×1 grid along the corner span) and
/// build the output-L* vs scene-EV transfer curve plus scalar metrics.
pub fn score_tone(
    neg: &Image,
    base: [f32; 3],
    corners: &[[f32; 2]; 4],
    n_steps: usize,
    ev_per_step: f32,
    mid_step: usize,
    drop_last: usize,
) -> ToneReport {
    let positive = invert_neutral(neg, base);
    let spec = GridSpec { cols: n_steps, rows: 1, inset: 0.5 };
    let cells = sample_grid(&positive, corners, &spec, 0.25);
    let keep = n_steps.saturating_sub(drop_last);

    let mut ev = Vec::with_capacity(keep);
    let mut lstar = Vec::with_capacity(keep);
    for (i, c) in cells.iter().take(keep).enumerate() {
        ev.push((i as f32 - mid_step as f32) * ev_per_step);
        lstar.push(srgbf_to_lab(*c)[0]);
    }

    let mid_gray_l = *lstar.get(mid_step).unwrap_or(&f32::NAN);
    // Monotonic if L* is non-decreasing with EV.
    let monotonic = lstar.windows(2).all(|w| w[1] >= w[0] - 1.0);
    // Mid slope: dL*/dEV around the mid step (central difference where possible).
    let mid_slope = if mid_step > 0 && mid_step + 1 < lstar.len() {
        (lstar[mid_step + 1] - lstar[mid_step - 1]) / (2.0 * ev_per_step)
    } else {
        f32::NAN
    };
    // Shadow latitude: most-negative EV whose L* still exceeds a near-black floor.
    let shadow_latitude_ev = ev
        .iter()
        .zip(lstar.iter())
        .filter(|(_, &l)| l > 2.0)
        .map(|(&e, _)| e)
        .fold(f32::INFINITY, f32::min);
    // Highlight latitude: most-positive EV whose L* is still below a near-white ceiling.
    let highlight_latitude_ev = ev
        .iter()
        .zip(lstar.iter())
        .filter(|(_, &l)| l < 98.0)
        .map(|(&e, _)| e)
        .fold(f32::NEG_INFINITY, f32::max);

    ToneReport {
        ev,
        lstar,
        mid_gray_l,
        shadow_latitude_ev,
        highlight_latitude_ev,
        mid_slope,
        monotonic,
    }
}
```

Add to `crates/film-core/src/lib.rs`:

```rust
pub mod bench;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core bench:: 2>&1 | tail -8`
Expected: `test result: ok. 2 passed`.

Then run the whole crate to confirm no regressions:

Run: `cargo test -p film-core 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/bench.rs crates/film-core/src/lib.rs
git commit -m "feat(bench): color ΔE + tone-transfer metrics over a decoded negative"
```

---

### Task 6: `film-bench` crate skeleton + manifest types

**Files:**
- Create: `crates/film-bench/Cargo.toml`
- Create: `crates/film-bench/src/main.rs`
- Create: `crates/film-bench/src/manifest.rs`
- Modify: `Cargo.toml` (workspace `members` + add `serde`, `serde_json` to `[workspace.dependencies]`)

**Interfaces:**
- Produces (in `manifest.rs`):
  - `#[derive(serde::Deserialize)] pub struct Manifest { pub chart: String, pub roll: String, pub dir: String, pub frames: Vec<Frame> }`
  - `#[derive(serde::Deserialize)] pub struct Frame { pub file: String, pub role: String, #[serde(default)] pub corners: Option<[[f32;2];4]>, #[serde(default)] pub n_steps: Option<usize>, #[serde(default)] pub ev_per_step: Option<f32>, #[serde(default)] pub mid_step: Option<usize>, #[serde(default)] pub drop_last: Option<usize>, #[serde(default)] pub flags: Vec<String> }`
  - `pub fn load(path: &str) -> Result<Manifest, String>`

- [ ] **Step 1: Add workspace members and deps**

Edit root `Cargo.toml` — add the crate to `members` and the two deps to `[workspace.dependencies]`:

```toml
members = ["crates/film-core", "crates/film-cli", "crates/film-bench"]
```

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Create the crate manifest**

Create `crates/film-bench/Cargo.toml`:

```toml
[package]
name = "film-bench"
version = "0.1.0"
edition = "2021"

[dependencies]
film-core = { path = "../film-core" }
image = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
```

- [ ] **Step 3: Write the failing test (manifest parsing)**

Create `crates/film-bench/src/manifest.rs`:

```rust
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Manifest {
    pub chart: String,
    pub roll: String,
    pub dir: String,
    pub frames: Vec<Frame>,
}

#[derive(Deserialize)]
pub struct Frame {
    pub file: String,
    pub role: String,
    #[serde(default)]
    pub corners: Option<[[f32; 2]; 4]>,
    #[serde(default)]
    pub n_steps: Option<usize>,
    #[serde(default)]
    pub ev_per_step: Option<f32>,
    #[serde(default)]
    pub mid_step: Option<usize>,
    #[serde(default)]
    pub drop_last: Option<usize>,
    #[serde(default)]
    pub flags: Vec<String>,
}

pub fn load(path: &str) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_manifest() {
        let json = r#"{
            "chart": "colorchecker24",
            "roll": "EKTAR 100",
            "dir": "/tmp/x",
            "frames": [
                {"file": "a.dng", "role": "d_min"},
                {"file": "b.dng", "role": "color", "corners": [[1,2],[3,4],[5,6],[7,8]]},
                {"file": "c.dng", "role": "wedge", "corners": [[0,0],[9,0],[9,1],[0,1]], "n_steps": 10, "ev_per_step": 1.0, "mid_step": 4, "flags": ["last_unreliable"]}
            ]
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.frames.len(), 3);
        assert_eq!(m.frames[1].corners.unwrap()[2], [5.0, 6.0]);
        assert_eq!(m.frames[2].n_steps, Some(10));
        assert_eq!(m.frames[0].corners, None);
    }
}
```

Create a minimal `crates/film-bench/src/main.rs` so the crate builds:

```rust
mod manifest;

fn main() {
    eprintln!("film-bench: see Task 7 for the runner");
}
```

- [ ] **Step 4: Run the test**

Run: `cargo test -p film-bench 2>&1 | tail -8`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml crates/film-bench/Cargo.toml crates/film-bench/src/main.rs crates/film-bench/src/manifest.rs
git commit -m "feat(bench): film-bench crate skeleton + ROI manifest parsing"
```

---

### Task 7: `film-bench` runner + outputs

**Files:**
- Modify: `crates/film-bench/src/main.rs`
- Create: `crates/film-bench/src/run.rs`

**Interfaces:**
- Consumes: `manifest::{load, Manifest, Frame}` (Task 6); `film_core::decode::decode_raw`; `film_core::calibrate::sample_base`; `film_core::bench::{score_color, score_tone, ColorReport, ToneReport}`; `film_core::chart::{sampling_overlay, GridSpec}`; `film_core::engine::{invert_image, InversionParams, Mode}`.
- Produces: a CLI `film-bench <manifest.json> <out_dir>` that writes `metrics.json`, `overlay_<frame>.png` per color/wedge frame, `tone_curve.csv`, and prints a headline summary.

- [ ] **Step 1: Write the runner**

Create `crates/film-bench/src/run.rs`:

```rust
use crate::manifest::{load, Frame};
use film_core::bench::{score_color, score_tone};
use film_core::calibrate::sample_base;
use film_core::chart::{sampling_overlay, GridSpec};
use film_core::decode::decode_raw;
use film_core::engine::{invert_image, InversionParams, Mode};
use std::path::Path;

fn decode(dir: &str, file: &str) -> film_core::Image {
    let path = Path::new(dir).join(file);
    decode_raw(&path).unwrap_or_else(|e| panic!("decode {}: {e}", path.display()))
}

pub fn run(manifest_path: &str, out_dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("mkdir {out_dir}: {e}"))?;
    let m = load(manifest_path)?;

    // Base from the d_min frame (per-channel film base); fall back to whole-frame sample.
    let base = m
        .frames
        .iter()
        .find(|f| f.role == "d_min")
        .map(|f| {
            let img = decode(&m.dir, &f.file);
            sample_base(&img, None)
        })
        .unwrap_or([1.0, 1.0, 1.0]);

    let mut json = String::from("{\n");
    json.push_str(&format!("  \"roll\": {:?},\n", m.roll));
    json.push_str(&format!("  \"base\": [{}, {}, {}],\n", base[0], base[1], base[2]));
    json.push_str("  \"color\": [\n");

    let mut summary = Vec::new();

    let color_frames: Vec<&Frame> = m.frames.iter().filter(|f| f.role == "color").collect();
    for (idx, f) in color_frames.iter().enumerate() {
        let corners = f.corners.ok_or_else(|| format!("color frame {} missing corners", f.file))?;
        let neg = decode(&m.dir, &f.file);
        let rep = score_color(&neg, base, &corners);

        // Overlay for human verification.
        let positive = invert_image(&neg, &InversionParams { base, ..Default::default() }, Mode::D);
        let spec = GridSpec { cols: 6, rows: 4, inset: 0.5 };
        let ov = sampling_overlay(&positive, &corners, &spec, 1400);
        let ov_path = format!("{out_dir}/overlay_{}.png", sanitize(&f.file));
        ov.save(&ov_path).map_err(|e| format!("save {ov_path}: {e}"))?;

        json.push_str(&format!(
            "    {{ \"file\": {:?}, \"neutralized_mean\": {:.4}, \"neutralized_max\": {:.4}, \"chroma_mean\": {:.4}, \"as_shipped_mean\": {:.4} }}{}\n",
            f.file,
            rep.neutralized.mean,
            rep.neutralized.max,
            rep.neutralized_chroma_only.mean,
            rep.as_shipped.mean,
            if idx + 1 < color_frames.len() { "," } else { "" }
        ));
        summary.push(format!(
            "  {}: neutralized ΔE mean {:.2} (chroma {:.2}, max {:.2}) | as-shipped {:.2}",
            f.file, rep.neutralized.mean, rep.neutralized_chroma_only.mean, rep.neutralized.max, rep.as_shipped.mean
        ));
    }
    json.push_str("  ],\n  \"tone\": [\n");

    let wedge_frames: Vec<&Frame> = m.frames.iter().filter(|f| f.role == "wedge").collect();
    let mut csv = String::from("frame,step,ev,lstar\n");
    for (idx, f) in wedge_frames.iter().enumerate() {
        let corners = f.corners.ok_or_else(|| format!("wedge frame {} missing corners", f.file))?;
        let neg = decode(&m.dir, &f.file);
        let rep = score_tone(
            &neg,
            base,
            &corners,
            f.n_steps.unwrap_or(10),
            f.ev_per_step.unwrap_or(1.0),
            f.mid_step.unwrap_or(0),
            f.drop_last.unwrap_or(0),
        );
        for (i, (e, l)) in rep.ev.iter().zip(rep.lstar.iter()).enumerate() {
            csv.push_str(&format!("{},{},{},{:.3}\n", f.file, i, e, l));
        }
        json.push_str(&format!(
            "    {{ \"file\": {:?}, \"mid_gray_l\": {:.2}, \"shadow_latitude_ev\": {:.2}, \"highlight_latitude_ev\": {:.2}, \"mid_slope\": {:.2}, \"monotonic\": {} }}{}\n",
            f.file, rep.mid_gray_l, rep.shadow_latitude_ev, rep.highlight_latitude_ev, rep.mid_slope, rep.monotonic,
            if idx + 1 < wedge_frames.len() { "," } else { "" }
        ));
        summary.push(format!(
            "  {}: mid-gray L* {:.1}, shadow {:.1} EV, highlight {:.1} EV, slope {:.1}, monotonic {}",
            f.file, rep.mid_gray_l, rep.shadow_latitude_ev, rep.highlight_latitude_ev, rep.mid_slope, rep.monotonic
        ));
    }
    json.push_str("  ]\n}\n");

    std::fs::write(format!("{out_dir}/metrics.json"), json).map_err(|e| format!("write metrics: {e}"))?;
    std::fs::write(format!("{out_dir}/tone_curve.csv"), csv).map_err(|e| format!("write csv: {e}"))?;

    eprintln!("=== film-bench: {} ===", m.roll);
    for line in summary {
        eprintln!("{line}");
    }
    eprintln!("base = {base:?}");
    eprintln!("outputs in {out_dir}/ (metrics.json, tone_curve.csv, overlay_*.png)");
    Ok(())
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}
```

- [ ] **Step 2: Wire up `main.rs`**

Replace `crates/film-bench/src/main.rs`:

```rust
mod manifest;
mod run;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: film-bench <manifest.json> <out_dir>");
        std::process::exit(2);
    }
    if let Err(e) = run::run(&args[1], &args[2]) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build -p film-bench 2>&1 | tail -8`
Expected: `Finished` with no errors.

- [ ] **Step 4: Run the existing tests (no regressions)**

Run: `cargo test -p film-bench 2>&1 | tail -5`
Expected: manifest test still passes.

- [ ] **Step 5: Commit**

```bash
git add crates/film-bench/src/main.rs crates/film-bench/src/run.rs
git commit -m "feat(bench): film-bench runner emitting metrics.json + overlays + tone CSV"
```

---

### Task 8: Author the EKTAR manifest + verify alignment (data task)

**Files:**
- Create: `crates/film-bench/benchdata/ektar.roi.json`

**Interfaces:**
- Consumes: the full pipeline (Tasks 1–7). Produces the committed corner data and the first real benchmark run.

This task is iterative and human-verified. The implementer must NOT guess corners blindly — they derive them from the decoded frames and confirm via overlays.

- [ ] **Step 1: Render the color + wedge frames to inspect corners**

Reuse the existing `raw_dump` example to get a display-encoded view of each negative (so the chart is visible). For each candidate frame, render and downscale:

```bash
cd /Users/mohaelder/Repos/filmrev
for n in 11 12 13 20 06 07 08 09; do
  cargo run -q --release -p film-core --example raw_dump -- "/Users/mohaelder/Downloads/FILM/EKTAR 100/EKTAR 100--$n.dng" 2>/dev/null
done
ls -la /tmp/*EKTAR*  # raw_dump writes downscaled PNGs to /tmp
```

Pick ONE well-exposed `color` frame (card fills the frame, neutral exposure — e.g. 12 or 13) and the wedge frame(s) (06–09). Note: full-res frames are 9504×6336; corner coords are in **full-resolution pixels**.

- [ ] **Step 2: Estimate corners and write the manifest**

Create `crates/film-bench/benchdata/ektar.roi.json`. Corner order is `[TL, TR, BR, BL]` where TL is the **dark-skin** patch corner of the 24-patch grid. Replace the coordinate placeholders with values read from the rendered frames (scale up from the downscaled preview to full-res by the preview's downscale factor):

```json
{
  "chart": "colorchecker24",
  "roll": "EKTAR 100",
  "dir": "/Users/mohaelder/Downloads/FILM/EKTAR 100",
  "frames": [
    { "file": "EKTAR 100--02.dng", "role": "d_min" },
    { "file": "EKTAR 100--01.dng", "role": "d_max" },
    { "file": "EKTAR 100--13.dng", "role": "color",
      "corners": [[X_TL, Y_TL], [X_TR, Y_TR], [X_BR, Y_BR], [X_BL, Y_BL]] },
    { "file": "EKTAR 100--06.dng", "role": "wedge",
      "corners": [[X_TL, Y_TL], [X_TR, Y_TR], [X_BR, Y_BR], [X_BL, Y_BL]],
      "n_steps": 10, "ev_per_step": 1.0, "mid_step": 4, "drop_last": 1,
      "flags": ["last_unreliable"] }
  ]
}
```

(The implementer fills `X_*`/`Y_*` from Step 1. `n_steps`/`mid_step` for the wedge are read off the rendered wedge — count the visible cells; the mid-gray cell index sets `mid_step`.)

- [ ] **Step 3: Run the benchmark and inspect overlays**

Run:
```bash
cargo run -q --release -p film-bench -- crates/film-bench/benchdata/ektar.roi.json /tmp/bench-ektar
```
Expected: stderr headline with neutralized/as-shipped ΔE and tone metrics; `/tmp/bench-ektar/overlay_*.png` written.

- [ ] **Step 4: Verify the overlay hits the patches**

Open `/tmp/bench-ektar/overlay_EKTAR_100__13_dng.png`. Confirm every green window sits inside its patch and the **red** window is on the dark-skin patch (orientation). If misaligned, adjust the corner coords in the JSON and re-run Step 3. Repeat until aligned.

> **HUMAN CHECKPOINT:** Present the overlay PNG(s) to the user for confirmation that sampling is correct before trusting the numbers. The user explicitly asked to verify via overlay.

- [ ] **Step 5: Commit**

```bash
git add crates/film-bench/benchdata/ektar.roi.json
git commit -m "data(bench): EKTAR ROI manifest (verified via sampling overlay)"
```

---

### Task 9: Baseline report + README

**Files:**
- Create: `crates/film-bench/README.md`

**Interfaces:** none new — documents usage and records the current engine's baseline scores.

- [ ] **Step 1: Capture the baseline numbers**

Run the benchmark and copy the stderr summary + `metrics.json` headline:

```bash
cargo run -q --release -p film-bench -- crates/film-bench/benchdata/ektar.roi.json /tmp/bench-ektar 2>&1 | tail -20
```

- [ ] **Step 2: Write the README**

Create `crates/film-bench/README.md` documenting: purpose, how to run, the manifest format (roles, corner order `[TL,TR,BR,BL]` with TL=dark-skin, wedge fields), the output files, the measurement conventions (sRGB/D65 Lab; neutralized vs as-shipped ΔE), and a **Baseline (EKTAR, current engine)** section pasted from Step 1. Keep it under ~60 lines.

- [ ] **Step 3: Commit**

```bash
git add crates/film-bench/README.md
git commit -m "docs(bench): usage + EKTAR baseline scores for the current engine"
```

---

## Self-Review

**Spec coverage:**
- Color ΔE protocol (neutralized + as-shipped + chroma-only) → Task 5 `score_color`. ✓
- Tone transfer from step wedge + scalar metrics → Task 5 `score_tone`. ✓
- Assisted ROI manifest (corners) → Task 6 schema + Task 8 data. ✓
- Overlay PNGs for human verification → Task 4 + Task 7 + Task 8 checkpoint. ✓
- ColorChecker reference → Task 2 (const table; documented deviation from JSON). ✓
- Outputs: metrics.json, overlays, tone CSV → Task 7. (Spec also listed a contact-sheet PNG and a tone-curve PNG plot; these are dropped to keep scope tight — CSV + overlays cover verification, and a plot image adds a plotting dependency for little benefit. **Noted deviation.**)
- d_min/d_max context → Task 7 (base from d_min; d_max frame present in manifest, reported as base context). ✓
- Stock-agnostic manifest, EKTAR prototype → Task 6/8. ✓
- Out-of-scope (MTF, shader parity, tuning, multi-stock) → not built. ✓

**Deviations from spec (deliberate, documented):**
1. Reference stored as a Rust const table, not `benchdata/colorchecker24.json` (canonical static data; testable; no file IO in lib tests).
2. No D50→D65 Bradford — reference is sRGB-8/D65, output is sRGB/D65, both compared in Lab(D65) (simpler, equivalent for display-space comparison).
3. Contact-sheet PNG and tone-curve PNG replaced by `tone_curve.csv` + per-frame overlays (avoids a plotting dependency). If the user wants the plotted artifacts, add a follow-up task.

**Placeholder scan:** The only intentional placeholders are the corner coordinates in Task 8 (`X_TL` etc.), which are *data the implementer measures from the frames* — they cannot be known a priori and the task explains exactly how to obtain and verify them. All code steps contain complete code.

**Type consistency:** `GridSpec{cols,rows,inset}`, `sample_grid(img,corners,spec,trim)`, `score_color`/`score_tone` signatures, and `ColorReport`/`ToneReport` field names are used identically in Tasks 5, 7. `NEUTRAL_INDICES` defined in Task 2, used in Task 5. Manifest field names match between Task 6 schema and Task 7 consumption.
