# Film-Base Auto-Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the naive "brightest-cluster" film-base guess with a per-image rebate detector (bright × uniform × orange at the frame edges) so mixed-roll scans self-resolve, with a graceful fallback when a frame has no usable rebate.

**Architecture:** A pure `detect_rebate_base(&Image) -> RebateBase{base,confidence}` in film-core scans the outer edge bands and scores tiled patches. `develop_heavy` uses the detected base when `confidence ≥ REBATE_CONFIDENCE`, else falls back to today's `sample_base_coherent(BASE_BAND_AUTO)`. The active auto base + confidence are surfaced in the UI (with a low-confidence "repoint?" hint). The misfeature folder-`D_max` ("Apply D_max to roll") is removed. Base flows through `build_params`→uniforms so CPU/GPU parity is automatic.

**Tech Stack:** Rust (`film-core` + `app/src-tauri`), TypeScript/Svelte.

**Spec:** `docs/superpowers/specs/2026-06-15-film-base-detection-design.md`

**Concurrency note:** the user runs a parallel session committing to `main`, and keeps long-lived WIP in `app/src-tauri/src/*.rs`. ALWAYS stage explicit paths and commit with a pathspec (`git commit -m "..." -- <paths>`); NEVER `git add -A`.

**Verification commands:**
- `cargo test -p film-core`
- `cargo test --manifest-path app/src-tauri/Cargo.toml`
- `cargo build --manifest-path app/src-tauri/Cargo.toml`
- `cd app && npx vitest run src/lib/viewport/gl/ && npm run check`

---

## Phase A — The rebate detector (film-core)

### Task 1: `detect_rebate_base` + scoring

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (add the detector after `sample_dmax`)
- Test: `crates/film-core/src/calibrate.rs` (tests module)

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `calibrate.rs`:

```rust
    /// Build a HxW image: uniform `border` color in the outer `frac` band on all
    /// edges, `center` (optionally noisy) inside.
    fn bordered(w: usize, h: usize, border: [f32; 3], center: [f32; 3], noisy: bool) -> Image {
        let mut img = Image::new(w, h);
        let bw = (w as f32 * 0.10) as usize;
        let bh = (h as f32 * 0.10) as usize;
        for y in 0..h {
            for x in 0..w {
                let edge = x < bw || x >= w - bw || y < bh || y >= h - bh;
                let mut px = if edge { border } else { center };
                if !edge && noisy {
                    // deterministic checkerboard jitter so the center is non-uniform
                    let j = if (x + y) % 2 == 0 { 0.18 } else { -0.18 };
                    px = [(px[0] + j).clamp(0.0, 1.0), (px[1] + j).clamp(0.0, 1.0), (px[2] + j).clamp(0.0, 1.0)];
                }
                img.pixels[y * w + x] = px;
            }
        }
        img
    }

    #[test]
    fn detect_rebate_finds_orange_border_over_textured_center() {
        let orange = [0.42, 0.19, 0.10];
        let img = bordered(200, 150, orange, [0.5, 0.5, 0.5], true);
        let r = detect_rebate_base(&img);
        for c in 0..3 {
            assert!((r.base[c] - orange[c]).abs() < 0.03, "ch {c}={}", r.base[c]);
        }
        assert!(r.confidence > 0.1, "confidence {}", r.confidence);
    }

    #[test]
    fn detect_rebate_ignores_bright_blue_center_phoenix() {
        // Bright UNIFORM blue center (the failure mode) + thin orange border.
        let orange = [0.42, 0.19, 0.10];
        let img = bordered(200, 150, orange, [0.30, 0.21, 0.55], false);
        let r = detect_rebate_base(&img);
        assert!(r.base[0] > r.base[2], "must pick orange (R>B), got {:?}", r.base);
        assert!((r.base[0] - orange[0]).abs() < 0.05, "base {:?}", r.base);
    }

    #[test]
    fn detect_rebate_low_confidence_when_no_orange_border() {
        // Uniform grey to the edges → orange score 0 everywhere → low confidence.
        let img = Image { width: 200, height: 150, pixels: vec![[0.5, 0.5, 0.5]; 200 * 150], ir: None };
        let r = detect_rebate_base(&img);
        assert!(r.confidence < 0.05, "expected low confidence, got {}", r.confidence);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core detect_rebate`
