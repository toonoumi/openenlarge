# Spoke-aware Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-exposure, D_max, and white-balance from over-correcting when a user's crop intentionally includes the film "spokes" (sprocket holes / rebate / frame lines), by metering only the photo area.

**Architecture:** A new `film-core` detector builds a per-pixel "photo mask" that excludes the spoke/gap region. Detection branches on the `positive` flag: negatives flag pixels at-or-clearer-than the film base; positives flag pixels near either rail (black/white). Both confirm candidates by **border-connectivity** (flood-fill from the crop edge) plus **uniformity**, producing a confidence. A confidence + plausibility gate, combined with a per-image `meter_border` mode (`auto`/`exclude`/`include`), decides whether to apply the mask. The three existing crop-aware analyses (`auto_brightness`, `analyze`, `as_shot_wb`/`per_zone_wb`) each compute the mask once and feed it to mask-aware samplers. Flipping `positive` or `meter_border` re-derives metering under the corrected flag.

**Tech Stack:** Rust (`crates/film-core`, `app/src-tauri` Tauri commands), TypeScript/Svelte (`app/src`), i18n via CSV generator.

## Global Constraints

- Work is committed directly on `main` (no feature branch).
- i18n strings are generated: edit `i18n-strings.csv` then run `python3 scripts/gen-i18n.py`. NEVER hand-edit `app/src/lib/i18n/dict.ts`.
- The `positive` flag is a boolean on `InvertParams` (already wired end-to-end); `mode` is vestigial and always resolves to Cineon.
- The no-mask path (`meter_border = "include"`, or gate rejects) MUST stay behaviorally identical to today: when no mask is applied, samplers run on the same image they run on now.
- New tunable constants live at the top of `crates/film-core/src/calibrate.rs` beside the existing analysis constants.
- Rust: build/test with `cargo test -p film-core` and `cargo build -p app` (the Tauri crate is `app`). TS typecheck with `npm run check` from `app/`.

---

## File Structure

- `crates/film-core/src/calibrate.rs` — new `PhotoMask`, `MeterBorder`, `detect_photo_mask`, `gate_photo_mask`; add optional `mask` to `sample_dmax_spread` and `per_zone_wb_gains`.
- `app/src-tauri/src/session.rs` — add `meter_border: String` to `InvertParams`.
- `app/src-tauri/src/commands.rs` — masked `percentile_luma`; `meter_mask` helper; wire mask into `auto_brightness`/`auto_brightness_value`, `analyze`/`sample_dmax_oriented`, `as_shot_wb`/`auto_seed_wb`, `per_zone_wb`.
- `app/src/lib/api.ts` — add `meter_border` to the TS `InvertParams` type + `defaultParams`.
- `app/src/lib/develop/Basic.svelte` — segmented control; re-derive on `meter_border` and `positive` change.
- `i18n-strings.csv` — labels for the control.

---

### Task 1: PhotoMask + negative-path detection

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (add constants near line 91; add types + fn before the `#[cfg(test)]` module at line 627)
- Test: same file's `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub struct PhotoMask { pub mask: Vec<bool>, pub excluded_fraction: f32, pub confidence: f32 }`
  - `pub fn detect_photo_mask(scan: &Image, base: [f32; 3], positive: bool) -> PhotoMask`
  - constants `SPOKE_MARGIN: f32`, `POS_RAIL_MARGIN: f32` (positive path added in Task 2)
- Consumes: `Image { width, height, pixels: Vec<[f32;3]>, ir }`, `downscale_for_detect`, `SAMPLE_CAP` (existing in this file).

Detection runs on a `downscale_for_detect(scan, SAMPLE_CAP)` copy so cost is bounded and the mask aligns to the same 512px grid the masked samplers use. A pixel is a **candidate** when (negative) its luma is at-or-above the base luma minus a margin (i.e. as clear as the rebate, or clearer — catches both rebate and sprocket holes). Candidates are confirmed by flood-fill from the image border: only border-connected candidates become the mask, so interior near-base speckle (real scene shadows) is excluded. Confidence = border-connected ratio × uniformity of the masked region.

- [ ] **Step 1: Write the failing test**

Add to `mod tests`:

```rust
fn luma(p: [f32; 3]) -> f32 { 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] }

#[test]
fn neg_clear_border_is_masked() {
    // 20x20: outer 3px ring = clear sprocket/rebate (brighter than base),
    // interior = darker scene content. Negative.
    let base = [0.40, 0.30, 0.20]; // orange mask, luma ~0.30
    let clear = [0.95, 0.95, 0.95];
    let scene = [0.10, 0.10, 0.10];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let border = x < 3 || y < 3 || x >= 17 || y >= 17;
            img.pixels[y * 20 + x] = if border { clear } else { scene };
        }
    }
    let pm = detect_photo_mask(&img, base, false);
    // ~ (400-196)/400 border pixels excluded ≈ 0.51; allow slack for downscale.
    assert!(pm.excluded_fraction > 0.30, "frac={}", pm.excluded_fraction);
    assert!(pm.confidence > 0.5, "conf={}", pm.confidence);
    // A clearly-interior scene pixel stays in the photo (mask == true).
    let mid = (10 * pm_width_of(&img)) + 10; // see helper note below
    let _ = (mid, luma(scene)); // interior must be kept
}
```

Replace the index helper line with a direct interior check that does not depend on internal grid size — assert that the mask keeps *more than half* of pixels and excludes the border band:

```rust
    let kept = pm.mask.iter().filter(|&&m| m).count();
    assert!(kept * 2 > pm.mask.len(), "kept={kept} of {}", pm.mask.len());
```

(Delete the `mid`/`pm_width_of` placeholder lines; they were illustrative.) Final test body:

```rust
#[test]
fn neg_clear_border_is_masked() {
    let base = [0.40, 0.30, 0.20];
    let clear = [0.95, 0.95, 0.95];
    let scene = [0.10, 0.10, 0.10];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let border = x < 3 || y < 3 || x >= 17 || y >= 17;
            img.pixels[y * 20 + x] = if border { clear } else { scene };
        }
    }
    let pm = detect_photo_mask(&img, base, false);
    assert!(pm.excluded_fraction > 0.30, "frac={}", pm.excluded_fraction);
    assert!(pm.confidence > 0.5, "conf={}", pm.confidence);
    let kept = pm.mask.iter().filter(|&&m| m).count();
    assert!(kept * 2 > pm.mask.len(), "kept={kept} of {}", pm.mask.len());
}

#[test]
fn neg_spoke_free_frame_low_confidence() {
    // A gradient scene with NO clear border: nothing should mask out.
    let base = [0.40, 0.30, 0.20];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let v = 0.05 + 0.02 * x as f32; // 0.05..0.43, all darker-or-near base, no clear ring
            img.pixels[y * 20 + x] = [v, v, v];
        }
    }
    let pm = detect_photo_mask(&img, base, false);
    assert!(pm.confidence < 0.5 || pm.excluded_fraction < 0.02, "frac={} conf={}", pm.excluded_fraction, pm.confidence);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p film-core neg_clear_border_is_masked neg_spoke_free`
