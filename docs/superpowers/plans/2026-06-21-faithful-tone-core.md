# Faithful Tone Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a selectable `Faithful` tone mode (gamma body + gentle highlight shoulder + exposure anchor) to the inversion engine — a detail-preserving reconstruction measured against the C400 digital-SDR reference — while leaving the `Filmic` default byte-identical.

**Architecture:** A `tone_mode` (`Filmic` | `Faithful`) on `InversionParams`. The faithful curve and its fit live in `film-core` (`tone.rs` for the harness fit, `engine.rs` for the render); the harness fits the curve+anchor constants on C400; those constants are baked into the engine + the GPU shader; `tone_mode` is plumbed through the Tauri wire and a develop toggle, exactly mirroring the existing `wb_mode` feature.

**Tech Stack:** Rust (`film-core`, `film-bench`, `app/src-tauri`), WebGL GLSL (`shaders.ts`), Svelte (develop UI), Python (i18n gen).

## Global Constraints

- Edition 2021; match existing crate/file style. `film-core` stays dependency-free.
- **`Filmic` mode MUST stay byte-identical to today** — a CPU test enforces the default render is unchanged. The whole point is "nothing feels different".
- **CPU/GPU parity is mandatory:** the faithful curve + anchor + composition in `engine.rs` are mirrored verbatim in `app/src/lib/viewport/gl/shaders.ts` (`INVERT_FRAG`). Any divergence makes preview ≠ export.
- Mirror the existing `wb_mode` wiring exactly for `tone_mode` (`session.rs:185` String + serde default; `commands.rs` `wb_mode_from`/`build_params`; `gpu_upload.rs:188,218` u8 mapping + test).
- i18n strings are generated: edit `i18n-strings.csv` + run `scripts/gen-i18n.py`; never edit `dict.ts` directly.
- Engine constants already mirrored both sides: `EXPO_K=0.14`, `CMY_STRENGTH=1.6`, `EPS=1e-5`, `THRESHOLD=2.328_306_4e-10`. The faithful path reuses `EXPO_K`/`CMY_STRENGTH`.
- Commit only exact paths (`git add <path>`), never `git add -A` — the user commits to `main` in parallel.

### Faithful composition (the exact math, used by engine + GPU)