Expected: FAIL — `detect_rebate_base` does not exist.

- [ ] **Step 3: Implement the detector**

Add to `calibrate.rs`:

```rust
/// Result of rebate detection: the sampled clear-film base and a 0..1 confidence.
#[derive(Debug, Clone, Copy)]
pub struct RebateBase {
    pub base: [f32; 3],
    pub confidence: f32,
}

/// Outer fraction of each edge scanned for the rebate.
const REBATE_BAND_FRAC: f32 = 0.10;
/// Patch length along the edge (in downscaled px).
const REBATE_PATCH_LEN: usize = 32;
/// Uniformity penalty: higher = stricter about flatness.
const REBATE_UNIF_K: f32 = 4.0;
/// Minimum detector score to trust the rebate base over the fallback. Provisional;
/// tuned against real scans (see plan Task 3).
pub const REBATE_CONFIDENCE: f32 = 0.15;

/// Nearest-neighbour downscale so detection stats are cheap/stable.
fn downscale_for_detect(img: &Image, target_long: usize) -> Image {
    let long = img.width.max(img.height);
    if long <= target_long {
        return img.clone();
    }
    let scale = target_long as f32 / long as f32;
    let w = ((img.width as f32 * scale) as usize).max(1);
    let h = ((img.height as f32 * scale) as usize).max(1);
    let mut pixels = vec![[0.0f32; 3]; w * h];
    for y in 0..h {
        let sy = ((y as f32 / scale) as usize).min(img.height - 1);
        for x in 0..w {
            let sx = ((x as f32 / scale) as usize).min(img.width - 1);
            pixels[y * w + x] = img.pixels[sy * img.width + sx];
        }
    }
    Image { width: w, height: h, pixels, ir: None }
}

/// Mean RGB and mean per-channel coefficient-of-variation over a window.
fn patch_stats(img: &Image, x0: usize, y0: usize, pw: usize, ph: usize) -> ([f32; 3], f32) {
    let (mut sum, mut sumsq, mut n) = ([0.0f64; 3], [0.0f64; 3], 0u64);
    for y in y0..(y0 + ph).min(img.height) {
        for x in x0..(x0 + pw).min(img.width) {
            let p = img.pixels[y * img.width + x];
            for c in 0..3 {
                sum[c] += p[c] as f64;
                sumsq[c] += (p[c] as f64) * (p[c] as f64);
            }
            n += 1;
        }
    }
    if n == 0 {
        return ([0.0; 3], 1.0);
    }
    let nf = n as f64;
    let mean = [(sum[0] / nf) as f32, (sum[1] / nf) as f32, (sum[2] / nf) as f32];
    let mut cv_sum = 0.0f32;
    for c in 0..3 {
        let m = sum[c] / nf;
        let var = (sumsq[c] / nf - m * m).max(0.0);
        cv_sum += (var.sqrt() as f32) / (m as f32).max(1e-4);
    }
    (mean, cv_sum / 3.0)
}

/// bright × uniform × orange (each clamped 0..1). Orange requires the C-41 mask
/// ordering R≥G≥B; a blue/neutral patch scores 0 even if bright and uniform.
fn rebate_score(mean: [f32; 3], cv: f32) -> f32 {
    let bright = ((mean[0] + mean[1] + mean[2]) / 3.0).clamp(0.0, 1.0);
    let uniform = (1.0 - REBATE_UNIF_K * cv).clamp(0.0, 1.0);
    let orange = if mean[0] >= mean[1] && mean[1] >= mean[2] {
        ((mean[0] - mean[2]) / mean[0].max(1e-5)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    bright * uniform * orange
}

/// Detect the C-41 orange-mask film base from the frame's edge bands. Scans the
/// outer `REBATE_BAND_FRAC` of each edge, scores tiled patches by
/// `rebate_score`, and returns the best patch's mean as `base` with its score as
/// `confidence`. Built for negatives whose rebate touches an edge.
pub fn detect_rebate_base(img: &Image) -> RebateBase {
    let small = downscale_for_detect(img, 512);
    let (w, h) = (small.width, small.height);
    if w == 0 || h == 0 {
        return RebateBase { base: [0.0; 3], confidence: 0.0 };
    }
    let bw = ((w as f32 * REBATE_BAND_FRAC) as usize).max(1);
    let bh = ((h as f32 * REBATE_BAND_FRAC) as usize).max(1);
    let mut best = RebateBase { base: [0.0; 3], confidence: 0.0 };
    let mut consider = |x0: usize, y0: usize, pw: usize, ph: usize, best: &mut RebateBase| {
        let (mean, cv) = patch_stats(&small, x0, y0, pw, ph);
        let s = rebate_score(mean, cv);
        if s > best.confidence {
            *best = RebateBase { base: mean, confidence: s };
        }
    };
    // Top & bottom bands: slide horizontally, full band height.
    let mut x = 0;
    while x < w {
        consider(x, 0, REBATE_PATCH_LEN, bh, &mut best);
        consider(x, h.saturating_sub(bh), REBATE_PATCH_LEN, bh, &mut best);
        x += REBATE_PATCH_LEN;
    }
    // Left & right bands: slide vertically, full band width.
    let mut y = 0;
    while y < h {
        consider(0, y, bw, REBATE_PATCH_LEN, &mut best);
        consider(w.saturating_sub(bw), y, bw, REBATE_PATCH_LEN, &mut best);
        y += REBATE_PATCH_LEN;
    }
    best
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core detect_rebate`
Expected: PASS. Then `cargo test -p film-core` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(calibrate): rebate film-base detector (edge bright/uniform/orange)" -- crates/film-core/src/calibrate.rs
```

---

## Phase B — Develop integration (backend)

### Task 2: `auto_base` helper + `Developed.base_confidence` + develop/rehydrate wiring

**Files:**
- Modify: `app/src-tauri/src/session.rs` (add `base_confidence` to `Developed`)
- Modify: `app/src-tauri/src/commands.rs` (`auto_base` helper, `develop_heavy`, `ensure_resident`)
- Test: `app/src-tauri/src/commands.rs` (tests module)

- [ ] **Step 1: Add the field to `Developed`**

In `session.rs`, the `Developed` struct is:
```rust
pub struct Developed {
    pub working: Image,
    pub thumb: Image,
    pub base: [f32; 3],
}
```
Add a field:
```rust
pub struct Developed {
    pub working: Image,
    pub thumb: Image,
    pub base: [f32; 3],
    /// Detector confidence (0..1) for the auto base; low → UI suggests a repoint.
    pub base_confidence: f32,
}
```

- [ ] **Step 2: Write the failing test for `auto_base`**

Add to the `commands.rs` tests module:
```rust
    #[test]
    fn auto_base_prefers_detected_rebate_else_fallback() {
        use film_core::Image;
        // Orange border over grey center → detector confident → detected base used.
        let mut img = Image::new(200, 150);
        let (bw, bh) = (20usize, 15usize);
        for y in 0..150 {
            for x in 0..200 {
                let edge = x < bw || x >= 200 - bw || y < bh || y >= 150 - bh;
                img.pixels[y * 200 + x] = if edge { [0.42, 0.19, 0.10] } else { [0.5, 0.5, 0.5] };
            }
        }
        let (base, conf) = auto_base(&img);
        assert!(conf >= film_core::calibrate::REBATE_CONFIDENCE, "should be confident: {conf}");
        assert!((base[0] - 0.42).abs() < 0.04 && base[0] > base[2], "detected orange: {base:?}");

        // Uniform grey everywhere → no orange border → fallback (brightest cluster).
        let grey = Image { width: 64, height: 64, pixels: vec![[0.5, 0.5, 0.5]; 64 * 64], ir: None };
        let (fb, fconf) = auto_base(&grey);
        assert!(fconf < film_core::calibrate::REBATE_CONFIDENCE, "fallback path: {fconf}");
        // Fallback base equals sample_base_coherent(AUTO) on the same image.
        let (lo, hi) = film_core::calibrate::BASE_BAND_AUTO;
        let want = film_core::calibrate::sample_base_coherent(&grey, None, lo, hi);
        for c in 0..3 {
            assert!((fb[c] - want[c]).abs() < 1e-4, "ch {c}: {} vs {}", fb[c], want[c]);
        }
    }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml auto_base_prefers_detected`
Expected: FAIL — `auto_base` does not exist.

- [ ] **Step 4: Implement `auto_base` and wire it in**

In `commands.rs`, add the helper (near `effective_base`):
```rust
/// Pick the film base for a freshly-developed working image: the detected rebate
/// when confident, else the brightest-cluster fallback. Returns (base, confidence).
pub(crate) fn auto_base(working: &film_core::Image) -> ([f32; 3], f32) {
    use film_core::calibrate::{detect_rebate_base, sample_base_coherent, BASE_BAND_AUTO, REBATE_CONFIDENCE};
    let det = detect_rebate_base(working);
    if det.confidence >= REBATE_CONFIDENCE {
        (det.base, det.confidence)
    } else {
        let (lo, hi) = BASE_BAND_AUTO;
        (sample_base_coherent(working, None, lo, hi), det.confidence)
    }
}
```

In `develop_heavy`, replace the base-sampling lines (currently):
```rust
    let (blo, bhi) = film_core::calibrate::BASE_BAND_AUTO;
    let base = film_core::calibrate::sample_base_coherent(&working, None, blo, bhi);
