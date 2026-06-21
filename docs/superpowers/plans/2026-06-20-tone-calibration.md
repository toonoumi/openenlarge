# Tone Calibration (Measure + Recommend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure our film-inversion engine's tone transfer curve against Eva's calibrated digital-SDR C400 reference (~17.5 EV) and fit/recommend the `d_max`/exposure/curve that would make it faithful — without changing the engine.

**Architecture:** Pure tone math (curve eval, density→L\*, metrics, fit) goes in a new unit-tested `film-core/src/tone.rs`. The `film-bench` binary gains a `tone` subcommand that decodes the 3 C400 frames, samples the 100-patch wedge, rank-pairs each frame's patches to the reference EVs, stitches them, and runs the metrics + fit. The xlsx is pre-converted once to a committed `c400.reference.json` so Rust needs no zip/xml deps.

**Tech Stack:** Rust, `film-core` (engine/decode/chart/color/calibrate), `film-bench` (serde JSON IO), Python stdlib (one-time xlsx→json conversion).

## Global Constraints

- Edition 2021; match existing crate style.
- `film-core` MUST NOT gain a dependency; `tone.rs` is pure functions, unit-tested with `cargo test -p film-core`.
- `film-bench` owns all IO/JSON (serde already a dep). No new Rust crate dependency for xlsx — the xlsx is converted to JSON once by Python and committed.
- Measurement ONLY: do NOT modify `engine.rs`, `shaders.ts`, or any engine behavior. This build reads the engine's constants and *replicates* the neutral tone path to fit against; it changes nothing.
- Decode RAW only via `film_core::decode::decode_raw`.
- Engine constants to mirror verbatim (from `engine.rs`): `EXPO_K = 0.14`, filmic `K = 5.0`, `PIVOT = 0.44`, `WHITE_T = 1.05`, `THRESHOLD = 2.328_306_4e-10`, `EPS = 1e-5`. Default `d_max = 1.5`.
- The engine's neutral (wb=[1,1,1]) Gain-mode tone path simplifies to `output = filmic_s((d/d_max)·2^(EXPO_K·ev))`; i.e. a single density scale `scale = 2^(EXPO_K·ev)/d_max`. The fit's tone-position DOF is this one scalar; report it as recommended `d_max = 1/scale` (at exposure 0).
- C400 data: frames in `/Users/mohaelder/Desktop/c400/` (`Capture One Catalog8328/8329/8330.raf` = +0/+6/+9 EV); reference EVs/values in `/Users/mohaelder/Desktop/C400 基准曝光数据.xlsx` (`相对ev`, `数值`).
- Confidence: film density onset ~−5 EV; deep-shadow patches (xlsx-tagged >0.3 EV error) get low weight via `ev_weight`.

---

### Task 1: Tone transfer + density→L\* (`tone.rs` core)

**Files:**
- Create: `crates/film-core/src/tone.rs`
- Modify: `crates/film-core/src/lib.rs` (add `pub mod tone;`)

**Interfaces:**
- Consumes: `crate::color::srgbf_to_lab` (existing: `[f32;3] display sRGB -> [f32;3] Lab`).
- Produces:
  - `pub const EXPO_K: f32`
  - `pub enum Transfer { Filmic { k: f32, pivot: f32, white_t: f32 }, Gamma { gamma: f32 } }` with `pub fn default_filmic() -> Transfer`
  - `pub fn apply_transfer(t: f32, tr: &Transfer) -> f32` (normalized log-density `t` → display [0,1])
  - `pub fn output_lstar(scan: [f32; 3], base: [f32; 3], scale: f32, tr: &Transfer) -> f32`

- [ ] **Step 1: Write the failing tests**

Create `crates/film-core/src/tone.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filmic_matches_engine_anchors() {
        let f = Transfer::default_filmic();
        // filmic_s(0) == 0 and filmic_s(WHITE_T=1.05) == 1 by construction.
        assert!(apply_transfer(0.0, &f).abs() < 1e-6, "t=0 -> 0");
        assert!((apply_transfer(1.05, &f) - 1.0).abs() < 1e-6, "t=WHITE_T -> 1");
        // Monotonic increasing across the range.
        let mut prev = -1.0;
        for i in 0..=20 {
            let v = apply_transfer(i as f32 / 20.0 * 1.05, &f);
            assert!(v >= prev - 1e-6, "monotonic at {i}: {v} < {prev}");
            prev = v;
        }
    }

    #[test]
    fn gamma_transfer_basic() {
        let g = Transfer::Gamma { gamma: 1.8 };
        assert!(apply_transfer(0.0, &g).abs() < 1e-6);
        assert!((apply_transfer(1.0, &g) - 1.0).abs() < 1e-6);
        // gamma>1 lifts midtones: 0.5^(1/1.8) > 0.5
        assert!(apply_transfer(0.5, &g) > 0.5);
    }

    #[test]
    fn output_lstar_brighter_scene_higher_l() {
        // base orange-ish; a denser negative (smaller scan) = brighter scene = higher L*.
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::default_filmic();
        let dense = output_lstar([0.05, 0.06, 0.03], base, 1.0 / 1.5, &tr); // bright scene
        let thin = output_lstar([0.40, 0.52, 0.24], base, 1.0 / 1.5, &tr);  // dark scene
        assert!(dense > thin, "dense neg should render brighter: {dense} vs {thin}");
        assert!((0.0..=100.0).contains(&dense) && (0.0..=100.0).contains(&thin));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cargo test -p film-core tone:: 2>&1 | tail -5`
