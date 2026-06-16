# Plan 2 — Coherent Base + Crop-Aware Analysis + Auto D_max Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Plan 1** (`2026-06-15-golden-path-plan1-one-engine.md`): assumes `build_params` already builds Cineon params unconditionally and `mode_from` always returns `Mode::D`.

**Goal:** Stop the black borders / rebate of a camera scan from poisoning the inversion (GitHub issue #1, "washed out"), by (a) sampling the film base as a single *coherent* clear-film color instead of three independent per-channel percentiles, (b) auto-deriving the Cineon `D_max` (black point) from the **image area only**, and (c) letting the user re-run that analysis inside the crop they drew, per image or per roll.

**Architecture:** Two analysis regions, kept separate (this is the crux):
- **Base / `Dmin`** comes from the *clear film* (rebate) — a user-drawn region or the bright cluster of the frame. Coherent mean of one pixel set.
- **`D_max` (and the scene-WB estimate)** comes from the *image area* — the persistent crop — so borders never enter it.

`D_max` is override-driven exactly like `base_override`: a new `d_max_override: Option<f32>` on `InvertParams`. Un-analyzed images keep the current default (`2.0`), so there's no regression and no cache-format change. An `analyze` command samples `D_max` within the crop; the frontend stores the result (per image or per roll) and auto-runs it when the crop changes.

**Tech Stack:** Rust (`film-core` + `app/src-tauri`), TypeScript/Svelte.

**Verification commands (used throughout):**
- `cargo test -p film-core`
- `cargo test --manifest-path app/src-tauri/Cargo.toml`
- `cargo build --manifest-path app/src-tauri/Cargo.toml`
- `cd app && npx vitest run src/lib/viewport/gl/ && npm run check`

---

## Phase A — Sampling primitives (film-core)

### Task 1: Coherent (single-color) base sampling

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (add `sample_base_coherent` + band constants near `sample_base:19`)
- Test: `crates/film-core/src/calibrate.rs` (tests module)

**Why:** `sample_base` takes the 95th percentile of each channel *independently*, so the three numbers don't correspond to one real clear-film color and inject a per-channel cast on colorful frames (`HANDOFF-color-cast.md:171`). A coherent sample sorts pixels by luma, takes one luma band, and averages RGB over that single pixel set.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn coherent_base_is_a_trimmed_mean_of_one_pixel_set() {
        // A clear-film rect: mostly uniform orange, plus a dark speck and a bright
        // specular speck that a central luma band must trim away.
        let mut img = Image::new(10, 1);
        for i in 0..10 {
            img.pixels[i] = [0.43, 0.19, 0.11];
        }
        img.pixels[0] = [0.02, 0.01, 0.01]; // dark speck (trimmed by lo)
        img.pixels[9] = [0.99, 0.98, 0.97]; // specular speck (trimmed by hi)
        let b = sample_base_coherent(&img, None, 0.1, 0.9);
        for c in 0..3 {
            assert!((b[c] - [0.43, 0.19, 0.11][c]).abs() < 1e-3, "ch {c} = {}", b[c]);
        }
    }

    #[test]
    fn coherent_base_bright_band_picks_clear_film_cluster() {
        // A luma gradient (dark scene → bright clear film). The bright band must
        // return ~the bright end, not the per-channel max or the global mean.
        let mut img = Image::new(100, 1);
        for i in 0..100 {
            let v = i as f32 / 99.0;
            img.pixels[i] = [v, v * 0.45, v * 0.26]; // orange-tinted ramp
        }
        let b = sample_base_coherent(&img, None, 0.90, 0.99);
        assert!(b[0] > 0.88, "bright R cluster, got {}", b[0]);
        // Coherent: the G/R and B/R ratios match the film's tint at the bright end.
        assert!((b[1] / b[0] - 0.45).abs() < 0.03, "G/R ratio {}", b[1] / b[0]);
        assert!((b[2] / b[0] - 0.26).abs() < 0.03, "B/R ratio {}", b[2] / b[0]);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core coherent_base`
Expected: FAIL — `sample_base_coherent` does not exist.

- [ ] **Step 3: Implement `sample_base_coherent`**

Add to `calibrate.rs` (after `sample_base`):

```rust
/// Luma band for sampling the base from a deliberately-drawn CLEAR-FILM rect:
/// a central trimmed mean rejects dark specks and specular hot pixels.
pub const BASE_BAND_REBATE: (f32, f32) = (0.1, 0.9);
/// Luma band for the whole-frame FALLBACK: the brightest cluster is the clear
/// film / lightbox. Trims the very top to avoid clipped specular highlights.
pub const BASE_BAND_AUTO: (f32, f32) = (0.90, 0.99);

/// Sample the film base as a single COHERENT color: collect the region's pixels,
/// sort by luma, keep the [lo, hi] luma-rank band, and average RGB over that one
/// pixel set. Unlike [`sample_base`] (three independent per-channel percentiles)
/// the result is a real clear-film color, so it removes the orange mask without
/// injecting a per-channel cast. Returns `[0,0,0]` for an empty region.
pub fn sample_base_coherent(img: &Image, rect: Option<Rect>, lo: f32, hi: f32) -> [f32; 3] {
    let r = rect.unwrap_or(Rect { x: 0, y: 0, w: img.width, h: img.height });
    let mut px: Vec<[f32; 3]> = Vec::new();
    for yy in r.y..(r.y + r.h).min(img.height) {
        for xx in r.x..(r.x + r.w).min(img.width) {
            px.push(img.pixels[yy * img.width + xx]);
        }
    }
    if px.is_empty() {
        return [0.0, 0.0, 0.0];
    }
    px.sort_by(|a, b| {
        let la = (a[0] + a[1] + a[2]) / 3.0;
        let lb = (b[0] + b[1] + b[2]) / 3.0;
        la.partial_cmp(&lb).unwrap()
    });
    let lo = lo.clamp(0.0, 1.0);
    let hi = hi.clamp(0.0, 1.0);
    let n = px.len();
    let i0 = ((n as f32 * lo) as usize).min(n - 1);
    let i1 = ((n as f32 * hi) as usize).clamp(i0 + 1, n);
    let band = &px[i0..i1];
    let mut sum = [0.0f64; 3];
    for p in band {
        for c in 0..3 {
            sum[c] += p[c] as f64;
        }
    }
    let k = band.len() as f64;
    [(sum[0] / k) as f32, (sum[1] / k) as f32, (sum[2] / k) as f32]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core coherent_base`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(calibrate): coherent single-color base sampling"
```

---

### Task 2: Auto-derive `D_max` from a region

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (add `sample_dmax`)
- Test: `crates/film-core/src/calibrate.rs` (tests module)

**Why:** Cineon needs a `D_max` (the negative's density range → the black point of the positive). The densest negative pixel (lowest transmission = brightest scene) sets it. Sampling within a rect lets the caller exclude borders.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn sample_dmax_recovers_density_range_and_clamps() {
        // base = 1.0; log-spaced transmission from 1.0 (i=0) down to 0.01 (i=99),
        // so the density range spans log10(1/0.01) = 2.0. The 1st-percentile pick
        // lands at the second-densest pixel (~0.0105 transmission → density ~1.98).
        let mut img = Image::new(100, 1);
        for i in 0..100 {
            let t = 10f32.powf(-2.0 * i as f32 / 99.0);
            img.pixels[i] = [t, t, t];
        }
        let d = sample_dmax(&img, [1.0, 1.0, 1.0], None);
        assert!((d - 2.0).abs() < 0.2, "expected ~2.0 density range, got {d}");

        // A near-clear region (all bright) → tiny range, clamped up to the floor 1.0.
        let flat = Image { width: 4, height: 1, pixels: vec![[0.9, 0.9, 0.9]; 4], ir: None };
        assert!((sample_dmax(&flat, [1.0, 1.0, 1.0], None) - 1.0).abs() < 1e-4, "floor 1.0");

        // A pitch-black region (transmission ~0) must not blow up — clamped to 4.0.
        let dark = Image { width: 4, height: 1, pixels: vec![[0.0001, 0.0001, 0.0001]; 4], ir: None };
        assert!((sample_dmax(&dark, [1.0, 1.0, 1.0], None) - 4.0).abs() < 1e-4, "ceil 4.0");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p film-core sample_dmax`
Expected: FAIL — `sample_dmax` does not exist.

- [ ] **Step 3: Implement `sample_dmax`**

Add to `calibrate.rs`:

```rust
/// Auto-derive the Cineon `D_max` (negative density range) over a region: per
/// channel take a low transmission percentile (the densest neg / brightest scene),
/// convert to density `log10(base_c / I_low_c)`, and take the max across channels
/// so no channel clips past print white. Clamped to a sane `[1.0, 4.0]`. Sampling
/// within `rect` lets the caller exclude borders (the image-area crop).
pub fn sample_dmax(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32 {
    const LOW_PCT: f32 = 0.01; // 1st percentile transmission
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
    let mut d_max = 1.0f32;
    for c in 0..3 {
        if chans[c].is_empty() || base[c] <= 1e-6 {
            continue;
        }
        chans[c].sort_by(|a, b| a.partial_cmp(b).unwrap());
        let idx = ((chans[c].len() as f32) * LOW_PCT) as usize;
        let i_low = chans[c][idx.min(chans[c].len() - 1)].max(1e-5);
        let density = (base[c] / i_low).log10();
        d_max = d_max.max(density);
    }
    d_max.clamp(1.0, 4.0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p film-core sample_dmax`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(calibrate): auto-derive Cineon D_max from a region"
```

---

## Phase B — Thread `d_max_override` + crop-aware commands (backend)

### Task 3: Add `d_max_override` to the wire contract and `build_params`

**Files:**
- Modify: `app/src-tauri/src/session.rs:55-56` (add field to `InvertParams`)
- Modify: `app/src-tauri/src/commands.rs:97` (`default_invert_params` — add the field)
- Modify: `app/src-tauri/src/commands.rs` (`build_params`, post-Plan-1 version)
- Modify: `app/src-tauri/src/commands_test_support.rs` (`sample_invert_params` — add the field)
- Test: `app/src-tauri/src/commands.rs` (tests module)

- [ ] **Step 1: Add the field to `InvertParams`**

In `session.rs`, right after the `base_override` field (`:56`), add:

```rust
    /// Per-image Cineon `D_max` (density-range / black-point) override. When set,
    /// used verbatim; when None, the engine default (2.0) is used. Set by the
    /// `analyze` command (sampled inside the image-area crop).
    #[serde(default)]
    pub d_max_override: Option<f32>,
```

- [ ] **Step 2: Add the field to both param constructors**

In `commands.rs` `default_invert_params()` (after `base_override: None,` at `:101`) add:
```rust
        d_max_override: None,
```
In `commands_test_support.rs` `sample_invert_params()` add the same `d_max_override: None,` line alongside `base_override`.

- [ ] **Step 3: Write the failing test**

```rust
    #[test]
    fn build_params_honors_d_max_override() {
        use crate::commands_test_support::sample_invert_params;
        let mut p = sample_invert_params();
        p.d_max_override = None;
        assert!((build_params(&p, [0.8, 0.6, 0.4]).d_max - 2.0).abs() < 1e-6, "default 2.0");
        p.d_max_override = Some(2.7);
        assert!((build_params(&p, [0.8, 0.6, 0.4]).d_max - 2.7).abs() < 1e-6, "override used");
    }
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml build_params_honors_d_max_override`
Expected: FAIL — `build_params` always uses the default `d_max`.

- [ ] **Step 5: Make `build_params` honor the override**

In the Plan-1 `build_params`, add the `d_max` line:

```rust
pub(crate) fn build_params(p: &InvertParams, base: [f32; 3]) -> InversionParams {
    InversionParams {
        base,
        print_exposure: 2f32.powf(p.exposure),
        d_max: p.d_max_override.unwrap_or(2.0),
        ..Default::default()
    }
}
```

- [ ] **Step 6: Run test to verify it passes; then run the full backend suite**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml build_params_honors_d_max_override`
Expected: PASS
Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS (serde-default test `invert_params_backfills_missing_fields_via_serde_default` still green — the new field defaults).

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/commands_test_support.rs
git commit -m "feat(engine): per-image D_max override plumbed through build_params"
```

---

### Task 4: Verify the override reaches the GPU uniforms

**Files:**
- Test: `app/src-tauri/src/gpu_upload.rs` (tests module)

`resolve_to_uniforms` copies `ip.d_max`, so the override already flows. Lock it with a test.

- [ ] **Step 1: Write the test**

```rust
    #[test]
    fn uniforms_reflect_d_max_override() {
        let mut p = sample_invert_params();
        p.d_max_override = Some(2.6);
        let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
        assert_eq!(u.mode, 3);
        assert!((u.d_max - 2.6).abs() < 1e-6, "override → uniform d_max");
    }
```

- [ ] **Step 2: Run it**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml uniforms_reflect_d_max_override`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/gpu_upload.rs
git commit -m "test(engine): D_max override reaches GPU uniforms"
```

---

### Task 5: `analyze` command — crop-aware `D_max`

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add `Analysis` struct + `analyze` command near `sample_base_at:1291`)
- Modify: `app/src-tauri/src/lib.rs` (register `analyze` in the `tauri::generate_handler!` list — find the existing list that includes `sample_base_at`)
- Test: covered by `sample_dmax` (Task 2); the command is a thin wrapper. Add one wrapper test.

- [ ] **Step 1: Add the command**

In `commands.rs`, after `sample_base_at`:

```rust
/// Result of `analyze`: the auto-derived Cineon black point for the image area.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Analysis {
    pub d_max: f32,
}

/// Auto-derive `D_max` from the IMAGE AREA (the persistent crop, normalized
/// [x,y,w,h] 0..1 in working space). Excluding the borders is the whole point —
/// black surround / rebate would otherwise inflate the density range and wash the
/// image out (GitHub issue #1). `crop = None` analyzes the whole frame.
#[tauri::command]
pub fn analyze(
    id: String,
    params: InvertParams,
    crop: Option<[f64; 4]>,
    session: State<Session>,
) -> Result<Analysis, String> {
    use film_core::calibrate::{sample_dmax, Rect};
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let base = effective_base(&params, dev.base);
    let rect = crop.map(|nc| {
        let (x, y, w, h) = crop_px(nc, dev.working.width, dev.working.height);
        Rect { x, y, w, h }
    });
    Ok(Analysis {
        d_max: sample_dmax(&dev.working, base, rect),
    })
}
```

- [ ] **Step 2: Register the command**

In `app/src-tauri/src/lib.rs`, add `commands::analyze,` to the `tauri::generate_handler![...]` macro (next to `commands::sample_base_at,`).

- [ ] **Step 3: Build**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: clean build (the command compiles and is registered).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(analyze): crop-aware auto D_max command"
```

---

### Task 6: Make the base picker + develop fallback use coherent sampling

**Files:**
- Modify: `app/src-tauri/src/commands.rs:1301` (`sample_base_at` → coherent rebate band)
- Modify: `app/src-tauri/src/commands.rs:491` (`develop_heavy` base → coherent auto band)

- [ ] **Step 1: Switch `sample_base_at` to coherent (rebate band)**

In `sample_base_at`, replace the final line `Ok(sample_base(&dev.working, Some(Rect { x, y, w, h })))` with:

```rust
    use film_core::calibrate::{sample_base_coherent, BASE_BAND_REBATE};
    let (lo, hi) = BASE_BAND_REBATE;
    Ok(sample_base_coherent(
        &dev.working,
        Some(Rect { x, y, w, h }),
        lo,
        hi,
    ))
```
(Keep the existing `use film_core::calibrate::Rect;` at the top of the fn, or fold it into this `use`.)

- [ ] **Step 2: Switch the develop-time fallback base to coherent (auto band)**

In `develop_heavy`, replace `let base = sample_base(&working, None);` (`:491`) with:

```rust
    let (blo, bhi) = film_core::calibrate::BASE_BAND_AUTO;
    let base = film_core::calibrate::sample_base_coherent(&working, None, blo, bhi);
```

- [ ] **Step 3: Build and run the backend suite**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml && cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS. (`sample_base` may now be unused in product code but is still used by its own tests; leave it. If clippy flags it as dead, add `#[allow(dead_code)]` with a comment, or remove it and its tests in a follow-up.)

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(calibrate): base picker + develop fallback use coherent sampling"
```

---

### Task 7: Make `as_shot_wb` crop-aware (image-area only)

**Files:**
- Modify: `app/src-tauri/src/commands.rs:1029-1053` (`as_shot_wb` — add an optional crop)
- Modify: `app/src/lib/api.ts` (the `asShotWb` call signature — add the crop arg) — done in Phase C, but note the new param here

**Why:** the scene-WB estimate must come from the image area, not the borders. (The *estimator algorithm* swap is Plan 3; this task only fixes the **region**.)

- [ ] **Step 1: Add an optional crop and sample within it**

Change the signature and body of `as_shot_wb`:

```rust
#[tauri::command]
pub fn as_shot_wb(
    id: String,
    params: InvertParams,
    crop: Option<[f64; 4]>,
    session: State<Session>,
) -> Result<AsShotWb, String> {
    use film_core::calibrate::Rect;
    ensure_resident(&session, &id)?;
    let (base, thumb) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (dev.base, dev.thumb.clone())
    };
    // Restrict the estimate to the image area so borders/rebate don't bias WB.
    let thumb = match crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, thumb.width, thumb.height);
            crate::convert::crop(&thumb, x, y, w, h)
        }
        None => thumb,
    };
    let _ = Rect; // (Rect import kept for symmetry with other sampling sites)
    let ip = build_params(&params, effective_base(&params, base));
    let first = invert_image(&thumb, &ip, mode_from(&params.mode));
    let gains = auto_wb_gains(&first);
    let (temp, tint) = gains_to_cct(gains);
    Ok(AsShotWb { temp, tint: tint * 150.0 })
}
```

(Drop the unused `Rect`/`let _ = Rect;` line if `crop` is the only sampling here — keep the code warning-free. `crate::convert::crop` is the same crop helper `render_view` uses.)

- [ ] **Step 2: Build the backend**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: clean build. (Frontend `asShotWb` callers are updated in Phase C; the Rust signature now requires the `crop` arg over the IPC boundary.)

- [ ] **Step 3: Run the backend suite**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(wb): as_shot_wb estimates within the image-area crop"
```

---

## Phase C — Frontend wiring

### Task 8: `d_max_override` + `analyze` + crop-aware Auto WB in the UI

**Files:**
- Modify: `app/src/lib/api.ts` (`InvertParams` type: add `d_max_override`; `defaultParams()`: `d_max_override: null`; add `analyze(id, params, crop)`; add the `crop` arg to `asShotWb`)
- Modify: `app/src/lib/develop/base.ts` (add `folderDmaxByPath` handling alongside `folderBaseByPath`)
- Modify: `app/src/lib/store.ts` (add a `folderDmaxByPath` store next to `folderBaseByPath`)
- Modify: `app/src/lib/develop/Basic.svelte` (a "Re-analyze" action; pass the crop to `autoWb`; apply analyzed `d_max`)
- Modify: `app/src/lib/tabs/Develop.svelte` (provide the persistent crop to `Basic`; auto-analyze on crop change)

> Frontend has no component-level unit tests in this repo; verify with `npm run check` + the GL vitest + a manual smoke. Keep each step small and commit.

- [ ] **Step 1: Extend the API surface**

In `api.ts`:
- Add `d_max_override: number | null;` to the `InvertParams` type (near `base_override`).
- In `defaultParams()` add `d_max_override: null,`.
- Add `crop` to `asShotWb`:
  ```ts
  asShotWb(id: string, params: InvertParams, crop: [number, number, number, number] | null = null) {
    return invoke<{ temp: number; tint: number }>("as_shot_wb", { id, params, crop });
  }
  ```
- Add `analyze`:
  ```ts
  analyze(id: string, params: InvertParams, crop: [number, number, number, number] | null = null) {
    return invoke<{ d_max: number }>("analyze", { id, params, crop });
  }
  ```

- [ ] **Step 2: Add the folder-level `D_max` store + helpers**

In `store.ts`, next to `folderBaseByPath`, add:
```ts
export const folderDmaxByPath = writable<Record<string, number>>({});
```
In `base.ts`, extend `withEffectiveBase` to also inject `d_max_override`, and add set/clear helpers:
```ts
export function withEffectiveBase(params: InvertParams, dir: string): InvertParams {
  const base = params.base_override ?? get(folderBaseByPath)[dir] ?? null;
  const dMax = params.d_max_override ?? get(folderDmaxByPath)[dir] ?? null;
  return { ...params, base_override: base, d_max_override: dMax };
}
export function setFolderDmax(dir: string, dMax: number): void {
  folderDmaxByPath.update((m) => ({ ...m, [dir]: dMax }));
  api.saveAppState(`folder_dmax:${dir}`, String(dMax)).catch(() => {});
}
export function clearFolderDmax(dir: string): void {
  folderDmaxByPath.update((m) => { const n = { ...m }; delete n[dir]; return n; });
  api.saveAppState(`folder_dmax:${dir}`, "").catch(() => {});
}
```
(Import `folderDmaxByPath` in `base.ts`. Mirror however `folder_base:` keys are loaded at startup — find that loader and add a `folder_dmax:` branch so the per-roll `D_max` persists.)

- [ ] **Step 3: Pass the persistent crop into Basic + auto-analyze on crop change**

In `Develop.svelte`, the persistent crop is `committed`/`imageCrop` (a normalized `[x,y,w,h]` or a `CropRect`). Pass it to `Basic` as a prop:
```svelte
<Basic onWbPick={toggleWbPick} wbPicking={pickTarget === "wb"} imageCrop={imageCrop} />
```
(Use the same normalized `image_crop` value `render_view`/`Viewport` already receive. If only a `CropRect` is in scope, convert it to the `[x,y,w,h]` form the backend `crop_px` expects — the same conversion the viewport already does.)

- [ ] **Step 4: Use the crop in `Basic.svelte`'s Auto WB + add Re-analyze**

In `Basic.svelte`:
- Add `export let imageCrop: [number, number, number, number] | null = null;`.
- In `seed()`, pass the crop to the estimate:
  ```ts
  const wb = await api.asShotWb(id!, withEffectiveBase(get(params), dir), imageCrop);
  ```
- Add a Re-analyze action that derives `D_max` from the crop and applies it (this image), then reseeds WB:
  ```ts
  async function reanalyze() {
    const id = get(activeId); if (!id) return;
    const { d_max } = await api.analyze(id, withEffectiveBase(get(params), dir), imageCrop);
    params.update((p) => ({ ...p, d_max_override: d_max }));
    commitActive();
    autoWb();
  }
  ```
  Wire `reanalyze` to a button in the Film Base tools block (next to "Recalibrate"), labelled e.g. `Re-analyze (within crop)`. For per-roll, add an "Apply D_max to roll" path that calls `setFolderDmax(dir, d_max)` instead of setting `base_override` — mirror the existing `applyBaseRoll`/`applyBaseThisImage` buttons.

- [ ] **Step 5: Auto-analyze when the crop changes**

In `Basic.svelte`, add a reactive that re-derives `D_max` when the crop changes and the user hasn't manually overridden it — mirroring the WB seed guard so it doesn't clobber a deliberate value:
```ts
let lastCropKey = "";
$: {
  const key = `${$activeId}:${JSON.stringify(imageCrop)}`;
  if ($activeId && key !== lastCropKey && get(params).d_max_override == null) {
    lastCropKey = key;
    reanalyze();
  }
}
```
(If `reanalyze` setting `d_max_override` would itself block future auto-runs, guard on a separate "user set d_max" flag instead — keep it consistent with how `wb_manual` gates WB. Simplest: only auto-run when there is no folder `D_max` and no per-image override.)

- [ ] **Step 6: Type-check + GL tests**

Run: `cd app && npm run check && npx vitest run src/lib/viewport/gl/`
Expected: 0 type errors, GL tests PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/store.ts app/src/lib/develop/base.ts app/src/lib/develop/Basic.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(ui): crop-aware analysis — coherent base, auto D_max, re-analyze"
```

---

## Phase D — Verification

### Task 9: Full green sweep + the issue #1 smoke test

- [ ] **Step 1: Run every suite**

```bash
cargo test -p film-core
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
cd app && npx vitest run src/lib/viewport/gl/ && npm run check
```
Expected: all PASS, 0 type errors, clean build.

- [ ] **Step 2: Reproduce GitHub issue #1 and confirm the fix (real app)**

Use a camera scan with large black borders (the issue #1 scenario — a square negative on a 4:3 sensor). Develop it:
1. Before cropping, note the washed-out look (low contrast / lifted black point) — this is the borders inflating analysis.
2. Switch to the Crop tool, crop tight to the image area, return to Develop.
3. Confirm the image **auto-re-analyzes**: the black point/contrast snaps to a correct range (no longer washed out), because `D_max` and the WB estimate now come from the image area only.
4. Confirm "Re-analyze (within crop)" reproduces it on demand, and that applying base/`D_max` "to roll" carries to sibling frames.
5. Confirm a frame with a deliberate per-image `D_max`/WB is **not** clobbered by the auto-analyze.

- [ ] **Step 3: Commit any smoke fixes; stop**

This completes Plan 2 and resolves GitHub issue #1. Plan 3 (two-layer WB: robust estimator + kill the reseed storm) builds on this.

---

## Self-review notes

- **Spec coverage:** implements spec §5 Plan 2 and the issue-#1 root cause (§4): coherent base (§2 bullet 4), crop-aware `D_max` + WB region, per-roll propagation. Auto-`D_max` moved here from Plan 1 as intended.
- **Two regions kept distinct:** base from clear film (rebate band / bright cluster), `D_max` + WB from the image-area crop. The plan never samples base from inside the crop (no clear film there).
- **No cache migration:** `D_max` is override-driven (`d_max_override`), default `2.0` = current behavior; `Developed`/`cache.rs` untouched.
- **Type consistency:** `d_max_override: Option<f32>` (Rust) / `d_max_override: number | null` (TS); `analyze` returns `{ d_max }` everywhere; `asShotWb` gains a trailing `crop` arg in both Rust and TS. `sample_base_coherent(img, rect, lo, hi)` and `sample_dmax(img, base, rect)` signatures are used identically in Tasks 5–6.
- **Deferred to Plan 3:** swapping the gray-world estimator for shades-of-gray/gray-edge and making per-frame WB sticky vs the reseed storm. Task 7 only fixes the WB *region*, not the algorithm.