```
with:
```rust
    let (base, base_confidence) = auto_base(&working);
```
and add `base_confidence` to the `Developed { working, thumb, base }` construction → `Developed { working, thumb, base, base_confidence }`.

In `ensure_resident`, the cache rehydrate builds `Developed { working, thumb, base }` from `cache::read`. Recompute confidence cheaply from the rehydrated working before constructing:
```rust
    let base_confidence = film_core::calibrate::detect_rebate_base(&working).confidence;
    // ... then:
    c.developed = Some(Developed { working, thumb, base, base_confidence });
```
(Keep the cached `base` as-is; only the confidence is recomputed.)

- [ ] **Step 5: Run test + full suite**

Run: `cargo test --manifest-path app/src-tauri/Cargo.toml auto_base_prefers_detected` → PASS
Run: `cargo test --manifest-path app/src-tauri/Cargo.toml` → all pass (fix any other `Developed { ... }` literal the compiler flags — grep `Developed {` to find them; tests/helpers may construct it).
Run: `cargo build --manifest-path app/src-tauri/Cargo.toml` → clean (only the 2 known session.rs warnings).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs
git commit -m "feat(develop): use rebate detector for film base with confident/fallback" -- app/src-tauri/src/session.rs app/src-tauri/src/commands.rs
```

---

### Task 3: Tune detector constants on real scans (CONTROLLER-DRIVEN, visual)

> **Not a subagent task** — requires looking at images. The controller runs this inline (like the tone-defaults tuning), because thresholds must be judged visually against the user's real DNGs.

**Files:**
- Modify (if needed): `crates/film-core/src/calibrate.rs` (`REBATE_BAND_FRAC`, `REBATE_UNIF_K`, `REBATE_CONFIDENCE`)
- Use: `crates/film-core/examples/` harness

- [ ] **Step 1: Add a detect-report harness** (or extend `raw_dump.rs`): for each scan, print `detect_rebate_base` `base` + `confidence`, and optionally dump the chosen patch location. Run on the 4 DNGs:
  - `/Volumes/Disk2/Film Scans/ny2026-3/Image 4.dng` (bright)
  - `/Volumes/Disk2/Film Scans/ny2026-3/Image 1 (2).dng` (Phoenix — the key case)
  - `/Volumes/Disk2/Film Scans/ny2026-3/Image 2 (2).dng` (flat)
  - `/Volumes/Disk2/Film Scans/ny2026-3/Image 7.dng` (flash)

- [ ] **Step 2: Check acceptance per image:**
  - Image 4 / 2 / 7: detected `base` is orange (R>G>B, R≈0.40–0.42) and `confidence ≥ REBATE_CONFIDENCE`.
  - **Image 1 (2) Phoenix: detected `base` is now ORANGE (R>B), not blue** — the whole point. `confidence ≥ REBATE_CONFIDENCE`.
  - Construct/confirm a rebate-less case behaves as fallback (e.g. center-crop one DNG to exclude its border, expect `confidence < REBATE_CONFIDENCE`).

- [ ] **Step 3: Adjust constants** (`REBATE_BAND_FRAC` for thin/thick borders, `REBATE_UNIF_K` for flatness strictness, `REBATE_CONFIDENCE` for the confident/fallback cut) until all four pass, **without overfitting** — re-confirm all four after each tweak. Update the Task-1 detector tests if a constant change alters their thresholds (keep them decoupled assertions where possible).

- [ ] **Step 4: Commit** any constant changes:
```bash
git add crates/film-core/src/calibrate.rs
git commit -m "tune(calibrate): rebate detector thresholds on real scans" -- crates/film-core/src/calibrate.rs
```

---

## Phase C — Surface the auto base (frontend)

### Task 4: `auto_base_info` command + API binding

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add `AutoBaseInfo` + `auto_base_info` command)
- Modify: `app/src-tauri/src/lib.rs` (register the command)
- Modify: `app/src/lib/api.ts` (add `autoBaseInfo`)