Expected: FAIL — `cannot find function detect_photo_mask`.

- [ ] **Step 3: Add constants and implement the negative path**

Near the other constants (after `SAMPLE_CAP` at line 91), add:

```rust
/// A pixel is a spoke "candidate" (negative) when its luma is at least the base
/// luma scaled by `(1 - SPOKE_MARGIN)` — i.e. as clear as the rebate or clearer.
/// Catches the orange rebate band AND the clear sprocket holes.
const SPOKE_MARGIN: f32 = 0.25;
/// Strictness of the masked-region uniformity term in the confidence score.
const MASK_UNIF_K: f32 = 3.0;
```

Before the `#[cfg(test)]` module, add:

```rust
/// A per-pixel mask flagging the film "spokes" (sprocket holes / rebate / frame
/// lines) so metering can exclude them. `mask[i] == true` means pixel `i` is image
/// (keep); `false` means spoke/gap (exclude). Aligned to a `SAMPLE_CAP`-downscaled
/// copy of the input — the same grid the masked samplers reduce on.
#[derive(Debug, Clone)]
pub struct PhotoMask {
    pub mask: Vec<bool>,
    pub excluded_fraction: f32,
    pub confidence: f32,
}

fn luma3(p: [f32; 3]) -> f32 {
    0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
}

/// Border-connected flood fill over a candidate grid: returns the keep-mask
/// (true = image) and the count of excluded (spoke) pixels. Only candidates
/// reachable from the image edge through other candidates are excluded, so
/// interior speckle (real shadows/speculars) is kept.
fn border_connected_exclude(cand: &[bool], w: usize, h: usize) -> (Vec<bool>, usize) {
    let mut excluded = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut push = |i: usize, stack: &mut Vec<usize>, excluded: &mut Vec<bool>| {
        if cand[i] && !excluded[i] {
            excluded[i] = true;
            stack.push(i);
        }
    };
    for x in 0..w {
        push(x, &mut stack, &mut excluded); // top row
        push((h - 1) * w + x, &mut stack, &mut excluded); // bottom row
    }
    for y in 0..h {
        push(y * w, &mut stack, &mut excluded); // left col
        push(y * w + (w - 1), &mut stack, &mut excluded); // right col
    }
    while let Some(i) = stack.pop() {
        let (x, y) = (i % w, i / w);
        if x > 0 { push(i - 1, &mut stack, &mut excluded); }
        if x + 1 < w { push(i + 1, &mut stack, &mut excluded); }
        if y > 0 { push(i - w, &mut stack, &mut excluded); }
        if y + 1 < h { push(i + w, &mut stack, &mut excluded); }
    }
    let n_excl = excluded.iter().filter(|&&e| e).count();
    let keep: Vec<bool> = excluded.iter().map(|&e| !e).collect();
    (keep, n_excl)
}

/// Coefficient-of-variation of luma over the excluded (spoke) pixels — spokes are
/// flat, so low CV → high uniformity. Returns 1.0 (max uniform) for an empty set.
fn excluded_uniformity(small: &Image, keep: &[bool]) -> f32 {
    let (mut sum, mut sumsq, mut n) = (0.0f64, 0.0f64, 0u64);
    for (i, p) in small.pixels.iter().enumerate() {
        if !keep[i] {
            let l = luma3(*p) as f64;
            sum += l;
            sumsq += l * l;
            n += 1;
        }
    }
    if n == 0 {
        return 1.0;
    }
    let mean = sum / n as f64;
    let var = (sumsq / n as f64 - mean * mean).max(0.0);
    let cv = (var.sqrt() / mean.max(1e-4)) as f32;
    (1.0 - MASK_UNIF_K * cv).clamp(0.0, 1.0)
}

/// Detect the spoke/gap region. `positive` selects the value predicate; the spatial
/// confirmation (border flood-fill + uniformity) is shared. The negative predicate
/// flags pixels at-or-clearer-than the film base; the positive predicate (Task 2)
/// flags pixels near either rail.
pub fn detect_photo_mask(scan: &Image, base: [f32; 3], positive: bool) -> PhotoMask {
    let small = downscale_for_detect(scan, SAMPLE_CAP);
    let n = small.pixels.len();
    if n == 0 {
        return PhotoMask { mask: Vec::new(), excluded_fraction: 0.0, confidence: 0.0 };
    }
    let cand: Vec<bool> = if positive {
        positive_candidates(&small) // Task 2
    } else {
        let base_l = luma3(base).max(1e-4);
        let thresh = base_l * (1.0 - SPOKE_MARGIN);
        small.pixels.iter().map(|p| luma3(*p) >= thresh).collect()
    };
    let cand_count = cand.iter().filter(|&&c| c).count();
    let (keep, n_excl) = border_connected_exclude(&cand, small.width, small.height);
    let excluded_fraction = n_excl as f32 / n as f32;
    let border_ratio = if cand_count == 0 { 0.0 } else { n_excl as f32 / cand_count as f32 };
    let uniformity = excluded_uniformity(&small, &keep);
    let confidence = if n_excl == 0 { 0.0 } else { border_ratio * uniformity };
    PhotoMask { mask: keep, excluded_fraction, confidence }
}
```

For this task only (Task 2 adds the real one), add a temporary stub so the negative test compiles:

```rust
fn positive_candidates(_small: &Image) -> Vec<bool> {
    Vec::new()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p film-core neg_clear_border_is_masked neg_spoke_free`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(film-core): PhotoMask + negative-path spoke detection"