Expected: compile error — items not defined.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/film-core/src/tone.rs`:

```rust
//! Pure tone math for the tone-calibration harness: the engine's neutral display
//! transfer (filmic S-curve or a gamma alternative), density→L*, and (later)
//! transfer metrics + fit. This REPLICATES the engine's neutral (wb=[1,1,1])
//! Gain-mode tone path so the fit can run on sampled patches without re-inverting
//! a full frame; it does not change the engine.

use crate::color::srgbf_to_lab;

/// Exposure sensitivity, mirrored from `engine.rs`.
pub const EXPO_K: f32 = 0.14;

/// Display transfer applied to normalized log-density `t` (>= 0) → display [0,1].
#[derive(Clone, Copy, Debug)]
pub enum Transfer {
    /// The engine's logistic filmic S-curve (default k=5.0, pivot=0.44, white_t=1.05).
    Filmic { k: f32, pivot: f32, white_t: f32 },
    /// A plain gamma alternative (no S-curve): `t.clamp(0,1)^(1/gamma)`.
    Gamma { gamma: f32 },
}

impl Transfer {
    pub fn default_filmic() -> Transfer {
        Transfer::Filmic { k: 5.0, pivot: 0.44, white_t: 1.05 }
    }
}

/// Map normalized log-density `t` to a display value in [0,1].
pub fn apply_transfer(t: f32, tr: &Transfer) -> f32 {
    match *tr {
        Transfer::Filmic { k, pivot, white_t } => {
            let l = |x: f32| 1.0 / (1.0 + (-k * (x - pivot)).exp());
            let l0 = l(0.0);
            let lw = l(white_t);
            ((l(t) - l0) / (lw - l0)).clamp(0.0, 1.0)
        }
        Transfer::Gamma { gamma } => t.clamp(0.0, 1.0).powf(1.0 / gamma),
    }
}

/// Replicate the engine's neutral tone path and return CIE L* of the rendered patch.
///
/// Per channel: `d = log10(base/scan).max(0)`, `t = d * scale`, `out = apply_transfer(t)`.
/// `scale = 2^(EXPO_K·ev)/d_max` collapses the engine's d_max + exposure into one density
/// scale (valid for wb=[1,1,1] Gain mode). The 3-channel display output is converted to L*.
pub fn output_lstar(scan: [f32; 3], base: [f32; 3], scale: f32, tr: &Transfer) -> f32 {
    const THRESHOLD: f32 = 2.328_306_4e-10;
    const EPS: f32 = 1e-5;
    let out: [f32; 3] = std::array::from_fn(|c| {
        let s = scan[c].max(THRESHOLD);
        let dmin = base[c].max(EPS);
        let d = (dmin / s).log10().max(0.0);
        apply_transfer(d * scale, tr)
    });
    srgbf_to_lab(out)[0]
}
```

Add to `crates/film-core/src/lib.rs` (alphabetical — `tone` after `metadata`/`engine`, before any later module; place with the other `pub mod` lines):

```rust
pub mod tone;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core tone:: 2>&1 | tail -8`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/tone.rs crates/film-core/src/lib.rs
git commit -m "feat(tone): display transfer (filmic/gamma) + density->L*"
```

---

### Task 2: Confidence weight + transfer metrics (`tone.rs`)

**Files:**
- Modify: `crates/film-core/src/tone.rs` (append)

**Interfaces:**
- Consumes: `output_lstar`, `Transfer` (Task 1).
- Produces:
  - `pub fn ev_weight(abs_ev: f32) -> f32`
  - `pub struct TonePoint { pub scan: [f32; 3], pub base: [f32; 3], pub target_l: f32, pub weight: f32, pub abs_ev: f32 }`
  - `pub struct ToneMetrics { pub rms_dl: f32, pub max_dl: f32, pub frac_within5: f32, pub monotonic: bool }`
  - `pub fn transfer_metrics(points: &[TonePoint], scale: f32, tr: &Transfer) -> ToneMetrics`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `crates/film-core/src/tone.rs`:

```rust
    #[test]
    fn ev_weight_downweights_deep_shadows() {
        assert!((ev_weight(0.0) - 1.0).abs() < 1e-6, "bright = full weight");
        assert!((ev_weight(-4.0) - 1.0).abs() < 1e-6, "above onset = full weight");
        assert!(ev_weight(-9.0) < 0.1, "deep shadow = low weight");
        assert!(ev_weight(-7.0) < ev_weight(-5.0), "monotone down into shadows");
    }

    #[test]
    fn metrics_zero_error_when_target_equals_output() {
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::default_filmic();
        let scale = 1.0 / 1.2;
        // Build points whose target_l IS our output at this scale → zero deviation.
        let scans = [[0.06, 0.07, 0.035], [0.15, 0.18, 0.09], [0.35, 0.45, 0.22]];
        let pts: Vec<TonePoint> = scans
            .iter()
            .enumerate()
            .map(|(i, &scan)| TonePoint {
                scan,
                base,
                target_l: output_lstar(scan, base, scale, &tr),
                weight: 1.0,
                abs_ev: -(i as f32),
            })
            .collect();
        let m = transfer_metrics(&pts, scale, &tr);
        assert!(m.rms_dl < 1e-4, "rms should be ~0, got {}", m.rms_dl);
        assert!(m.max_dl < 1e-4);
        assert!((m.frac_within5 - 1.0).abs() < 1e-6);
    }
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cargo test -p film-core tone:: 2>&1 | tail -5`
Expected: compile error — `ev_weight`/`TonePoint`/`transfer_metrics` not found.