- [ ] **Step 1: Add the command** (after `sample_base_at`):
```rust
/// The active per-image AUTO base (the develop-time detected/fallback base) and
/// its detector confidence — so the UI can show what's in use and flag low confidence.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AutoBaseInfo {
    pub base: [f32; 3],
    pub confidence: f32,
}

#[tauri::command]
pub fn auto_base_info(id: String, session: State<Session>) -> Result<AutoBaseInfo, String> {
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    Ok(AutoBaseInfo { base: dev.base, confidence: dev.base_confidence })
}
```

- [ ] **Step 2: Register** `commands::auto_base_info,` in the `tauri::generate_handler![...]` list in `lib.rs` (next to `commands::sample_base_at,`).

- [ ] **Step 3: Add the API binding** in `api.ts`:
```ts
autoBaseInfo(id: string) {
  return invoke<{ base: [number, number, number]; confidence: number }>("auto_base_info", { id });
}
```

- [ ] **Step 4: Build + check**

Run: `cargo build --manifest-path app/src-tauri/Cargo.toml` → clean.
Run: `cd app && npm run check` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/lib/api.ts
git commit -m "feat(base): auto_base_info command + API binding" -- app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/lib/api.ts
```

---

### Task 5: Show the auto base + low-confidence hint (Basic.svelte)

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte`
- Modify: `app/src/lib/i18n/dict.ts` (en + zh hint key)