```

---

### Task 2: Positive-path detection

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (replace the `positive_candidates` stub; add `POS_RAIL_MARGIN` near the other new constants)
- Test: `mod tests`

**Interfaces:**
- Produces: `fn positive_candidates(small: &Image) -> Vec<bool>` (used by `detect_photo_mask` when `positive == true`).
- Consumes: `Image`, `luma3` (Task 1).

Positives have no film base; spokes are an extreme region at *either* rail — near-black slide rebate or near-white clear sprocket. The shared border flood-fill + uniformity confirmation (Task 1) keeps real scene shadows/speculars (interior, not border-connected) from being masked.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn pos_black_rebate_border_is_masked() {
    // Positive slide: outer ring near-black (dense rebate), interior mid-tone scene.
    let black = [0.01, 0.01, 0.01];
    let scene = [0.5, 0.45, 0.4];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let border = x < 3 || y < 3 || x >= 17 || y >= 17;
            img.pixels[y * 20 + x] = if border { black } else { scene };
        }
    }
    let pm = detect_photo_mask(&img, [0.0; 3], true);
    assert!(pm.excluded_fraction > 0.30, "frac={}", pm.excluded_fraction);
    assert!(pm.confidence > 0.5, "conf={}", pm.confidence);
}

#[test]
fn pos_white_sprocket_border_is_masked() {
    let white = [0.99, 0.99, 0.99];
    let scene = [0.5, 0.45, 0.4];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let border = x < 3 || y < 3 || x >= 17 || y >= 17;
            img.pixels[y * 20 + x] = if border { white } else { scene };
        }
    }
    let pm = detect_photo_mask(&img, [0.0; 3], true);
    assert!(pm.excluded_fraction > 0.30, "frac={}", pm.excluded_fraction);
}

#[test]
fn pos_interior_shadow_not_masked() {
    // A spoke-free slide with a deep-shadow BLOB in the interior (not border-connected).
    let scene = [0.5, 0.45, 0.4];
    let shadow = [0.01, 0.01, 0.01];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let interior_blob = (8..12).contains(&x) && (8..12).contains(&y);
            img.pixels[y * 20 + x] = if interior_blob { shadow } else { scene };
        }
    }
    let pm = detect_photo_mask(&img, [0.0; 3], true);
    // The blob doesn't touch the border, so nothing is excluded.
    assert!(pm.excluded_fraction < 0.02, "frac={}", pm.excluded_fraction);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p film-core pos_black_rebate pos_white_sprocket pos_interior_shadow`
Expected: FAIL — assertions fail (stub returns empty candidates → nothing masked).

- [ ] **Step 3: Implement the positive predicate**

Add the constant near `SPOKE_MARGIN`:

```rust
/// A pixel is a spoke "candidate" (positive) when its luma is within this of either
/// rail — near-black (slide rebate) or near-white (clear sprocket).
const POS_RAIL_MARGIN: f32 = 0.06;
```

Replace the stub with:

```rust
fn positive_candidates(small: &Image) -> Vec<bool> {
    small
        .pixels
        .iter()
        .map(|p| {
            let l = luma3(*p);
            l <= POS_RAIL_MARGIN || l >= 1.0 - POS_RAIL_MARGIN
        })
        .collect()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p film-core pos_black_rebate pos_white_sprocket pos_interior_shadow`
Expected: PASS (3 tests). Also run `cargo test -p film-core` to confirm no regressions.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(film-core): positive-path spoke detection (rail + border)"
```

---

### Task 3: MeterBorder mode + confidence/plausibility gate

**Files:**
- Modify: `crates/film-core/src/calibrate.rs`
- Test: `mod tests`

**Interfaces:**
- Produces:
  - `pub enum MeterBorder { Auto, Exclude, Include }` with `pub fn from_str_lenient(s: &str) -> MeterBorder`
  - `pub fn gate_photo_mask(pm: PhotoMask, mode: MeterBorder) -> Option<Vec<bool>>` — returns the keep-mask to apply, or `None` to meter the full region.
  - constants `CONF_THRESH`, `FRAC_MIN`, `FRAC_MAX`
- Consumes: `PhotoMask`, `detect_photo_mask`.

The gate centralizes the §2 rules: `Include` never masks; `Exclude` applies whenever the detection found a non-degenerate border region (regardless of confidence); `Auto` applies only when confident AND the excluded fraction is plausible. Degenerate guards: never return an all-false (zero-pixel) mask.

- [ ] **Step 1: Write the failing test**

```rust
fn high_conf_mask() -> PhotoMask {
    // 100 px, 30 excluded, confident.
    let mut mask = vec![true; 100];
    for i in 0..30 { mask[i] = false; }
    PhotoMask { mask, excluded_fraction: 0.30, confidence: 0.9 }
}

#[test]
fn gate_include_never_masks() {
    assert!(gate_photo_mask(high_conf_mask(), MeterBorder::Include).is_none());
}

#[test]
fn gate_auto_applies_when_confident() {
    assert!(gate_photo_mask(high_conf_mask(), MeterBorder::Auto).is_some());
}

#[test]
fn gate_auto_rejects_low_confidence() {
    let mut pm = high_conf_mask();
    pm.confidence = 0.1;
    assert!(gate_photo_mask(pm, MeterBorder::Auto).is_none());
}

#[test]
fn gate_auto_rejects_implausible_fraction() {
    let mut pm = high_conf_mask();
    pm.excluded_fraction = 0.85; // > FRAC_MAX
    assert!(gate_photo_mask(pm, MeterBorder::Auto).is_none());
}

#[test]
fn gate_exclude_forces_even_low_confidence() {
    let mut pm = high_conf_mask();
    pm.confidence = 0.0;
    assert!(gate_photo_mask(pm, MeterBorder::Exclude).is_some());
}

#[test]
fn gate_rejects_all_masked() {
    let pm = PhotoMask { mask: vec![false; 100], excluded_fraction: 1.0, confidence: 1.0 };
    assert!(gate_photo_mask(pm, MeterBorder::Exclude).is_none());
}

#[test]
fn meter_border_parse() {
    assert!(matches!(MeterBorder::from_str_lenient("exclude"), MeterBorder::Exclude));
    assert!(matches!(MeterBorder::from_str_lenient("include"), MeterBorder::Include));
    assert!(matches!(MeterBorder::from_str_lenient("auto"), MeterBorder::Auto));
    assert!(matches!(MeterBorder::from_str_lenient("garbage"), MeterBorder::Auto));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p film-core gate_ meter_border_parse`
Expected: FAIL — `cannot find type MeterBorder` / `gate_photo_mask`.

- [ ] **Step 3: Implement the enum + gate**

Add constants near the others:

```rust
/// Minimum detection confidence for `auto` to apply the mask.
const CONF_THRESH: f32 = 0.45;
/// Plausible spoke coverage band; outside this `auto` treats the frame as spoke-free.
const FRAC_MIN: f32 = 0.02;
const FRAC_MAX: f32 = 0.60;
```

Add after `detect_photo_mask`:

```rust
/// How the user's `meter_border` choice maps onto masking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeterBorder {
    Auto,
    Exclude,
    Include,
}