- [ ] **Step 3: Write the implementation**

Append to `crates/film-core/src/tone.rs` (outside the test module):

```rust
/// Confidence weight for a patch at absolute scene EV. The C400/Ektar density onset is
/// ~−5 EV; below it the negative holds little real information (the reference tags those
/// patches with >0.3 EV error), so weight ramps from 1.0 at/above −5 EV down to ~0.05 by
/// −9 EV. This keeps deep-shadow noise from dominating the metrics/fit.
pub fn ev_weight(abs_ev: f32) -> f32 {
    let (lo, hi) = (-9.0f32, -5.0f32);
    let x = ((abs_ev - lo) / (hi - lo)).clamp(0.0, 1.0);
    let s = x * x * (3.0 - 2.0 * x); // smoothstep
    0.05 + 0.95 * s
}

/// One stitched wedge sample: the raw negative patch, its frame's base, the digital-SDR
/// target L*, the confidence weight, and the absolute scene EV (for reporting).
pub struct TonePoint {
    pub scan: [f32; 3],
    pub base: [f32; 3],
    pub target_l: f32,
    pub weight: f32,
    pub abs_ev: f32,
}

pub struct ToneMetrics {
    /// Confidence-weighted RMS of (our L* − target L*).
    pub rms_dl: f32,
    pub max_dl: f32,
    /// Fraction of (unweighted) patches within ΔL* < 5 of target.
    pub frac_within5: f32,
    /// Is our rendered L* monotone non-decreasing with scene EV (points pre-sorted by EV)?
    pub monotonic: bool,
}

/// Deviation of our rendered transfer (at `scale`, `tr`) from the digital-SDR target.
pub fn transfer_metrics(points: &[TonePoint], scale: f32, tr: &Transfer) -> ToneMetrics {
    let mut sw = 0.0f32;
    let mut swe2 = 0.0f32;
    let mut max_dl = 0.0f32;
    let mut within = 0usize;
    // Sort by EV for the monotonicity check without mutating the caller's slice.
    let mut idx: Vec<usize> = (0..points.len()).collect();
    idx.sort_by(|&a, &b| points[a].abs_ev.partial_cmp(&points[b].abs_ev).unwrap());
    let mut prev_l = f32::NEG_INFINITY;
    let mut monotonic = true;
    for &i in &idx {
        let p = &points[i];
        let our = output_lstar(p.scan, p.base, scale, tr);
        let dl = our - p.target_l;
        sw += p.weight;
        swe2 += p.weight * dl * dl;
        max_dl = max_dl.max(dl.abs());
        if dl.abs() < 5.0 {
            within += 1;
        }
        if our < prev_l - 1.0 {
            monotonic = false;
        }
        prev_l = our;
    }
    ToneMetrics {
        rms_dl: (swe2 / sw.max(1e-6)).sqrt(),
        max_dl,
        frac_within5: within as f32 / points.len().max(1) as f32,
        monotonic,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core tone:: 2>&1 | tail -8`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/tone.rs
git commit -m "feat(tone): confidence weighting + transfer deviation metrics"
```

---

### Task 3: Tone fit (`tone.rs`)

**Files:**
- Modify: `crates/film-core/src/tone.rs` (append)

**Interfaces:**
- Consumes: `TonePoint`, `Transfer`, `output_lstar` (Tasks 1–2).
- Produces:
  - `pub enum FitMode { ScaleOnly, ScaleCurve, Gamma }`
  - `pub struct FitResult { pub scale: f32, pub transfer: Transfer, pub residual_rms: f32 }`
  - `pub fn fit_tone(points: &[TonePoint], mode: FitMode) -> FitResult`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/film-core/src/tone.rs`:

```rust
    #[test]
    fn fit_recovers_known_scale() {
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::default_filmic();
        let true_scale = 1.0 / 0.9; // the scale we'll hide in the targets
        // Spread of negative patches across the range.
        let scans = [
            [0.05, 0.06, 0.03], [0.10, 0.12, 0.06], [0.18, 0.22, 0.11],
            [0.26, 0.33, 0.16], [0.34, 0.44, 0.21], [0.40, 0.52, 0.25],
        ];
        let pts: Vec<TonePoint> = scans
            .iter()
            .enumerate()
            .map(|(i, &scan)| TonePoint {
                scan,
                base,
                target_l: output_lstar(scan, base, true_scale, &tr),
                weight: 1.0,
                abs_ev: -(i as f32),
            })
            .collect();
        let fit = fit_tone(&pts, FitMode::ScaleOnly);
        assert!(fit.residual_rms < 0.2, "should fit near-exactly: {}", fit.residual_rms);
        assert!((fit.scale - true_scale).abs() < 0.05, "recover scale: {} vs {true_scale}", fit.scale);
    }
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cargo test -p film-core tone::tests::fit 2>&1 | tail -5`
Expected: compile error — `fit_tone`/`FitMode`/`FitResult` not found.

- [ ] **Step 3: Write the implementation**