- [ ] **Step 1: Fetch the auto base for the active image.** In `Basic.svelte` `<script>`, add state + a loader that calls `api.autoBaseInfo($activeId)` when the active image changes (and after develop), storing `{ base, confidence } | null` in a local `autoBase`. Use the existing reactive/await pattern in this file (mirror how `seed()` is triggered). Guard against the not-developed error (try/catch, like `seed`).

- [ ] **Step 2: Make the swatch reflect the base in use.** Change:
```ts
$: effBase = $params.base_override ?? (dir ? $folderBaseByPath[dir] : null) ?? null;
```
to fall back to the fetched auto base:
```ts
$: effBase = $params.base_override ?? (dir ? $folderBaseByPath[dir] : null) ?? autoBase?.base ?? null;
```
Update `baseScope` so the "auto" scope is shown when neither override nor folder base is set (it already does), and the swatch is no longer empty because `effBase` now includes the auto base.

- [ ] **Step 3: Low-confidence hint.** When the shown base is the auto one (no override, no folder base) AND `autoBase && autoBase.confidence < REBATE_CONF_UI`, render a subtle hint line near the swatch: `{$t('base.lowConfidence')}` (e.g. "⚠ Low-confidence base — try Recalibrate"). Define `REBATE_CONF_UI = 0.15` as a local const in the component (kept in sync with the Rust `REBATE_CONFIDENCE`; a comment noting that). Add the i18n key `base.lowConfidence` in `dict.ts` for both `en` and `zh`.

- [ ] **Step 4: Verify**

Run: `cd app && npm run check` → 0 errors.
Run: `cd app && npx vitest run src/lib/viewport/gl/` → pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/Basic.svelte app/src/lib/i18n/dict.ts
git commit -m "feat(ui): surface the auto film base + low-confidence repoint hint" -- app/src/lib/develop/Basic.svelte app/src/lib/i18n/dict.ts
```

---

## Phase D — Remove the D_max-roll misfeature (frontend)

### Task 6: Drop "Apply D_max to roll" + folder-D_max

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte` (remove button + `applyDmaxRoll`; simplify auto-analyze guard + `resetBase`)
- Modify: `app/src/lib/develop/base.ts` (remove `setFolderDmax`/`clearFolderDmax`; drop folder-dmax from `withEffectiveBase`)
- Modify: `app/src/lib/store.ts` (remove `folderDmaxByPath`)
- Modify: `app/src/lib/catalog.ts` (remove the `folder_dmax:` load in `applySnapshot`)