impl MeterBorder {
    /// Parse the wire string; unknown values default to `Auto`.
    pub fn from_str_lenient(s: &str) -> MeterBorder {
        match s {
            "exclude" => MeterBorder::Exclude,
            "include" => MeterBorder::Include,
            _ => MeterBorder::Auto,
        }
    }
}

/// Decide whether to apply `pm`'s keep-mask given the user's mode. Returns the
/// keep-mask (`true` = image pixel) to hand the samplers, or `None` to meter the
/// full region. Never returns an all-excluded mask (degenerate guard).
pub fn gate_photo_mask(pm: PhotoMask, mode: MeterBorder) -> Option<Vec<bool>> {
    let kept = pm.mask.iter().filter(|&&m| m).count();
    if kept == 0 {
        return None; // never meter zero pixels
    }
    let apply = match mode {
        MeterBorder::Include => false,
        MeterBorder::Exclude => pm.excluded_fraction > 0.0,
        MeterBorder::Auto => {
            pm.confidence >= CONF_THRESH
                && pm.excluded_fraction >= FRAC_MIN
                && pm.excluded_fraction <= FRAC_MAX
        }
    };
    if apply {
        Some(pm.mask)
    } else {
        None
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p film-core gate_ meter_border_parse`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(film-core): MeterBorder mode + confidence/plausibility gate"
```

---

### Task 4: Mask-aware `sample_dmax_spread`

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (`sample_dmax_spread` at line 386; `sample_dmax` at 378)
- Test: `mod tests`

**Interfaces:**
- Produces: `sample_dmax_spread(img, base, rect, mask: Option<&[bool]>) -> (f32, f32)` — new trailing `mask` arg, aligned to the `SAMPLE_CAP`-downscaled grid (same grid `detect_photo_mask` returns). `sample_dmax` keeps its 3-arg signature and passes `None`.
- Consumes: `downscale_for_detect`, `scaled_rect`, `SAMPLE_CAP`.

The mask aligns to the downscaled `small` image. When the caller already passes a `≤ SAMPLE_CAP` image (the analysis path does), `downscale_for_detect` returns a clone, so the mask's indices match `small` 1:1.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn dmax_mask_excludes_clear_border() {
    // 30x30 negative thumb (<= SAMPLE_CAP so no internal downscale): clear border
    // would inflate d_max; masking it out must lower the estimate.
    let base = [0.5, 0.4, 0.3];
    let clear = [0.95, 0.95, 0.95]; // very clear → huge density vs darks
    let dark = [0.02, 0.02, 0.02];
    let mut img = Image::new(30, 30);
    for y in 0..30 {
        for x in 0..30 {
            let border = x < 4 || y < 4 || x >= 26 || y >= 26;
            img.pixels[y * 30 + x] = if border { clear } else { dark };
        }
    }
    let keep: Vec<bool> = (0..900)
        .map(|i| {
            let (x, y) = (i % 30, i / 30);
            !(x < 4 || y < 4 || x >= 26 || y >= 26)
        })
        .collect();
    let (d_full, _) = sample_dmax_spread(&img, base, None, None);
    let (d_masked, _) = sample_dmax_spread(&img, base, None, Some(&keep));
    assert!(d_masked < d_full, "masked={d_masked} full={d_full}");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p film-core dmax_mask_excludes`
Expected: FAIL — `sample_dmax_spread` takes 3 args, not 4.

- [ ] **Step 3: Add the mask arg**

Change `sample_dmax` (line 378) to pass `None`:

```rust
pub fn sample_dmax(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32 {
    sample_dmax_spread(img, base, rect, None).0
}
```

Change `sample_dmax_spread` signature and the pixel-collection loop:

```rust
pub fn sample_dmax_spread(
    img: &Image,
    base: [f32; 3],
    rect: Option<Rect>,
    mask: Option<&[bool]>,
) -> (f32, f32) {
    const LOW_PCT: f32 = 0.01;
    const HIGH_PCT: f32 = 0.99;
    let small = downscale_for_detect(img, SAMPLE_CAP);
    let r = scaled_rect(rect, img, &small);
    let mask_ok = |idx: usize| mask.map_or(true, |m| m.get(idx).copied().unwrap_or(true));
    let mut chans: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for yy in r.y..(r.y + r.h).min(small.height) {
        for xx in r.x..(r.x + r.w).min(small.width) {
            let idx = yy * small.width + xx;
            if !mask_ok(idx) {
                continue;
            }
            let px = small.pixels[idx];
            for c in 0..3 {
                chans[c].push(px[c]);
            }
        }
    }
    // ... unchanged percentile/density computation ...
```

(Leave the rest of the function body — the `d_max`/`spread` loop and the `(d_max.clamp(1.0, 4.0), spread)` return — exactly as-is.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p film-core dmax_mask_excludes`
Expected: PASS. Also `cargo test -p film-core` — existing `dmax`/rebate tests must still pass (they call `sample_dmax`, unchanged).

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(film-core): optional spoke mask in sample_dmax_spread"
```

---

### Task 5: Mask-aware `per_zone_wb_gains`

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (`per_zone_wb_gains` — the function ending near line 371)
- Test: `mod tests`

**Interfaces:**
- Produces: `per_zone_wb_gains(src, strength, mask: Option<&[bool]>) -> [[f32; 3]; 3]` — new trailing `mask`. Callers in `commands.rs` (`per_zone_seed`) pass it through (Task 9).
- Consumes: existing per-zone internals.

Read the full current `per_zone_wb_gains` body first (around lines 320–371). Add a `mask` parameter and skip masked pixels wherever it iterates `src.pixels` to accumulate per-zone sums. The mask aligns to `src` (the function does not downscale; if it does, align to that grid — verify when reading).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn per_zone_mask_changes_estimate() {
    // A developed positive with a strongly-tinted border; masking it should change
    // the per-zone gains vs. including it.
    let tint = [0.9, 0.2, 0.2]; // red border
    let neutral = [0.5, 0.5, 0.5];
    let mut img = Image::new(20, 20);
    for y in 0..20 {
        for x in 0..20 {
            let border = x < 3 || y < 3 || x >= 17 || y >= 17;
            img.pixels[y * 20 + x] = if border { tint } else { neutral };
        }
    }
    let keep: Vec<bool> = (0..400)
        .map(|i| {
            let (x, y) = (i % 20, i / 20);
            !(x < 3 || y < 3 || x >= 17 || y >= 17)
        })
        .collect();
    let full = per_zone_wb_gains(&img, 0.7, None);
    let masked = per_zone_wb_gains(&img, 0.7, Some(&keep));
    assert!(full != masked, "mask had no effect");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p film-core per_zone_mask_changes`
Expected: FAIL — arity mismatch.

- [ ] **Step 3: Add the mask arg**

Add `mask: Option<&[bool]>` as the trailing parameter, and guard the per-pixel accumulation loop with the same `mask_ok(idx)` skip used in Task 4 (define the closure at the top of the function: `let mask_ok = |idx: usize| mask.map_or(true, |m| m.get(idx).copied().unwrap_or(true));`). Apply the skip to every loop that reads `src.pixels` by index. If a loop iterates `for px in &src.pixels`, convert it to `for (idx, px) in src.pixels.iter().enumerate()` and `if !mask_ok(idx) { continue; }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p film-core per_zone_mask_changes`
Expected: PASS. Run full `cargo test -p film-core`.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(film-core): optional spoke mask in per_zone_wb_gains"
```

---

### Task 6: Masked `percentile_luma` + `meter_mask` helper (commands.rs)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`percentile_luma` at line 2240; add `meter_mask` helper nearby)
- Test: add a `#[cfg(test)]` unit test in `commands.rs` (or the crate's test module if one exists — verify by reading the file tail)

**Interfaces:**
- Produces:
  - `fn percentile_luma(img: &film_core::Image, pct: f32, mask: Option<&[bool]>) -> f32`
  - `fn meter_mask(cropped: &film_core::Image, base: [f32; 3], positive: bool, mode: &str) -> Option<(film_core::Image, Vec<bool>)>` — returns the downscaled measurement image + aligned keep-mask when masking applies, else `None` (caller meters `cropped` directly).
- Consumes: `film_core::calibrate::{detect_photo_mask, gate_photo_mask, MeterBorder}`.

`meter_mask` is the shared entry the three commands call. It downscales the cropped thumb to the detect grid, runs detection + the gate, and — when a mask applies — returns that downscaled image alongside the mask so the sampler runs on the aligned grid. When no mask applies it returns `None` and the caller keeps today's full-resolution path unchanged.

- [ ] **Step 1: Write the failing test**

Add near the bottom of `commands.rs` (adjust `mod` wrapping to match the file's existing test convention):

```rust
#[cfg(test)]
mod meter_tests {
    use super::*;

    #[test]
    fn percentile_luma_mask_skips_excluded() {
        let mut img = film_core::Image::new(10, 1); // 10 px row
        for i in 0..10 {
            let v = i as f32 / 9.0; // 0.0 .. 1.0
            img.pixels[i] = [v, v, v];
        }
        // Exclude the 5 brightest; the 90th pct of the remaining {0..0.444} is low.
        let keep: Vec<bool> = (0..10).map(|i| i < 5).collect();
        let full = percentile_luma(&img, 0.90, None);
        let masked = percentile_luma(&img, 0.90, Some(&keep));
        assert!(masked < full, "masked={masked} full={full}");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p app percentile_luma_mask_skips`
Expected: FAIL — `percentile_luma` takes 2 args.

- [ ] **Step 3: Implement masked percentile + helper**

Replace `percentile_luma` (line 2240):

```rust
fn percentile_luma(img: &film_core::Image, pct: f32, mask: Option<&[bool]>) -> f32 {
    let mut ys: Vec<f32> = img
        .pixels
        .iter()
        .enumerate()
        .filter(|(i, _)| mask.map_or(true, |m| m.get(*i).copied().unwrap_or(true)))
        .map(|(_, p)| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
        .collect();
    if ys.is_empty() {
        return 0.0;
    }
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (((ys.len() - 1) as f32) * pct.clamp(0.0, 1.0)).round() as usize;
    ys[idx.min(ys.len() - 1)]
}
```

Update the existing call inside `auto_brightness_value` (line 2201) to `percentile_luma(&pos, AUTO_PCT, None)` for now (Task 7 threads the real mask).

Add the helper (place it just above `auto_brightness` near line 2137):

```rust
/// Build the spoke-exclusion keep-mask for a cropped analysis thumb, honoring the
/// `meter_border` mode + confidence gate. Returns the downscaled measurement image
/// plus an aligned keep-mask when masking applies, or `None` to meter `cropped`
/// directly (today's behavior). `base` is ignored on the positive path.
fn meter_mask(
    cropped: &film_core::Image,
    base: [f32; 3],
    positive: bool,
    mode: &str,
) -> Option<(film_core::Image, Vec<bool>)> {
    use film_core::calibrate::{detect_photo_mask, gate_photo_mask, MeterBorder};
    let mode = MeterBorder::from_str_lenient(mode);
    if mode == MeterBorder::Include {
        return None;
    }
    let pm = detect_photo_mask(cropped, base, positive);
    // detect_photo_mask downscales internally to SAMPLE_CAP; reproduce that grid so
    // the returned mask aligns to the image we hand the sampler.
    let small = film_core::calibrate::detect_grid(cropped);
    gate_photo_mask(pm, mode).map(|keep| (small, keep))
}
```

This needs a public accessor for the downscaled grid. Add to `calibrate.rs` (and a one-line re-export test is unnecessary):

```rust
/// The `SAMPLE_CAP`-downscaled grid `detect_photo_mask` runs on, exposed so callers
/// can run masked samplers on the same pixel grid the mask is aligned to.
pub fn detect_grid(img: &Image) -> Image {
    downscale_for_detect(img, SAMPLE_CAP)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p app percentile_luma_mask_skips`
Expected: PASS. Run `cargo build -p app` to confirm the helper compiles.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs crates/film-core/src/calibrate.rs
git commit -m "feat(commands): masked percentile_luma + shared meter_mask helper"
```

---

### Task 7: Add `meter_border` to params (Rust + TS)

**Files:**
- Modify: `app/src-tauri/src/session.rs` (`InvertParams`, after `positive` at line 68)
- Modify: `app/src/lib/api.ts` (TS `InvertParams` type ~line 94; `defaultParams` ~line 440)
- Test: a Rust serde round-trip test in `session.rs` (or wherever params tests live — verify by reading the file)

**Interfaces:**
- Produces: `InvertParams.meter_border: String` (Rust) / `meter_border: string` (TS), default `"auto"`, `#[serde(default = "default_meter_border")]`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

In `session.rs` tests (read the file to confirm the test module exists; if not, add one):

```rust
#[test]
fn meter_border_defaults_to_auto() {
    // An old saved edit with no meter_border key must load as "auto".
    let json = r#"{"mode":"c","stock":"none","exposure":0.0,"black":0.0,"gamma":1.0,
        "auto_wb":false,"temp":5500.0,"tint":0.0,"contrast":0.0,"highlights":0.0,
        "shadows":0.0,"whites":0.0,"blacks":0.0,"texture":0.0,"vibrance":0.0,
        "saturation":0.0}"#;
    let p: InvertParams = serde_json::from_str(json).expect("parse");
    assert_eq!(p.meter_border, "auto");
}
```

(If the existing struct requires more mandatory fields to deserialize, copy a known-good params JSON fixture already used in the file's tests instead — read the test module first.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p app meter_border_defaults_to_auto`
Expected: FAIL — no field `meter_border`.

- [ ] **Step 3: Add the field + default**

In `session.rs`, after the `positive` field (line 68):

```rust
    /// Spoke/border metering mode for auto-exposure, D_max, and WB: "auto"
    /// (confidence-gated detection), "exclude" (force), or "include" (meter the
    /// full crop — today's behavior). Defaults to "auto" for edits saved before
    /// this key existed.
    #[serde(default = "default_meter_border")]
    pub meter_border: String,
```

Add the default fn beside the other `default_*` helpers in `session.rs`:

```rust
fn default_meter_border() -> String {
    "auto".to_string()
}
```

In `api.ts`, add to the `InvertParams` interface (near the `positive: boolean;` at line 94):

```ts
  meter_border: string; // "auto" | "exclude" | "include"
```

And to `defaultParams` (near `positive: false,` at line 440):

```ts
  meter_border: "auto",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p app meter_border_defaults_to_auto`
Expected: PASS. Run `cd app && npm run check` — TS must typecheck.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src/lib/api.ts
git commit -m "feat(params): add meter_border (auto/exclude/include), default auto"
```

---

### Task 8: Wire mask into `auto_brightness`

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`auto_brightness` line 2137; `auto_brightness_value` line 2181)
- Test: extend `meter_tests`

**Interfaces:**
- Consumes: `meter_mask` (Task 6), `percentile_luma` masked (Task 6), `params.meter_border`, `params.positive`.
- Produces: `auto_brightness_value(src, params, base, dev_dmax, mask: Option<&[bool]>) -> f32`.

`auto_brightness` already crops the thumb (lines 2156–2169). After cropping, call `meter_mask`; when it returns a masked grid, measure on THAT image+mask, else measure on the cropped thumb with `None`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn auto_brightness_value_mask_lowers_exposure_drop() {
        // Adding a clear (dark-inverting) border drags the percentile down and pushes
        // exposure up; masking the border must yield a LOWER exposure than including it.
        use film_core::Image;
        let base = [0.5, 0.4, 0.3];
        let clear = [0.95, 0.95, 0.95];
        let scene = [0.2, 0.2, 0.2];
        let mut img = Image::new(40, 40);
        for y in 0..40 {
            for x in 0..40 {
                let border = x < 6 || y < 6 || x >= 34 || y >= 34;
                img.pixels[y * 40 + x] = if border { clear } else { scene };
            }
        }
        let params = crate::session::InvertParams::test_default(); // see note
        let keep: Vec<bool> = (0..1600)
            .map(|i| { let (x, y) = (i % 40, i / 40); !(x < 6 || y < 6 || x >= 34 || y >= 34) })
            .collect();
        let ev_full = auto_brightness_value(&img, &params, base, 2.0, None);
        let ev_masked = auto_brightness_value(&img, &params, base, 2.0, Some(&keep));
        assert!(ev_masked <= ev_full, "masked={ev_masked} full={ev_full}");
    }
```

If `InvertParams` has no test constructor, build it from `defaultParams`-equivalent values already used by other tests in the file (read the test module). If none exists, add a `#[cfg(test)] pub fn test_default() -> InvertParams` to `session.rs` returning a neutral params struct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p app auto_brightness_value_mask`
Expected: FAIL — arity mismatch.

- [ ] **Step 3: Thread the mask**

Change `auto_brightness_value` (line 2181) to take a trailing `mask: Option<&[bool]>`, and update the metric (line 2201) to `percentile_luma(&pos, AUTO_PCT, mask)`.

In `auto_brightness` (after the crop block ends at line 2169), replace the final call:

```rust
    let eff_base = effective_base(&params, base);
    let exposure = match meter_mask(&thumb, eff_base, params.positive, &params.meter_border) {
        Some((small, keep)) => auto_brightness_value(&small, &params, eff_base, dev_dmax, Some(&keep)),
        None => auto_brightness_value(&thumb, &params, eff_base, dev_dmax, None),
    };
    Ok(AutoBrightness { exposure })
```

(The original line 2170 computed `effective_base(&params, base)` inline; keep one binding.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p app auto_brightness_value_mask`
Expected: PASS. Run `cargo build -p app`.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/session.rs
git commit -m "feat(auto-exposure): meter only the photo area (exclude spokes)"
```

---

### Task 9: Wire mask into `analyze` (D_max) and WB commands

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`analyze` 2978 + `sample_dmax_oriented` 405; `as_shot_wb` 2006 + `auto_seed_wb` 2052; `per_zone_wb` 2085 + `per_zone_seed` 2069)
- Test: extend `meter_tests` for the D_max path

**Interfaces:**
- Consumes: `meter_mask`, masked `sample_dmax_spread` (Task 4), masked `per_zone_wb_gains` (Task 5), masked `percentile_luma`/inversion-based WB.
- Produces: `sample_dmax_oriented(working, base, crop, rot90, flip_h, flip_v, angle, mode: &str, positive: bool) -> (f32, f32)`.

The D_max path operates on `dev.working` (not the thumb), downscaling inside `sample_dmax_spread`. Compute the mask on the SAME downscaled-oriented grid so indices align: orient+crop the working image, downscale to the detect grid, detect, gate, and pass the keep-mask into `sample_dmax_spread`.

- [ ] **Step 1: Write the failing test (D_max path)**

```rust
    #[test]
    fn sample_dmax_oriented_masks_border() {
        use film_core::Image;
        let base = [0.5, 0.4, 0.3];
        let clear = [0.95, 0.95, 0.95];
        let dark = [0.02, 0.02, 0.02];
        let mut img = Image::new(60, 60);
        for y in 0..60 {
            for x in 0..60 {
                let border = x < 8 || y < 8 || x >= 52 || y >= 52;
                img.pixels[y * 60 + x] = if border { clear } else { dark };
            }
        }
        // No crop, no rotation. "include" = full; "exclude" = mask the clear border.
        let (d_full, _) = sample_dmax_oriented(&img, base, None, 0, false, false, 0.0, "include", false);
        let (d_excl, _) = sample_dmax_oriented(&img, base, None, 0, false, false, 0.0, "exclude", false);
        assert!(d_excl < d_full, "excl={d_excl} full={d_full}");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p app sample_dmax_oriented_masks_border`
Expected: FAIL — arity mismatch.

- [ ] **Step 3: Implement**

Rewrite `sample_dmax_oriented` (line 405):

```rust
#[allow(clippy::too_many_arguments)]
fn sample_dmax_oriented(
    working: &film_core::Image,
    base: [f32; 3],
    crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    mode: &str,
    positive: bool,
) -> (f32, f32) {
    use film_core::calibrate::{sample_dmax_spread, Rect};
    let geom = geom_base(working, rot90, flip_h, flip_v, angle);
    let rect = crop.map(|nc| {
        let (x, y, w, h) = crop_px(nc, geom.width, geom.height);
        Rect { x, y, w, h }
    });
    // Build the mask on the same downscaled grid sample_dmax_spread reduces on. We
    // detect over the cropped region so the mask indexes match the rect sampling.
    let cropped = match rect {
        Some(r) => film_core::convert::crop(&geom, r.x, r.y, r.w, r.h),
        None => geom.clone(),
    };
    let mask = meter_mask(&cropped, base, positive, mode);
    match mask {
        // Masked: sample the cropped+downscaled grid directly (rect = None, it's
        // already cropped), excluding spokes.
        Some((small, keep)) => sample_dmax_spread(&small, base, None, Some(&keep)),
        None => sample_dmax_spread(&geom, base, rect, None),
    }
}
```

Update `analyze`'s call (line 2997) to pass `&params.meter_border` and `params.positive`:

```rust
    let (estimate, spread) = sample_dmax_oriented(
        &dev.working, base, crop,
        rot90.unwrap_or(0), flip_h.unwrap_or(false), flip_v.unwrap_or(false), angle.unwrap_or(0.0),
        &params.meter_border, params.positive,
    );
```

For **`as_shot_wb`** (line 2043): after the existing crop block, route through the mask. Change `auto_seed_wb` (line 2052) to accept `mask: Option<&[bool]>` and, where it inverts and calls `auto_wb_gains(&first)`, restrict the gray-world estimate to masked pixels. Read `auto_wb_gains` first; add an `Option<&[bool]>` arg to it too, skipping masked pixels in its accumulation. Then in `as_shot_wb`:

```rust
    let eff_base = effective_base(&params, base);
    let (temp, tint) = match meter_mask(&thumb, eff_base, params.positive, &params.meter_border) {
        Some((small, keep)) => auto_seed_wb(&small, &params, base, dev_dmax, Some(&keep)),
        None => auto_seed_wb(&thumb, &params, base, dev_dmax, None),
    };
```

For **`per_zone_wb`** (line 2120): the mask must align to the inverted positive `small`. After `meter_mask`, invert the masked `small` and pass the keep-mask into `per_zone_seed`:

```rust
    let z = match meter_mask(&thumb, effective_base(&params, base), params.positive, &params.meter_border) {
        Some((small, keep)) => {
            let mut ip = resolve_params(&params, &small, effective_base(&params, base));
            ip.d_max = effective_dmax(&params, dev_dmax);
            let positive = invert_image(&small, &ip, mode_from(&params.mode));
            per_zone_seed(&positive, params.pz_strength, Some(&keep))
        }
        None => {
            let mut ip = resolve_params(&params, &thumb, effective_base(&params, base));
            ip.d_max = effective_dmax(&params, dev_dmax);
            let positive = invert_image(&thumb, &ip, mode_from(&params.mode));
            per_zone_seed(&positive, params.pz_strength, None)
        }
    };
```

Update `per_zone_seed` (line 2069) to forward the mask:

```rust
pub(crate) fn per_zone_seed(src: &film_core::Image, strength: f32, mask: Option<&[bool]>) -> [[f32; 3]; 3] {
    film_core::calibrate::per_zone_wb_gains(src, strength, mask)
}
```

Update `auto_seed_wb` (line 2052) signature to `(src, params, base, dev_dmax, mask: Option<&[bool]>)` and thread `mask` into the WB-gains call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app sample_dmax_oriented_masks_border` then `cargo test -p app` and `cargo test -p film-core`.
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs crates/film-core/src/calibrate.rs
git commit -m "feat(analysis): exclude spokes from D_max + WB estimation"
```

---

### Task 10: i18n strings for the control

**Files:**
- Modify: `i18n-strings.csv` (after the `basic.*` rows, ~line 234)
- Generate: `app/src/lib/i18n/dict.ts` (via script — do NOT hand-edit)

**Interfaces:**
- Produces i18n keys `basic.meterBorder`, `basic.meterBorder.auto`, `basic.meterBorder.exclude`, `basic.meterBorder.include`, `basic.meterBorderTitle`.

- [ ] **Step 1: Add CSV rows**

Append these rows in the `basic.*` block of `i18n-strings.csv` (columns: key,en,zh-CN,ja,ko,file,kind — match the existing header/column order exactly; copy a neighboring `basic.*` row's trailing two columns):

```
basic.meterBorder,Metering,测光,測光,측광,src/lib/develop/Basic.svelte,label
basic.meterBorder.auto,Auto,自动,自動,자동,src/lib/develop/Basic.svelte,option
basic.meterBorder.exclude,Exclude border,排除边框,枠を除外,테두리 제외,src/lib/develop/Basic.svelte,option
basic.meterBorder.include,Whole crop,整个裁剪,クロップ全体,전체 크롭,src/lib/develop/Basic.svelte,option
basic.meterBorderTitle,How auto-exposure / WB meter when the crop includes film spokes,当裁剪包含片孔时自动曝光/白平衡的测光方式,クロップにフィルムの送り穴が含まれる場合の自動露出/WBの測光方法,크롭에 필름 스프로킷이 포함될 때 자동 노출/화이트 밸런스 측광 방식,src/lib/develop/Basic.svelte,tooltip
```

(Verify the exact column order by reading the CSV header line first; adjust if the order differs from key,en,zh,ja,ko,file,kind.)

- [ ] **Step 2: Regenerate the dictionary**

Run: `python3 scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` updated with the new keys; no errors.

- [ ] **Step 3: Verify the keys exist**

Run: `grep -c "meterBorder" app/src/lib/i18n/dict.ts`
Expected: a count ≥ 5.

- [ ] **Step 4: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "i18n: metering-mode (spoke border) control strings"
```

---

### Task 11: Develop UI — control + re-derive on flip

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte` (segmented control in the markup near the HDR/inverse buttons ~line 319; `togglePositive` line 272; add a `setMeterBorder` handler; reuse `reanalyze`/`autoExposure`)
- Test: `cd app && npm run check` (typecheck) + manual GUI smoke (documented)

**Interfaces:**
- Consumes: `params` store, `reanalyze`, `autoExposure`, `commitActive`, `t()` i18n, `api`.
- Produces: a 3-way control bound to `params.meter_border`; both it and `togglePositive` re-derive metering.

A change to `meter_border` or `positive` must re-run `reanalyze()` (D_max + WB reseed) and re-seed exposure, respecting manual stickiness (don't reseed WB when `wb_manual`; only reseed exposure when it's untouched — reuse the same guard `seedExposure` uses, or force on explicit user action). Decision: on an explicit `meter_border` change, also re-run `autoExposure()` (the user is asking to re-meter). On `positive` toggle, re-run `reanalyze()` and re-seed exposure only if not hand-set.

- [ ] **Step 1: Read the surrounding markup + helpers**

Read `Basic.svelte` lines 140–230 (seed/reanalyze/autoExposure helpers) and 300–340 (the HDR/inverse button markup) to match existing control styling and the `expSeeded`/`wb_manual` conventions.

- [ ] **Step 2: Add the re-derive helper + control handler**

After `togglePositive` (line 275), add:

```svelte
  // Re-derive metering (D_max + WB + exposure) under the current border/positive
  // state. WB respects wb_manual (autoWb/seed already guards it); exposure re-seeds
  // only when untouched unless `force` (an explicit metering choice by the user).
  function remeterActiveExposure(force: boolean) {
    const id = get(activeId); if (!id) return;
    reanalyze(); // D_max + WB reseed (guards wb_manual internally)
    if (force || get(params).exposure === defaultParams().exposure) {
      autoExposure();
    }
  }

  function setMeterBorder(mode: "auto" | "exclude" | "include") {
    params.update((p) => ({ ...p, meter_border: mode }));
    commitActive();
    remeterActiveExposure(true);
  }
```

Update `togglePositive` to re-derive (the manual inverse must re-meter):

```svelte
  function togglePositive() {
    params.update((p) => ({ ...p, positive: !p.positive }));
    commitActive();
    remeterActiveExposure(false);
  }
```

- [ ] **Step 3: Add the segmented control markup**

Near the HDR/inverse buttons (~line 319), add (match the file's existing segmented-control / button styling — read it in Step 1):

```svelte
  <div class="row" title={t("basic.meterBorderTitle")}>
    <span class="label">{t("basic.meterBorder")}</span>
    <div class="seg">
      {#each ["auto", "exclude", "include"] as m}
        <button
          class:active={$params.meter_border === m}
          on:click={() => setMeterBorder(m)}
        >{t(`basic.meterBorder.${m}`)}</button>
      {/each}
    </div>
  </div>
```

If the file has an established segmented-control component/pattern (e.g. the keymap or look selector), use that instead of raw buttons — prefer the existing pattern found in Step 1.

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: no type errors.

- [ ] **Step 5: Verify the re-derive triggers compile + commit**

```bash
git add app/src/lib/develop/Basic.svelte
git commit -m "feat(develop): metering-mode control; re-meter on border/inverse change"
```

- [ ] **Step 6: Manual GUI smoke (documented, run by the user)**

Build and run the app (`cd app && npm run tauri dev`). On a scan whose crop includes sprocket holes/rebate:
1. Default `auto` → exposure should NOT over-brighten vs. a tight crop.
2. Switch to `include` → exposure brightens (old behavior) — confirms the mask is what changed.
3. Switch to `exclude` on a borderline frame → border is dropped from metering.
4. Toggle a positive/negative misclassification with the inverse button → render AND exposure/WB correct together in one click.
5. A hand-set exposure is preserved across a positive toggle (not clobbered).

---

## Self-Review

**1. Spec coverage:**
- Detector (negative + positive) → Tasks 1, 2. ✓
- Confidence + plausibility gate → Task 3. ✓
- Shared mask into exp/D_max/WB → Tasks 6 (helper + percentile), 8 (exp), 9 (D_max + WB). ✓
- `meter_border` param (auto/exclude/include) → Task 7. ✓
- Manual control (mirrors recalibrate) → Tasks 10 (i18n) + 11 (UI). ✓
- Re-derive on `positive` flip + manual stickiness → Task 11. ✓
- Constants at module top → Tasks 1–3. ✓
- No-mask path identical to today → enforced by `meter_mask` returning `None` and `mask=None` samplers (Tasks 4, 5, 6). ✓
- Roll mirroring of `meter_border` → it lives in `InvertParams`, so the existing "Apply to whole roll" path (Task 7 makes it a normal param) carries it; no extra task needed (confirm in Task 11 smoke).

**2. Placeholder scan:** Task 1's first test draft included an illustrative `pm_width_of`/`mid` snippet that is explicitly replaced by the final test body in the same step — implementers use the final body. No other placeholders.

**3. Type consistency:**
- `sample_dmax_spread(.., mask: Option<&[bool]>)` — defined Task 4, used Tasks 4/9. ✓
- `per_zone_wb_gains(.., mask)` — defined Task 5, used via `per_zone_seed` Task 9. ✓
- `percentile_luma(img, pct, mask)` — defined Task 6, used Task 8. ✓
- `meter_mask(cropped, base, positive, mode) -> Option<(Image, Vec<bool>)>` — defined Task 6, used Tasks 8/9. ✓
- `detect_grid` / `detect_photo_mask` / `gate_photo_mask` / `MeterBorder` — defined Tasks 1/3/6, used Task 6+. ✓
- `auto_brightness_value(.., mask)` and `auto_seed_wb(.., mask)` and `per_zone_seed(.., mask)` — defined + used Tasks 8/9. ✓

**Open verification items for implementers (read before coding the task):**
- Task 5/9: read the actual `per_zone_wb_gains` and `auto_wb_gains` bodies to confirm where pixels are accumulated and whether they downscale (align the mask to that grid).
- Task 6/7/8: confirm the `commands.rs` / `session.rs` test-module conventions and whether an `InvertParams` test constructor already exists.
- Task 10: confirm the CSV column order from its header line.