Append to `crates/film-core/src/tone.rs` (outside the test module):

```rust
#[derive(Clone, Copy, Debug)]
pub enum FitMode {
    /// Fit only the density scale (≡ d_max/exposure), keep the default filmic curve.
    ScaleOnly,
    /// Fit the density scale AND the filmic curve constants (k, pivot, white_t).
    ScaleCurve,
    /// Replace the filmic curve with a plain gamma; fit the scale + gamma (the
    /// "no S-curve" alternative, to settle filmic-vs-gamma).
    Gamma,
}

pub struct FitResult {
    pub scale: f32,
    pub transfer: Transfer,
    pub residual_rms: f32,
}

fn weighted_rms(points: &[TonePoint], scale: f32, tr: &Transfer) -> f32 {
    let mut sw = 0.0f32;
    let mut swe2 = 0.0f32;
    for p in points {
        let dl = output_lstar(p.scan, p.base, scale, tr) - p.target_l;
        sw += p.weight;
        swe2 += p.weight * dl * dl;
    }
    (swe2 / sw.max(1e-6)).sqrt()
}

/// Greedy coordinate descent over the active parameters for the mode.
/// Parameter vector: [scale, a, b, c] where (a,b,c) = (k,pivot,white_t) for Filmic
/// or (gamma, _, _) for Gamma. Inactive params stay at their seed.
pub fn fit_tone(points: &[TonePoint], mode: FitMode) -> FitResult {
    // Seed + which params are active + how to build a Transfer from the vector.
    let (mut p, active): ([f32; 4], [bool; 4]) = match mode {
        FitMode::ScaleOnly => ([1.0 / 1.5, 5.0, 0.44, 1.05], [true, false, false, false]),
        FitMode::ScaleCurve => ([1.0 / 1.5, 5.0, 0.44, 1.05], [true, true, true, true]),
        FitMode::Gamma => ([1.0 / 1.5, 2.2, 0.0, 0.0], [true, true, false, false]),
    };
    let build = |p: &[f32; 4]| -> Transfer {
        match mode {
            FitMode::Gamma => Transfer::Gamma { gamma: p[1].max(0.2) },
            _ => Transfer::Filmic { k: p[1].max(0.5), pivot: p[2], white_t: p[3].max(0.2) },
        }
    };
    let cost = |p: &[f32; 4]| weighted_rms(points, p[0].max(1e-3), &build(p));

    let mut steps = [0.20f32, 0.6, 0.04, 0.06]; // per-param initial step
    let mut best = cost(&p);
    for _ in 0..2000 {
        let mut improved = false;
        for j in 0..4 {
            if !active[j] {
                continue;
            }
            for dir in [steps[j], -steps[j]] {
                let mut cand = p;
                cand[j] += dir;
                let c = cost(&cand);
                if c < best {
                    best = c;
                    p = cand;
                    improved = true;
                }
            }
        }
        if !improved {
            for s in steps.iter_mut() {
                *s *= 0.5;
            }
            if steps[0] < 1e-4 {
                break;
            }
        }
    }
    FitResult { scale: p[0].max(1e-3), transfer: build(&p), residual_rms: best }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p film-core tone:: 2>&1 | tail -8`
Expected: `test result: ok. 6 passed`.

Then the whole crate (no regressions):

Run: `cargo test -p film-core 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/tone.rs
git commit -m "feat(tone): coordinate-descent fit (scale / +curve / gamma modes)"
```

---

### Task 4: Wedge manifest + reference loader (`wedge.rs`)

**Files:**
- Create: `crates/film-bench/src/wedge.rs`
- Modify: `crates/film-bench/src/main.rs` (add `mod wedge;`)

**Interfaces:**
- Consumes: `serde` (already a dep).
- Produces:
  - `#[derive(serde::Deserialize)] pub struct WedgeManifest { pub dir: String, pub reference: String, pub frames: Vec<WedgeFrame> }`
  - `#[derive(serde::Deserialize)] pub struct WedgeFrame { pub file: String, pub base_ev: f32, pub corners: [[f32; 2]; 4] }`
  - `#[derive(serde::Deserialize)] pub struct RefData { pub patches: Vec<RefPatch> }`
  - `#[derive(serde::Deserialize, Clone, Copy)] pub struct RefPatch { pub ev: f32, pub value: f32 }`
  - `pub fn load_manifest(path: &str) -> Result<WedgeManifest, String>`
  - `pub fn load_reference(path: &str) -> Result<Vec<RefPatch>, String>`
  - `pub fn target_lstar(value: f32, value_max: f32) -> f32`

- [ ] **Step 1: Write the failing tests**

Create `crates/film-bench/src/wedge.rs`:

```rust
use serde::Deserialize;

#[derive(Deserialize)]
pub struct WedgeManifest {
    pub dir: String,
    pub reference: String,
    pub frames: Vec<WedgeFrame>,
}

#[derive(Deserialize)]
pub struct WedgeFrame {
    pub file: String,
    pub base_ev: f32,
    pub corners: [[f32; 2]; 4],
}

#[derive(Deserialize)]
pub struct RefData {
    pub patches: Vec<RefPatch>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct RefPatch {
    pub ev: f32,
    pub value: f32,
}

pub fn load_manifest(path: &str) -> Result<WedgeManifest, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&t).map_err(|e| format!("parse {path}: {e}"))
}

pub fn load_reference(path: &str) -> Result<Vec<RefPatch>, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let d: RefData = serde_json::from_str(&t).map_err(|e| format!("parse {path}: {e}"))?;
    Ok(d.patches)
}

/// Convert a digital-SDR reference `数值` to a target CIE L*.
///
/// `数值` is the digital reference's display-referred response (it is NOT linear: it
/// spans ~10× over ~8.6 EV, far less than 2^8.6, so it is gamma-encoded, not raw DN).
/// We treat it as an sRGB-display code: normalize against the brightest patch
/// (`value_max`, the 0-EV anchor → ~display white), apply the sRGB EOTF to recover
/// luminance, then CIE L*. Black level (~512) is small vs `value_max` and folds into
/// the normalization. ONLY the absolute L* anchor depends on this assumption; the
/// curve *shape* comparison does not. (Confirm `数值`'s true encoding with the data
/// author to sharpen the anchor.)
pub fn target_lstar(value: f32, value_max: f32) -> f32 {
    let s = (value / value_max).clamp(0.0, 1.0); // sRGB-encoded display value
    let lin = if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) };
    // CIE L* from luminance Y=lin (D65), matching film_core::color::xyz_to_lab.
    let f = if lin > 0.008_856 { lin.cbrt() } else { 7.787 * lin + 16.0 / 116.0 };
    116.0 * f - 16.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wedge_manifest() {
        let j = r#"{
            "dir": "/x", "reference": "/x/ref.json",
            "frames": [
                {"file": "a.raf", "base_ev": 0.0, "corners": [[1,2],[3,4],[5,6],[7,8]]},
                {"file": "b.raf", "base_ev": 6.0, "corners": [[1,2],[3,4],[5,6],[7,8]]}
            ]
        }"#;
        let m: WedgeManifest = serde_json::from_str(j).unwrap();
        assert_eq!(m.frames.len(), 2);
        assert_eq!(m.frames[1].base_ev, 6.0);
        assert_eq!(m.frames[0].corners[2], [5.0, 6.0]);
    }

    #[test]
    fn parses_reference_and_anchors_lstar() {
        let j = r#"{"patches":[{"ev":0.0,"value":10000.0},{"ev":-3.0,"value":3000.0}]}"#;
        let d: RefData = serde_json::from_str(j).unwrap();
        assert_eq!(d.patches.len(), 2);
        // Brightest patch (value==value_max) anchors near display white → high L*.
        assert!(target_lstar(10000.0, 10000.0) > 95.0);
        // A darker patch is dimmer.
        assert!(target_lstar(3000.0, 10000.0) < target_lstar(10000.0, 10000.0));
        // Black anchors to L*0.
        assert!(target_lstar(0.0, 10000.0).abs() < 1e-3);
    }
}
```

Add `mod wedge;` to `crates/film-bench/src/main.rs` (with the existing `mod manifest;` / `mod run;` lines).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-bench wedge 2>&1 | tail -6`
Expected: first run FAILS to compile if `mod wedge;` not yet added or passes once added; ensure tests are discovered and pass after Step 3. (If it compiles but you added only the test, that's fine — proceed.)

- [ ] **Step 3: Implementation is already inline above; verify it builds**

Run: `cargo test -p film-bench wedge 2>&1 | tail -8`
Expected: `test result: ok. 2 passed`.

- [ ] **Step 4: Confirm the existing color tests still pass**

Run: `cargo test -p film-bench 2>&1 | tail -4`
Expected: all pass (the Task-6 color `parses_minimal_manifest` + the 2 new wedge tests).

- [ ] **Step 5: Commit**

```bash
git add crates/film-bench/src/wedge.rs crates/film-bench/src/main.rs
git commit -m "feat(tone): wedge manifest + digital-SDR reference loader + L* anchor"
```

---

### Task 5: Tone runner + `tone` subcommand (`tone_run.rs`)

**Files:**
- Create: `crates/film-bench/src/tone_run.rs`
- Modify: `crates/film-bench/src/main.rs` (add `mod tone_run;` + dispatch a `tone` subcommand)

**Interfaces:**
- Consumes: `wedge::{load_manifest, load_reference, target_lstar, WedgeFrame, RefPatch}` (Task 4); `film_core::tone::{TonePoint, Transfer, FitMode, transfer_metrics, fit_tone, ev_weight, output_lstar, EXPO_K}` (Tasks 1–3); `film_core::decode::decode_raw`; `film_core::calibrate::sample_base_clearfilm`; `film_core::chart::{sample_grid, GridSpec, sampling_overlay}`; `film_core::engine::{invert_image, InversionParams, Mode}`.
- Produces: `pub fn run(manifest_path: &str, out_dir: &str) -> Result<(), String>` and a `tone` subcommand in `main`.

- [ ] **Step 1: Write the runner**

Create `crates/film-bench/src/tone_run.rs`:

```rust
use crate::wedge::{load_manifest, load_reference, target_lstar, RefPatch, WedgeFrame};
use film_core::calibrate::sample_base_clearfilm;
use film_core::chart::{sample_grid, sampling_overlay, GridSpec};
use film_core::decode::decode_raw;
use film_core::engine::{invert_image, InversionParams, Mode};
use film_core::tone::{fit_tone, transfer_metrics, ev_weight, FitMode, TonePoint, Transfer};
use std::path::Path;

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Sample one frame's 100 patches (raw negative values), rank-pair to the reference
/// EVs, attach base offset → absolute-EV TonePoints. `ref_sorted` is the reference
/// patches sorted ascending by EV; `value_max` is the global brightest `数值`.
fn frame_points(
    f: &WedgeFrame,
    dir: &str,
    ref_sorted: &[RefPatch],
    value_max: f32,
    out_dir: &str,
) -> Result<Vec<TonePoint>, String> {
    let path = Path::new(dir).join(&f.file);
    let neg = decode_raw(&path).map_err(|e| format!("decode {}: {e}", path.display()))?;
    let base = sample_base_clearfilm(&neg, 0.92, 0.95);
    let spec = GridSpec { cols: 10, rows: 10, inset: 0.45 };
    let scans = sample_grid(&neg, &f.corners, &spec, 0.2); // 100 raw negative patches

    // Overlay (verification) from the neutral inversion of this frame.
    let pos = invert_image(&neg, &InversionParams { base, ..Default::default() }, Mode::D);
    let ov = sampling_overlay(&pos, &f.corners, &spec, 1600);
    let ovp = format!("{out_dir}/overlay_{}.png", sanitize(&f.file));
    ov.save(&ovp).map_err(|e| format!("save {ovp}: {e}"))?;

    // Rank-pair: sort sampled patches by brightness (luma of the inverted positive is
    // monotone in scene EV); pair rank-wise with EV-ascending reference patches.
    let pos_patches = sample_grid(&pos, &f.corners, &spec, 0.2);
    let mut order: Vec<usize> = (0..scans.len()).collect();
    let luma = |p: [f32; 3]| 0.2627 * p[0] + 0.678 * p[1] + 0.0593 * p[2];
    order.sort_by(|&a, &b| luma(pos_patches[a]).partial_cmp(&luma(pos_patches[b])).unwrap());
    // order[k] = index of the k-th darkest patch; ref_sorted[k] = k-th lowest EV.

    let mut pts = Vec::with_capacity(scans.len());
    for (k, &i) in order.iter().enumerate() {
        let rp = ref_sorted[k.min(ref_sorted.len() - 1)];
        let abs_ev = rp.ev + f.base_ev;
        pts.push(TonePoint {
            scan: scans[i],
            base,
            target_l: target_lstar(rp.value, value_max),
            weight: ev_weight(abs_ev),
            abs_ev,
        });
    }
    Ok(pts)
}