- [ ] **Step 1: Basic.svelte.** Remove the `applyDmaxRoll` function and its `<button ... on:click={applyDmaxRoll}>{$t('base.dmaxRoll')}</button>`. In the auto-analyze reactive, drop the `folderDmaxByPath` term so the guard is just:
```ts
  if ($activeId && key !== lastCropKey && get(params).d_max_override == null) {
```
In `resetBase`, remove the `else if (dir) clearFolderDmax(dir);` branch (keep the per-image `d_max_override` clear). Remove now-unused imports (`setFolderDmax`, `clearFolderDmax`, `folderDmaxByPath`).

- [ ] **Step 2: base.ts.** Delete `setFolderDmax` and `clearFolderDmax`. In `withEffectiveBase`, drop the `d_max` folder lookup — revert to injecting only the per-image override:
```ts
export function withEffectiveBase(params: InvertParams, dir: string): InvertParams {
  const base = params.base_override ?? get(folderBaseByPath)[dir] ?? null;
  return { ...params, base_override: base };
}
```
(`d_max_override` already rides on `params`; no folder injection needed.) Remove the `folderDmaxByPath` import.

- [ ] **Step 3: store.ts.** Remove `export const folderDmaxByPath = ...`.

- [ ] **Step 4: catalog.ts.** Remove the `folder_dmax:` branch added to `applySnapshot` (keep the `folder_base:` handling).

- [ ] **Step 5: Verify**

Run: `cd app && npm run check` → 0 errors (grep `folderDmaxByPath`/`setFolderDmax`/`dmaxRoll` → no remaining references in code).
Run: `cd app && npx vitest run src/lib/viewport/gl/ src/lib/catalog.test.ts` → pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/develop/Basic.svelte app/src/lib/develop/base.ts app/src/lib/store.ts app/src/lib/catalog.ts
git commit -m "refactor(ui): remove per-roll D_max misfeature (D_max is per-image)" -- app/src/lib/develop/Basic.svelte app/src/lib/develop/base.ts app/src/lib/store.ts app/src/lib/catalog.ts
```

(Leave orphaned i18n keys `base.dmaxRoll` if removing them is noisy; optional cleanup.)

---

## Phase E — Verification

### Task 7: Full sweep + Phoenix smoke

- [ ] **Step 1: Run everything**
```bash
cargo test -p film-core
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo build --manifest-path app/src-tauri/Cargo.toml
cd app && npx vitest run src/lib/viewport/gl/ && npm run check
```
Expected: all PASS, 0 type errors, clean build (2 known session.rs warnings).

- [ ] **Step 2: Manual smoke (real app)**
  - Open the **Phoenix** frame (`Image 1 (2)`) WITHOUT manually repointing: it should now invert with a correct orange base (no super-orange cast) because the detector found the rebate. Confirm the Film Base swatch now SHOWS the auto base (not empty).
  - Open a normal frame: base swatch shows the detected orange; image looks as before or better.
  - Center-crop / pick a rebate-less frame: the low-confidence hint appears; Recalibrate still works and overrides.
  - Confirm the "Apply D_max to roll" button is gone and per-image crop auto-analyze still works.

- [ ] **Step 3: Commit any smoke fixes; stop.** Film-base detection complete. Next roadmap item: WB rebuild (Plan 3), then performance, then UX.

---

## Self-review notes
- **Spec coverage:** §3 detector (Task 1), §4 develop integration + `base_confidence` + rehydrate (Task 2) + tuning (Task 3), §5 surfacing (Tasks 4–5) + D_max-roll cleanup (Task 6), §6 testing (Tasks 1–2 unit + Task 3 visual + Task 7 smoke). All covered.
- **Type consistency:** `RebateBase { base, confidence }`, `detect_rebate_base(&Image)`, `auto_base(&Image)->([f32;3],f32)`, `Developed.base_confidence`, `AutoBaseInfo { base, confidence }`, `autoBaseInfo(id)` used consistently across tasks.
- **No cache migration:** `base_confidence` recomputed in `ensure_resident`; `cache.rs` untouched.
- **Parity:** base unchanged in how it flows to uniforms; no GPU/shader change.
- **Controller task:** Task 3 (visual tuning) is explicitly not a subagent task.