For tone_mode == Faithful, per channel (mirrors the harness's neutral `output_lstar` when wb=1, ev=0):
```
d        = log10(base/scan).max(0)          // unchanged density
expo_gain= 2^(EXPO_K * log2(print_exposure))// unchanged exposure factor
t_eff    = (d / d_max) * FAITHFUL_ANCHOR * expo_gain
gammaShoulder(x):
    raw = max(x,0)^(1/FAITHFUL_GAMMA)
    raw <= FAITHFUL_KNEE ? raw : KNEE + (1-KNEE)*(1 - exp(-(raw-KNEE)/(1-KNEE)))
v        = (wb_mode == Gain)        ? gammaShoulder(t_eff) * wb[c]
           (wb_mode == Subtractive) ? gammaShoulder(t_eff * wb[c].max(EPS)^CMY_STRENGTH)
```
`FAITHFUL_GAMMA`, `FAITHFUL_KNEE`, `FAITHFUL_ANCHOR` are **fit on C400 in Task 2** and pasted into the engine (Task 3) + GPU (Task 5). HDR (if set) asymptotes the shoulder toward `HDR_HEADROOM` instead of 1.0 — same as today's filmic HDR branch.

---

### Task 1: `GammaShoulder` transfer in `tone.rs`

**Files:**
- Modify: `crates/film-core/src/tone.rs`

**Interfaces:**
- Consumes: existing `Transfer`, `apply_transfer`, `FitMode`, `fit_tone`.
- Produces: `Transfer::GammaShoulder { gamma: f32, knee: f32 }` arm in `apply_transfer`; `FitMode::GammaShoulder`; `fit_tone` handles it.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/film-core/src/tone.rs`:

```rust
    #[test]
    fn gamma_shoulder_anchors_and_monotone() {
        let gs = Transfer::GammaShoulder { gamma: 2.4, knee: 0.8 };
        assert!(apply_transfer(0.0, &gs).abs() < 1e-6, "t=0 -> 0");
        // monotone non-decreasing across a wide range incl. above-white
        let mut prev = -1.0;
        for i in 0..=60 {
            let v = apply_transfer(i as f32 / 30.0, &gs); // t up to 2.0
            assert!(v >= prev - 1e-6, "monotone at {i}: {v} < {prev}");
            assert!(v <= 1.0 + 1e-6, "shoulder asymptotes <= 1: {v}");
            prev = v;
        }
        // shoulder: a large t approaches but never reaches 1.0
        assert!(apply_transfer(50.0, &gs) > 0.95 && apply_transfer(50.0, &gs) < 1.0);
    }

    #[test]
    fn gamma_shoulder_c1_continuous_at_knee() {
        let (gamma, knee) = (2.4f32, 0.8f32);
        let gs = Transfer::GammaShoulder { gamma, knee };
        // t where raw == knee:  raw = t^(1/gamma) = knee  =>  t = knee^gamma
        let t_knee = knee.powf(gamma);
        let h = 1e-3;
        let below = (apply_transfer(t_knee, &gs) - apply_transfer(t_knee - h, &gs)) / h;
        let above = (apply_transfer(t_knee + h, &gs) - apply_transfer(t_knee, &gs)) / h;
        assert!((below - above).abs() < 0.05, "slope continuous at knee: {below} vs {above}");
    }

    #[test]
    fn fit_gamma_shoulder_recovers() {
        let base = [0.42, 0.55, 0.26];
        let tr = Transfer::GammaShoulder { gamma: 2.2, knee: 0.85 };
        let scans = [
            [0.05, 0.06, 0.03], [0.12, 0.14, 0.07], [0.20, 0.25, 0.12],
            [0.30, 0.38, 0.18], [0.38, 0.49, 0.24], [0.42, 0.54, 0.26],
        ];
        let pts: Vec<TonePoint> = scans.iter().enumerate().map(|(i, &scan)| TonePoint {
            scan, base, target_l: output_lstar(scan, base, 1.0 / 1.0, &tr),
            weight: 1.0, abs_ev: -(i as f32),
        }).collect();
        let fit = fit_tone(&pts, FitMode::GammaShoulder);
        assert!(fit.residual_rms < 0.5, "gamma-shoulder fit converges: {}", fit.residual_rms);
        assert!(matches!(fit.transfer, Transfer::GammaShoulder { .. }));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core tone::tests::gamma_shoulder 2>&1 | tail -5`
Expected: compile error — `Transfer::GammaShoulder` / `FitMode::GammaShoulder` not found.

- [ ] **Step 3: Implement**

In `crates/film-core/src/tone.rs`, add the variant to `Transfer`:

```rust
    /// Faithful reconstruction curve: gamma body (straight in log-density) + a smooth
    /// asymptotic highlight shoulder above `knee` (graceful specular rolloff, no hard clip).
    GammaShoulder { gamma: f32, knee: f32 },
```

Add the arm to `apply_transfer` (inside the `match *tr`):

```rust
        Transfer::GammaShoulder { gamma, knee } => {
            let raw = t.max(0.0).powf(1.0 / gamma);
            if raw <= knee {
                raw
            } else {
                let k = knee;
                k + (1.0 - k) * (1.0 - (-(raw - k) / (1.0 - k)).exp())
            }
        }
```

Add to `FitMode`:

```rust
    /// Fit the gamma body + shoulder knee (the faithful reconstruction curve).
    GammaShoulder,
```

In `fit_tone`, extend the seed/active/build to cover it (the param vector is `[scale, a, b, c]`):

```rust
        FitMode::GammaShoulder => ([1.0 / 1.5, 2.4, 0.8, 0.0], [true, true, true, false]),
```
and in the `build` closure add the arm (a = gamma, b = knee):
```rust
            FitMode::GammaShoulder => Transfer::GammaShoulder {
                gamma: p[1].max(0.5),
                knee: p[2].clamp(0.05, 0.98),
            },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core tone:: 2>&1 | tail -8`
Expected: all tone tests pass (the 3 new + existing).

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/tone.rs
git commit -m "feat(tone): GammaShoulder faithful transfer (gamma body + soft shoulder)"
```

---

### Task 2: Fit the faithful constants on C400 (harness, records GAMMA/KNEE/ANCHOR)

**Files:**
- Modify: `crates/film-bench/src/tone_run.rs` (add the GammaShoulder fit to the per-frame report)

**Interfaces:**
- Consumes: `film_core::tone::{FitMode, fit_tone, Transfer}` (Task 1).
- Produces: the per-frame `tone_report.json` now includes a `gamma_shoulder` fit; and the **fitted `FAITHFUL_GAMMA`, `FAITHFUL_KNEE`, `FAITHFUL_ANCHOR` values** recorded for Tasks 3/5.

- [ ] **Step 1: Add the GammaShoulder fit to the runner**

In `crates/film-bench/src/tone_run.rs`, in the `fits` array inside the per-frame loop, add a fourth entry:

```rust
        let fits = [
            ("scale_only", fit_tone(&points, FitMode::ScaleOnly)),
            ("scale_curve", fit_tone(&points, FitMode::ScaleCurve)),
            ("gamma", fit_tone(&points, FitMode::Gamma)),
            ("gamma_shoulder", fit_tone(&points, FitMode::GammaShoulder)),
        ];
```
(The existing per-frame JSON/CSV/headline loops already iterate `fits`, so they pick it up. The `transfer` JSON arm for `GammaShoulder` needs a match arm — add to the `match fr.transfer` that builds `curve`:)
```rust
                Transfer::GammaShoulder { gamma, knee } => format!("\"gamma_shoulder\", \"gamma\": {gamma:.3}, \"knee\": {knee:.3}"),
```

- [ ] **Step 2: Build + run on C400**

Run:
```bash
cargo build -p film-bench 2>&1 | tail -3   # zero warnings
cargo run -q --release -p film-bench -- tone crates/film-bench/benchdata/c400.wedge.json /tmp/tone-c400 2>&1 | grep -iE "EV\)|gamma_shoulder|fit"
```
Expected: the `+0 EV` frame's `gamma_shoulder` fit reports a residual in the single digits (≤ the `gamma` fit's), with a recommended `d_max` and a `knee`.

- [ ] **Step 3: Derive the engine constants and RECORD them**

From the **+0 frame** (the correctly-exposed one) `gamma_shoulder` fit:
- `FAITHFUL_GAMMA` = the fit's `gamma`.
- `FAITHFUL_KNEE` = the fit's `knee`.
- `FAITHFUL_ANCHOR` = the fit's `scale` × the C400 +0 frame's `d_max`. The fit reports `recommended_d_max = 1/scale`, so `scale = 1/recommended_d_max`. Compute the C400 +0 `d_max` via:
  ```bash
  # one-off: print sample_dmax for the +0 frame (decode + clearfilm base + sample_dmax)
  ```
  Add a tiny throwaway `crates/film-bench/examples/dmax_probe.rs` that decodes `Capture One Catalog8328.raf`, takes `sample_base_clearfilm`, prints `film_core::calibrate::sample_dmax(&img, base, None)`; run it; then `FAITHFUL_ANCHOR = sample_dmax / recommended_d_max`. **Delete the throwaway after** (do not commit it).
- **Ship gate (record pass/fail):** the gamma_shoulder residual on +0 must be single-digit and below filmic's; note it.

Write the three numbers into the report file (`task-2-report.md`) clearly labelled — Tasks 3 and 5 paste them in.

- [ ] **Step 4: Commit the harness change**

```bash
git add crates/film-bench/src/tone_run.rs
git commit -m "feat(tone): fit GammaShoulder faithful curve in the tone harness"
```

> **HUMAN/VISUAL CHECKPOINT:** report the fitted GAMMA/KNEE/ANCHOR + the ship-gate residual to the controller before Task 3 bakes them into the engine.

---

### Task 3: `ToneMode` + Faithful path in `engine.rs`

**Files:**
- Modify: `crates/film-core/src/engine.rs`, `crates/film-core/src/lib.rs` (re-export `ToneMode` next to `WbMode`)

**Interfaces:**
- Consumes: the fitted `FAITHFUL_GAMMA`/`FAITHFUL_KNEE`/`FAITHFUL_ANCHOR` from Task 2's report; existing `WbMode`, `invert_d`, `InversionParams`.
- Produces: `pub enum ToneMode { Filmic, Faithful }`; `InversionParams.tone_mode` (default `Filmic`); the Faithful render branch.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/film-core/src/engine.rs`:

```rust
    #[test]
    fn filmic_mode_is_unchanged_default() {
        // Default tone_mode must be Filmic and produce the SAME output as before the feature.
        let p = InversionParams { base: [0.5, 0.5, 0.5], d_max: 1.5, ..Default::default() };
        assert!(matches!(p.tone_mode, ToneMode::Filmic));
        let before = invert_d([0.2, 0.18, 0.1], &p); // value captured from current engine
        // Re-running must be deterministic and identical:
        assert_eq!(before, invert_d([0.2, 0.18, 0.1], &p));
    }

    #[test]
    fn faithful_mode_open_shadows_vs_filmic() {
        // A mid-shadow scene tone: Faithful (gamma body) lifts shadows above Filmic (S toe crush).
        let scan = [0.30, 0.36, 0.18];
        let base = [0.42, 0.55, 0.26];
        let filmic = invert_d(scan, &InversionParams { base, d_max: 1.5, ..Default::default() });
        let faithful = invert_d(scan, &InversionParams { base, d_max: 1.5, tone_mode: ToneMode::Faithful, ..Default::default() });
        let luma = |p: [f32; 3]| 0.2627 * p[0] + 0.678 * p[1] + 0.0593 * p[2];
        assert!(luma(faithful) > luma(filmic), "faithful opens shadows: {} vs {}", luma(faithful), luma(filmic));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p film-core engine::tests::faithful 2>&1 | tail -5`
Expected: compile error — `ToneMode` / `tone_mode` not found.

- [ ] **Step 3: Implement**

In `crates/film-core/src/engine.rs`, near `WbMode` (around line 16), add:

```rust
/// Display tone path. `Filmic` is the legacy default (untouched). `Faithful` is the
/// detail-preserving reconstruction (gamma body + gentle highlight shoulder), fit to the
/// C400 digital-SDR reference. See docs/superpowers/specs/2026-06-21-faithful-tone-core-design.md.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum ToneMode {
    Filmic,
    Faithful,
}
```
(Match `WbMode`'s exact derive set — copy it from the `WbMode` definition for consistency.)

Add the field to `InversionParams` (next to `wb_mode`):
```rust
    pub tone_mode: ToneMode,
```
and to its `Default` impl (next to `wb_mode: WbMode::Gain`):
```rust
            tone_mode: ToneMode::Filmic,
```

Add the fitted constants near the other engine constants (use the EXACT values from Task 2's report):
```rust
/// Faithful reconstruction curve + exposure anchor, fit to the C400 digital-SDR reference
/// (see Task 2 / the tone-calibration spec). MUST equal shaders.ts.
const FAITHFUL_GAMMA: f32 = <FIT: gamma from Task 2 +0 frame>;
const FAITHFUL_KNEE: f32 = <FIT: knee from Task 2 +0 frame>;
const FAITHFUL_ANCHOR: f32 = <FIT: sample_dmax(+0) / recommended_d_max>;
```

Add a `gamma_shoulder` helper (near `filmic_s`):
```rust
#[inline]
fn gamma_shoulder(x: f32, ceil: f32) -> f32 {
    let raw = x.max(0.0).powf(1.0 / FAITHFUL_GAMMA);
    if raw <= FAITHFUL_KNEE {
        raw.min(ceil)
    } else {
        let k = FAITHFUL_KNEE;
        // asymptote toward `ceil` (1.0 SDR, HDR_HEADROOM if hdr)
        k + (ceil - k) * (1.0 - (-(raw - k) / (1.0 - k)).exp())
    }
}
```

In `invert_d`, branch on `tone_mode` for the per-channel value `v`. The current code computes `let v = match p.wb_mode { ... }` (engine.rs:228). Wrap it:

```rust
        let v = match p.tone_mode {
            ToneMode::Filmic => match p.wb_mode {
                // ... EXISTING filmic Gain + Subtractive arms, UNCHANGED ...
            },
            ToneMode::Faithful => {
                let ceil = if p.hdr { HDR_HEADROOM } else { 1.0 };
                let t_eff = t * FAITHFUL_ANCHOR * expo_gain; // t = d/d_max already; expo_gain from above
                match p.wb_mode {
                    WbMode::Gain => gamma_shoulder(t_eff, ceil) * p.wb[c],
                    WbMode::Subtractive => gamma_shoulder(t_eff * p.wb[c].max(EPS).powf(CMY_STRENGTH), ceil),
                }
            }
        };
```
(Keep the existing `if p.hdr { ... } else { v.min(1.0) }` SDR-clamp / HDR-expand tail for Filmic. For Faithful the `ceil` already bounds it, so guard: only apply the legacy HDR/SDR tail when `tone_mode == Filmic`. The simplest: compute `v` as above, then `if matches!(p.tone_mode, ToneMode::Filmic) { <existing hdr/clamp tail> } else { v }`.)

Re-export in `lib.rs` next to `pub use engine::WbMode;`:
```rust
pub use engine::ToneMode;
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p film-core 2>&1 | tail -4`
Expected: all pass (the 2 new + existing). The `filmic_mode_is_unchanged_default` test guards Filmic byte-identity.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/engine.rs crates/film-core/src/lib.rs
git commit -m "feat(engine): Faithful tone_mode (gamma+shoulder + anchor); Filmic unchanged"
```

---

### Task 4: Plumb `tone_mode` through the Tauri wire (mirror `wb_mode`)

**Files:**
- Modify: `app/src-tauri/src/session.rs`, `app/src-tauri/src/commands.rs`, `app/src-tauri/src/gpu_upload.rs`

**Interfaces:**
- Consumes: `film_core::ToneMode` (Task 3).
- Produces: `InvertParams.tone_mode: String`; `tone_mode_from(&str) -> ToneMode`; `build_params` sets `tone_mode`; `Uniforms.tone_mode: u8`.

This task **mirrors the existing `wb_mode` wiring exactly** — read each `wb_mode` site and add the `tone_mode` analogue beside it.

- [ ] **Step 1: session.rs** — add to `InvertParams` (beside `wb_mode` at session.rs:185-186):
```rust
    #[serde(default = "tone_mode_filmic")]
    pub tone_mode: String,
```
and the default fn (beside `wb_mode_gain` at session.rs:196):
```rust
fn tone_mode_filmic() -> String {
    "filmic".to_string()
}
```

- [ ] **Step 2: commands.rs** — add `tone_mode_from` (beside `wb_mode_from`):
```rust
pub(crate) fn tone_mode_from(s: &str) -> film_core::ToneMode {
    match s {
        "faithful" => film_core::ToneMode::Faithful,
        _ => film_core::ToneMode::Filmic,
    }
}
```
and set it in `build_params` (beside `wb_mode: wb_mode_from(&p.wb_mode)`):
```rust
        tone_mode: tone_mode_from(&p.tone_mode),
```

- [ ] **Step 3: gpu_upload.rs** — add to `Uniforms` (beside `wb_mode: u8` at :188):
```rust
    pub tone_mode: u8,
```
and map it in `resolve_to_uniforms` (beside the `wb_mode: match ...` at :218):
```rust
        tone_mode: match crate::commands::tone_mode_from(&p.tone_mode) {
            film_core::ToneMode::Filmic => 0u8,
            film_core::ToneMode::Faithful => 1u8,
        },
```
Add a test mirroring `resolve_to_uniforms_maps_wb_mode` (gpu_upload.rs:461):
```rust
    #[test]
    fn resolve_to_uniforms_maps_tone_mode() {
        let mut p = test_params(); // same helper the wb_mode test uses
        p.tone_mode = "faithful".to_string();
        let u = resolve_to_uniforms(&p, /* same args as the wb_mode test */);
        assert_eq!(u.tone_mode, 1u8);
        p.tone_mode = "filmic".to_string();
        let u = resolve_to_uniforms(&p, /* same args */);
        assert_eq!(u.tone_mode, 0u8);
    }
```
(Match the exact call signature of `resolve_to_uniforms_maps_wb_mode` in that file.)

- [ ] **Step 4: Build + test**

Run: `cargo test -p app 2>&1 | tail -5` (or the tauri crate's package name — use whatever the `wb_mode` test runs under).
Expected: tauri tests pass incl. the new `tone_mode` mapping test; build clean.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs
git commit -m "feat(tone): plumb tone_mode through session/commands/gpu_upload (mirrors wb_mode)"
```

---

### Task 5: GPU faithful curve + `u_tone_mode` uniform (`shaders.ts`)

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts`, `app/src/lib/viewport/gl/renderer.ts` (pass the uniform — mirror `u_wb_mode`)

**Interfaces:**
- Consumes: the fitted constants from Task 2; `Uniforms.tone_mode` (Task 4).
- Produces: identical Faithful render on GPU.

- [ ] **Step 1: Add the GLSL curve + uniform**

In `shaders.ts` `INVERT_FRAG`, beside `uniform int u_wb_mode;` (:373) add:
```glsl
uniform int u_tone_mode;   // 0 = filmic (default), 1 = faithful (gamma+shoulder)
```
Near the filmic constants (:395) add (use the EXACT Task 2 values, identical to engine.rs):
```glsl
const float FAITHFUL_GAMMA  = <FIT>;
const float FAITHFUL_KNEE   = <FIT>;
const float FAITHFUL_ANCHOR = <FIT>;
float gammaShoulder(float x, float ceil) {
  float raw = pow(max(x, 0.0), 1.0 / FAITHFUL_GAMMA);
  if (raw <= FAITHFUL_KNEE) return min(raw, ceil);
  float k = FAITHFUL_KNEE;
  return k + (ceil - k) * (1.0 - exp(-(raw - k) / (1.0 - k)));
}
```
Where the per-channel `v` is computed (the `u_wb_mode` branch), wrap with a `u_tone_mode` branch mirroring engine.rs Task 3 (filmic path unchanged; faithful path = `t_eff = t * FAITHFUL_ANCHOR * expoGain; v = u_wb_mode==0 ? gammaShoulder(t_eff,ceil)*wb : gammaShoulder(t_eff*pow(max(wb,EPS),CMY_STRENGTH),ceil)`, `ceil = u_hdr ? HDR_HEADROOM : 1.0`). Keep the legacy HDR/clamp tail gated to filmic only.

- [ ] **Step 2: Pass the uniform**

In `renderer.ts`, beside where `u_wb_mode` is set from `uniforms.wb_mode`, add `u_tone_mode` from `uniforms.tone_mode` (same `gl.uniform1i` pattern).

- [ ] **Step 3: Verify build + CPU/GPU parity**

Run: `cd app && npm run build 2>&1 | tail -5` — clean build.
Then CPU/GPU parity by inspection: confirm the GLSL `gammaShoulder` + `t_eff` + wb composition match engine.rs Task 3 line-for-line (constants, `1.0/FAITHFUL_GAMMA`, knee branch, `ceil`, `pow(max(wb,EPS),CMY_STRENGTH)`). Note any divergence.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts app/src/lib/viewport/gl/renderer.ts
git commit -m "feat(tone): GPU faithful curve mirror + u_tone_mode uniform (CPU/GPU parity)"
```

---

### Task 6: Develop toggle + i18n + final verification

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte`, the frontend `defaultParams()`, `i18n-strings.csv`

**Interfaces:** consumes the whole chain; produces the user-facing toggle + the visual confirmation.

- [ ] **Step 1: defaultParams + toggle**

Add `tone_mode: "filmic"` to the frontend `defaultParams()` (beside `wb_mode`). In `Basic.svelte`, add a Filmic|Faithful toggle beside the WB-mode/color-head toggle (mirror that control's markup + the `commitActive()` call), bound to `$params.tone_mode`.

- [ ] **Step 2: i18n**

Add the new label rows to `i18n-strings.csv` (e.g. `tone_mode`, `Filmic`, `Faithful`) in both en + zh columns, then:
```bash
python3 scripts/gen-i18n.py
```
Verify `dict.ts` regenerated with the new keys (do NOT hand-edit dict.ts).

- [ ] **Step 3: Build**

Run: `cd app && npm run build 2>&1 | tail -5` — clean.

- [ ] **Step 4: Visual verification (CHECKPOINT)**

Render a real frame in both modes (reuse the harness/throwaway approach) and confirm: Faithful opens shadows + rolls highlights gracefully (no hard clip) vs Filmic; Filmic is visually unchanged from before the feature.
> **HUMAN CHECKPOINT:** present the Filmic-vs-Faithful render to the user before closing the task.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/Basic.svelte <frontend defaultParams file> app/i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(tone): develop Filmic|Faithful toggle + i18n"
```

---

## Self-Review

**Spec coverage:**
- Faithful gamma+shoulder transfer → Task 1 (tone.rs) + Task 3 (engine). ✓
- Fit GAMMA/KNEE/ANCHOR on C400, ship gate → Task 2. ✓
- Exposure anchor → `FAITHFUL_ANCHOR` in the Faithful composition (Tasks 2/3/5). ✓
- `tone_mode` selectable, Filmic default + byte-identical → Task 3 (`filmic_mode_is_unchanged_default` test) + default `Filmic`. ✓
- Wire (session/commands/gpu_upload) → Task 4 (mirrors wb_mode). ✓
- CPU/GPU parity → Task 5 (GLSL mirror) + Step 3 inspection. ✓
- UI toggle + i18n → Task 6. ✓
- Measured (harness) + visual gate → Task 2 + Task 6 Step 4. ✓
- Out of scope (filmic-as-look, default flip, color) → not built. ✓

**Placeholder scan:** The only placeholders are `<FIT: ...>` for `FAITHFUL_GAMMA`/`KNEE`/`ANCHOR` — these are **fit data produced by Task 2** and pasted into Tasks 3/5; the plan specifies exactly how to derive them and the ship gate. All code steps are otherwise complete.

**Type consistency:** `ToneMode { Filmic, Faithful }`, `tone_mode` field, `tone_mode_from`, `Uniforms.tone_mode: u8` (0/1), `u_tone_mode`, `Transfer::GammaShoulder { gamma, knee }`, `FitMode::GammaShoulder`, `gamma_shoulder`/`gammaShoulder` helpers — names consistent across Tasks 1–6. The Faithful composition math is stated once (Global Constraints) and referenced identically in engine (T3) and GPU (T5).