pub fn run(manifest_path: &str, out_dir: &str) -> Result<(), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("mkdir {out_dir}: {e}"))?;
    let m = load_manifest(manifest_path)?;
    let mut reference = load_reference(&m.reference)?;
    reference.sort_by(|a, b| a.ev.partial_cmp(&b.ev).unwrap()); // ascending EV
    let value_max = reference.iter().map(|p| p.value).fold(0.0f32, f32::max);

    let mut points: Vec<TonePoint> = Vec::new();
    for f in &m.frames {
        points.extend(frame_points(f, &m.dir, &reference, value_max, out_dir)?);
    }

    // Baseline scale = engine default d_max = 1.5 (exposure 0).
    let baseline_scale = 1.0 / 1.5;
    let base_metrics = transfer_metrics(&points, baseline_scale, &Transfer::default_filmic());

    let fits = [
        ("scale_only", fit_tone(&points, FitMode::ScaleOnly)),
        ("scale_curve", fit_tone(&points, FitMode::ScaleCurve)),
        ("gamma", fit_tone(&points, FitMode::Gamma)),
    ];

    // metrics.json
    let mut json = String::from("{\n");
    json.push_str(&format!(
        "  \"baseline\": {{ \"d_max\": 1.5, \"rms_dl\": {:.3}, \"max_dl\": {:.3}, \"frac_within5\": {:.3}, \"monotonic\": {} }},\n",
        base_metrics.rms_dl, base_metrics.max_dl, base_metrics.frac_within5, base_metrics.monotonic
    ));
    json.push_str("  \"fits\": [\n");
    for (i, (name, fr)) in fits.iter().enumerate() {
        let recommended_dmax = 1.0 / fr.scale;
        let curve = match fr.transfer {
            Transfer::Filmic { k, pivot, white_t } => format!(
                "\"filmic\", \"k\": {k:.3}, \"pivot\": {pivot:.3}, \"white_t\": {white_t:.3}"
            ),
            Transfer::Gamma { gamma } => format!("\"gamma\", \"gamma\": {gamma:.3}"),
        };
        json.push_str(&format!(
            "    {{ \"mode\": {:?}, \"residual_rms\": {:.3}, \"recommended_d_max\": {:.3}, \"transfer\": {} }}{}\n",
            name, fr.residual_rms, recommended_dmax, curve,
            if i + 1 < fits.len() { "," } else { "" }
        ));
    }
    json.push_str("  ]\n}\n");
    std::fs::write(format!("{out_dir}/tone_report.json"), json)
        .map_err(|e| format!("write report: {e}"))?;

    // transfer_curve.csv: abs_ev, target_l, baseline_l, best_fit_l
    let best = &fits.iter().min_by(|a, b| a.1.residual_rms.partial_cmp(&b.1.residual_rms).unwrap()).unwrap().1;
    let mut order: Vec<usize> = (0..points.len()).collect();
    order.sort_by(|&a, &b| points[a].abs_ev.partial_cmp(&points[b].abs_ev).unwrap());
    let mut csv = String::from("abs_ev,target_l,baseline_l,fit_l,weight\n");
    for &i in &order {
        let p = &points[i];
        let bl = film_core::tone::output_lstar(p.scan, p.base, baseline_scale, &Transfer::default_filmic());
        let fl = film_core::tone::output_lstar(p.scan, p.base, best.scale, &best.transfer);
        csv.push_str(&format!("{:.3},{:.2},{:.2},{:.2},{:.3}\n", p.abs_ev, p.target_l, bl, fl, p.weight));
    }
    std::fs::write(format!("{out_dir}/transfer_curve.csv"), csv)
        .map_err(|e| format!("write csv: {e}"))?;

    eprintln!("=== tone calibration ({} patches over ~{:.0} EV) ===", points.len(),
        order.last().map(|&i| points[i].abs_ev).unwrap_or(0.0) - order.first().map(|&i| points[i].abs_ev).unwrap_or(0.0));
    eprintln!("baseline (d_max 1.5): rms ΔL* {:.1}, max {:.1}, within5 {:.0}%, monotonic {}",
        base_metrics.rms_dl, base_metrics.max_dl, base_metrics.frac_within5 * 100.0, base_metrics.monotonic);
    for (name, fr) in &fits {
        eprintln!("  fit {name:<11}: residual ΔL* {:.1}  (recommended d_max {:.2})", fr.residual_rms, 1.0 / fr.scale);
    }
    eprintln!("outputs in {out_dir}/ (tone_report.json, transfer_curve.csv, overlay_*.png)");
    Ok(())
}
```

- [ ] **Step 2: Wire the `tone` subcommand in `main.rs`**

Edit `crates/film-bench/src/main.rs` so the top declares the modules and `main` dispatches a `tone` subcommand while keeping the existing color path. Replace the body of `main` with:

```rust
mod manifest;
mod run;
mod tone_run;
mod wedge;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("tone") {
        if args.len() != 4 {
            eprintln!("usage: film-bench tone <wedge.json> <out_dir>");
            std::process::exit(2);
        }
        if let Err(e) = tone_run::run(&args[2], &args[3]) {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
        return;
    }
    if args.len() != 3 {
        eprintln!("usage: film-bench <manifest.json> <out_dir>   |   film-bench tone <wedge.json> <out_dir>");
        std::process::exit(2);
    }
    if let Err(e) = run::run(&args[1], &args[2]) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
```

(If the existing `main.rs` already has `mod manifest;`/`mod run;` declarations at the top of the file outside `main`, keep them there and only add `mod tone_run;` + `mod wedge;` and the dispatch — do not duplicate `mod` lines.)

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build -p film-bench 2>&1 | tail -10`
Expected: `Finished`, zero warnings. (If `sample_dmax` or any signature differs from what's referenced, fix minimally and note it.)

- [ ] **Step 4: Confirm tests still pass**

Run: `cargo test -p film-bench 2>&1 | tail -4`
Expected: all pass (color + wedge tests).

- [ ] **Step 5: Commit**

```bash
git add crates/film-bench/src/tone_run.rs crates/film-bench/src/main.rs
git commit -m "feat(tone): film-bench `tone` subcommand — sample, stitch, measure, fit"
```

---

### Task 6: C400 reference + wedge manifest + baseline run (data task, HUMAN CHECKPOINT)

**Files:**
- Create: `crates/film-bench/benchdata/c400.reference.json` (generated from xlsx)
- Create: `crates/film-bench/benchdata/c400.wedge.json` (authored corners)

**Interfaces:** consumes the whole pipeline (Tasks 1–5). Produces the committed reference + manifest and the first real tone verdict.

- [ ] **Step 1: Generate the reference JSON from the xlsx**

Run this Python (stdlib only) to convert the xlsx to the committed reference:

```bash
cd /Users/mohaelder/Repos/filmrev
python3 - <<'PY'
import zipfile, re, json
import xml.etree.ElementTree as ET
z = zipfile.ZipFile("/Users/mohaelder/Desktop/C400 基准曝光数据.xlsx")
ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
r = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
def colnum(c):
    n = 0
    for ch in c: n = n*26 + (ord(ch)-64)
    return n
vals = {}  # (row,colletter) handled via cell ref; collect col C (数值=3) and D (相对ev=4)
cells = {}
for row in r.iter(ns+'row'):
    for c in row.findall(ns+'c'):
        ref = c.get('r'); cl = colnum(re.match(r'[A-Z]+', ref).group())
        rn = int(re.search(r'\d+', ref).group())
        v = c.find(ns+'v')
        if v is not None and c.get('t') != 's':
            cells[(rn, cl)] = float(v.text)
# Data rows start at spreadsheet row 2 (row 1 is the header). Column 3 = 数值, 4 = 相对ev.
patches = []
rn = 2
while (rn, 3) in cells and (rn, 4) in cells:
    patches.append({"value": cells[(rn, 3)], "ev": cells[(rn, 4)]})
    rn += 1
out = {"patches": patches}
open("crates/film-bench/benchdata/c400.reference.json", "w").write(json.dumps(out, indent=0))
print(f"wrote {len(patches)} patches; ev range {min(p['ev'] for p in patches):.2f}..{max(p['ev'] for p in patches):.2f}")
PY
```
Expected: ~100 patches, EV range ~−8.57..0.

- [ ] **Step 2: Render the 3 frames to find grid corners**

```bash
cd /Users/mohaelder/Repos/filmrev
for f in 8328 8329 8330; do
  cargo run -q --release -p film-core --example raw_dump -- "/Users/mohaelder/Desktop/c400/Capture One Catalog$f.raf" 2>/dev/null
done
ls -la /tmp/tune/   # raw_dump writes downscaled negatives here
```
Read each `/tmp/tune/Capture One Catalog<f>_raw.png` and locate the 4 corners of the **10×10 patch grid** (exclude the numbered scale border). Full-res frames are 11648×8736; convert fractional corner positions in the ~700px preview to full-res pixels (`full = frac × {11648, 8736}`).

- [ ] **Step 3: Author the wedge manifest**

Create `crates/film-bench/benchdata/c400.wedge.json` (replace `X_*`/`Y_*` with the corner pixels measured in Step 2; corner order `[TL,TR,BR,BL]` of the grid — orientation does NOT matter, rank-pairing handles it):

```json
{
  "dir": "/Users/mohaelder/Desktop/c400",
  "reference": "/Users/mohaelder/Repos/filmrev/crates/film-bench/benchdata/c400.reference.json",
  "frames": [
    { "file": "Capture One Catalog8328.raf", "base_ev": 0.0, "corners": [[X_TL,Y_TL],[X_TR,Y_TR],[X_BR,Y_BR],[X_BL,Y_BL]] },
    { "file": "Capture One Catalog8329.raf", "base_ev": 6.0, "corners": [[X_TL,Y_TL],[X_TR,Y_TR],[X_BR,Y_BR],[X_BL,Y_BL]] },
    { "file": "Capture One Catalog8330.raf", "base_ev": 9.0, "corners": [[X_TL,Y_TL],[X_TR,Y_TR],[X_BR,Y_BR],[X_BL,Y_BL]] }
  ]
}
```

- [ ] **Step 4: Run the tone calibration and verify overlays**

```bash
cargo run -q --release -p film-bench -- tone crates/film-bench/benchdata/c400.wedge.json /tmp/tone-c400
```
Expected: stderr headline with baseline rms ΔL\* and the 3 fit residuals + recommended d_max; `/tmp/tone-c400/overlay_*.png` written.

Open each `overlay_*.png` and confirm the 10×10 sampling windows sit inside the patches. Adjust corners in the JSON and re-run until aligned (each frame independently).

> **HUMAN CHECKPOINT:** Present the overlay PNGs to the user to confirm sampling is correct before trusting the numbers — same gate as the color benchmark's manifest task. Do NOT report the tone verdict as trustworthy until the user confirms the overlays.

- [ ] **Step 5: Commit**

```bash
git add crates/film-bench/benchdata/c400.reference.json crates/film-bench/benchdata/c400.wedge.json
git commit -m "data(tone): C400 reference + overlay-verified wedge manifest + baseline run"
```

---

## Self-Review

**Spec coverage:**
- Reference ingestion (xlsx → reference) → Task 6 Step 1 (Python) + Task 4 loader. ✓
- Wedge manifest (frames, base offsets, corners) → Task 4 types + Task 6 data. ✓
- Sample + rank-pair + stitch → Task 5 `frame_points`. ✓
- Measure (deviation, confidence-weighted) → Task 2 `transfer_metrics` + Task 5. ✓
- Fit + recommend (`d_max+expo`, `+curve`, `gamma`) → Task 3 `fit_tone` + Task 5 report. ✓
- `数值` encoding inferred + documented + isolated → Task 4 `target_lstar`. ✓
- Outputs (tone_report.json, transfer_curve.csv, overlays, headline) → Task 5. ✓
- Confidence weighting (~−5 EV onset) → Task 2 `ev_weight`. ✓
- Overlay human checkpoint → Task 6 Step 4. ✓
- Measurement only, engine untouched → no task edits engine.rs/shaders.ts. ✓
- Rank-pairing not orientation mapping → Task 5 `frame_points`. ✓

**Deviations from spec (deliberate, documented):**
1. xlsx parsed once by Python into committed `c400.reference.json` (Task 6), not parsed in Rust — keeps `film-bench` free of zip/xml deps (spec's "no new dep" intent). Documented.
2. Baseline uses engine default `d_max = 1.5` rather than the app's per-frame `sample_dmax`. Simpler and reproducible; the *fit* finds the optimal scale regardless, and the recommendation is expressed as a d_max. If the reviewer prefers the app's auto d_max as the baseline anchor, that's a one-line change (`sample_dmax` per frame) — noted, not blocking.

**Placeholder scan:** The only placeholders are the corner coordinates in Task 6 (`X_*`/`Y_*`), which are *data measured from the frames* (the task explains how to obtain and verify them). All code steps contain complete code.

**Type consistency:** `Transfer`, `TonePoint{scan,base,target_l,weight,abs_ev}`, `FitMode`, `FitResult{scale,transfer,residual_rms}`, `transfer_metrics`, `fit_tone`, `output_lstar`, `ev_weight`, `target_lstar`, `WedgeManifest`/`WedgeFrame`/`RefPatch` names and signatures are used identically across Tasks 1–5. `value_max` threading (Task 5 `frame_points` ← global brightest `数值`) matches `target_lstar(value, value_max)`.
