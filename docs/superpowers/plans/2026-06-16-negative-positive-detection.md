# Negative / Positive Detection on Develop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During Develop, classify each image as negative or positive; render positives as a non-inverted passthrough (still tone/color/crop/dust editable) while negatives keep today's Cineon inversion, with a one-tap override in either direction.

**Architecture:** A single boolean `positive` flows end-to-end: detected in the develop pipeline (`film-core`), returned to the frontend, seeded into the per-image `InvertParams`, persisted via the existing catalog write-through, and read by both render engines. The CPU engine branches inside `invert_image`; the GPU preview branches inside the INVERT fragment shader. Because both render paths key off one flag, every call site (preview, thumbnail, export, HDR, upscale) gets the positive path for free. The Basic panel swaps its film-base controls for an Inverse button on positives, and shows a quiet "treat as positive" link on negatives.

**Tech Stack:** Rust (`film-core` crate + Tauri commands), TypeScript (Svelte stores + Tauri bridge), GLSL (WebGL2 preview shader), Svelte 4, Vitest, `cargo test`.

**Key design decisions (locked):**
- The flag is named **`positive: bool`** (TS `positive: boolean`), realizing the spec's `mode: 'negative' | 'positive'` as `negative = false`, `positive = true`. This avoids colliding with the existing **vestigial** `InvertParams.mode: "b"|"c"|"d"` field, which must stay untouched.
- The **passthrough render** mirrors the existing `u_raw` shader path (`pow(rgb, 1/2.2)`) but additionally applies exposure and white-balance gain: `out[c] = pow(max(rgb[c] * print_exposure * wb[c], 0), 1/2.2)`. The working buffer is linear (the raw-scan view applies `1/2.2` to display it), so this is the consistent display encode. `finish_image` then applies contrast / tone / saturation exactly as for negatives.
- Detection **defaults to negative** when its confidence is below a threshold (preserves today's behavior); the symmetric override makes any misclassification a one-tap fix. The override link is shown unconditionally (no confidence gating in the UI), so `modeConfidence` is intentionally NOT added to `InvertParams`.
- Detection result is returned from `develop_image` and **seeded into params only on first develop** (when the image has no stored edits), so re-develop or existing manual edits are never clobbered.

---

## File Structure

**Rust — `film-core` crate (pure image logic, unit-tested):**
- `crates/film-core/src/engine.rs` (modify) — add `positive: bool` to `InversionParams`; add `develop_positive_px`; branch in `invert_image`.
- `crates/film-core/src/classify.rs` (create) — `classify_positive(working) -> (bool, f32)` tonal-inversion detector.
- `crates/film-core/src/lib.rs` (modify) — `pub mod classify;`.

**Rust — Tauri app (`app/src-tauri/src`):**
- `app/src-tauri/src/session.rs` (modify) — `InvertParams.positive` field; `Developed.positive` + `positive_confidence`; `ImageEntry.positive`.
- `app/src-tauri/src/commands.rs` (modify) — `default_invert_params` sets `positive: false`; `build_params` propagates it; `develop_heavy` runs detection + stores + returns it; `resolve_to_uniforms` sets it on the uniforms.
- `app/src-tauri/src/catalog.rs` (modify, if `CatalogImage` is defined there) — carry `positive` on the reload snapshot.

**TypeScript / Svelte (`app/src`):**
- `app/src/lib/api.ts` (modify) — `InvertParams.positive`; `defaultParams()`; `ImageEntry.positive`; `CatalogImage.positive`.
- `app/src/lib/viewport/gl/invert.ts` (modify) — `ResolvedInversion.positive`; `InversionUniforms.positive`; `toInversionUniforms`.
- `app/src/lib/viewport/gl/uniforms.ts` (modify) — bind the `u_positive` uniform.
- `app/src/lib/viewport/gl/shaders.ts` (modify) — `u_positive` uniform + positive branch in INVERT_FRAG.
- `app/src/lib/workflow.ts` (modify) — seed `params.positive` from the develop result on first develop.
- `app/src/lib/develop/Basic.svelte` (modify) — conditional UI + toggle handler.
- `i18n-strings.csv` (modify) + `scripts/gen-i18n.py` (run) — new strings.

**Tests:**
- `crates/film-core/src/engine.rs` (`#[cfg(test)] mod tests`) — passthrough behavior.
- `crates/film-core/src/classify.rs` (`#[cfg(test)] mod tests`) — detector behavior.
- `app/src/lib/viewport/gl/invert.test.ts` — `positive` round-trips through `toInversionUniforms`.
- `app/src/lib/perImage.test.ts` / existing TS tests — `defaultParams().positive === false`.

---

## Task 1: Engine — positive passthrough in `invert_image`

**Files:**
- Modify: `crates/film-core/src/engine.rs` (`InversionParams` struct ~12-41, `Default` ~43-61, `invert_image` ~118-129)
- Test: `crates/film-core/src/engine.rs` (`mod tests` ~131)

- [ ] **Step 1: Write the failing tests**

Add these tests inside `mod tests` in `crates/film-core/src/engine.rs`:

```rust
    #[test]
    fn positive_passthrough_neutral_is_display_encode() {
        // positive + neutral params (exposure 1, wb 1) must match the raw-scan
        // display encode pow(rgb, 1/2.2) — no inversion, no tint.
        let p = InversionParams { positive: true, ..Default::default() };
        for probe in [[0.04f32, 0.04, 0.04], [0.2, 0.3, 0.5], [0.9, 0.9, 0.9]] {
            let out = invert_d(probe, &p);
            for c in 0..3 {
                let want = probe[c].powf(1.0 / 2.2);
                assert!((out[c] - want).abs() < 1e-5, "ch {c}: {} vs {}", out[c], want);
            }
        }
    }

    #[test]
    fn positive_exposure_brightens() {
        let base = InversionParams { positive: true, ..Default::default() };
        let up = InversionParams { positive: true, print_exposure: 2.0, ..Default::default() };
        let a = invert_d([0.25, 0.25, 0.25], &base);
        let b = invert_d([0.25, 0.25, 0.25], &up);
        assert!(b[0] > a[0], "2x exposure should brighten: {} vs {}", b[0], a[0]);
    }

    #[test]
    fn positive_wb_gains_one_channel() {
        let neutral = InversionParams { positive: true, ..Default::default() };
        let warm = InversionParams { positive: true, wb: [1.5, 1.0, 1.0], ..Default::default() };
        let a = invert_d([0.3, 0.3, 0.3], &neutral);
        let b = invert_d([0.3, 0.3, 0.3], &warm);
        assert!(b[0] > a[0], "R gain should brighten R: {} vs {}", b[0], a[0]);
        assert!((b[1] - a[1]).abs() < 1e-6, "G unchanged");
    }

    #[test]
    fn positive_false_matches_today() {
        // Regression: the default (negative) path is byte-for-byte unchanged.
        let p = InversionParams { base: [0.7, 0.6, 0.5], ..Default::default() };
        assert!(!p.positive, "default must be negative");
        let probe = [0.3, 0.25, 0.2];
        let neg = invert_d(probe, &p);
        // Compare against a hand-rolled call with positive explicitly false.
        let p2 = InversionParams { positive: false, ..p.clone() };
        assert_eq!(neg, invert_d(probe, &p2));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core positive_`
Expected: FAIL — `InversionParams` has no field `positive`.

- [ ] **Step 3: Add the `positive` field + passthrough branch**

In `crates/film-core/src/engine.rs`, add to the `InversionParams` struct (after the `hdr` field, before the closing brace ~line 40):

```rust
    /// Positive passthrough: skip the Cineon inversion and render the decoded
    /// scan directly (display-encoded), applying only exposure (`print_exposure`)
    /// and white balance (`wb`). For already-positive sources (slides/prints).
    pub positive: bool,
```

Add to the `Default for InversionParams` impl (after `hdr: false,` ~line 58):

```rust
            positive: false,
```

Add this pure function just above `invert_d` (~line 81):

```rust
/// Positive passthrough: the working buffer is linear, so display-encode it with
/// `1/2.2` (matching the raw-scan view), after applying exposure + WB gain.
/// `0 * wb == 0` keeps black neutral, mirroring the inversion's WB convention.
pub fn develop_positive_px(rgb: [f32; 3], p: &InversionParams) -> [f32; 3] {
    const DISPLAY_GAMMA: f32 = 1.0 / 2.2;
    std::array::from_fn(|c| {
        let lit = (rgb[c] * p.print_exposure * p.wb[c]).max(0.0);
        lit.powf(DISPLAY_GAMMA)
    })
}
```

At the top of `invert_d` (first line of the body, before `const THRESHOLD`), add the branch:

```rust
    if p.positive {
        return develop_positive_px(rgb, p);
    }
```

(Branching inside `invert_d` means `invert_image` and every caller inherit it with no further change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core`
Expected: PASS — new `positive_*` tests pass and all existing inversion tests still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): positive passthrough render path in invert_image"
```

---

## Task 2: Engine — tonal-inversion detector

**Files:**
- Create: `crates/film-core/src/classify.rs`
- Modify: `crates/film-core/src/lib.rs` (add `pub mod classify;`)
- Test: `crates/film-core/src/classify.rs` (`mod tests`)

**Detector design (tonal signal, base-color independent):** A scanned negative is tonally inverted and low-contrast with a strong overall cast — its mean luma sits high-ish, its dynamic range is compressed, and one channel dominates the mean (the orange/blue mask or the B&W base). A positive reads like a normal photo: wider tonal spread and a more balanced channel mean. We score two cheap, normalized statistics over the working buffer and combine them; below a confidence margin we return `false` (negative) as the safe default.

This heuristic is the deliberately-iterable part — the tests pin the *invariants* (a synthetic positive scores positive, a synthetic negative scores negative, confidence is in range), not exact magic numbers, so the thresholds can be tuned without rewriting the tests.

- [ ] **Step 1: Write the failing tests**

Create `crates/film-core/src/classify.rs` with the test module first:

```rust
//! Negative-vs-positive classification from the decoded working buffer.
//! Tonal-inversion signal (not base color), so it generalizes across C-41
//! (orange base), B&W (neutral base), and Phoenix (bluish base).

use crate::Image;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Image;

    fn solid(w: usize, h: usize, px: [f32; 3]) -> Image {
        Image { width: w, height: h, pixels: vec![px; w * h], ir: None }
    }

    /// A "positive": natural full-range gradient from near-black to near-white,
    /// balanced channels.
    fn synthetic_positive() -> Image {
        let mut pixels = Vec::new();
        for i in 0..256 {
            let v = i as f32 / 255.0;
            pixels.push([v, v, v]);
        }
        Image { width: 256, height: 1, pixels, ir: None }
    }

    /// A "negative": compressed, high, strongly orange-cast (C-41-like).
    fn synthetic_negative() -> Image {
        let mut pixels = Vec::new();
        for i in 0..256 {
            let v = 0.55 + (i as f32 / 255.0) * 0.2; // compressed, lifted
            pixels.push([v, v * 0.7, v * 0.4]);       // orange cast
        }
        Image { width: 256, height: 1, pixels, ir: None }
    }

    #[test]
    fn positive_image_classifies_positive() {
        let (is_pos, conf) = classify_positive(&synthetic_positive());
        assert!(is_pos, "full-range balanced image should read positive (conf {conf})");
        assert!((0.0..=1.0).contains(&conf));
    }

    #[test]
    fn negative_image_classifies_negative() {
        let (is_pos, conf) = classify_positive(&synthetic_negative());
        assert!(!is_pos, "compressed orange-cast image should read negative (conf {conf})");
        assert!((0.0..=1.0).contains(&conf));
    }

    #[test]
    fn flat_gray_defaults_negative() {
        // Ambiguous / no signal → safe default is negative (today's behavior).
        let (is_pos, _conf) = classify_positive(&solid(16, 16, [0.5, 0.5, 0.5]));
        assert!(!is_pos, "ambiguous frame must default to negative");
    }

    #[test]
    fn empty_image_defaults_negative() {
        let (is_pos, conf) = classify_positive(&Image { width: 0, height: 0, pixels: vec![], ir: None });
        assert!(!is_pos);
        assert_eq!(conf, 0.0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p film-core classify`
Expected: FAIL — `classify_positive` is not defined.

- [ ] **Step 3: Implement `classify_positive`**

Add above the `#[cfg(test)]` module in `crates/film-core/src/classify.rs`:

```rust
/// Classify the working buffer as positive (`true`) or negative (`false`),
/// with a 0..1 confidence. Base-color independent: scores tonal spread and
/// channel balance, two signals that separate a normal photo (positive) from a
/// tonally-inverted, cast-dominated negative. Defaults to negative below a
/// confidence margin, preserving the app's original always-invert behavior.
pub fn classify_positive(working: &Image) -> (bool, f32) {
    let n = working.pixels.len();
    if n == 0 {
        return (false, 0.0);
    }

    // Per-channel luma stats: mean and spread (std-dev proxy via mean abs dev).
    let mut sum = [0f32; 3];
    for &px in &working.pixels {
        for c in 0..3 {
            sum[c] += px[c];
        }
    }
    let mean = [sum[0] / n as f32, sum[1] / n as f32, sum[2] / n as f32];
    let luma_mean = (mean[0] + mean[1] + mean[2]) / 3.0;

    let mut spread = 0f32;
    for &px in &working.pixels {
        let l = (px[0] + px[1] + px[2]) / 3.0;
        spread += (l - luma_mean).abs();
    }
    spread /= n as f32; // mean absolute deviation of luma, 0..~0.5

    // Channel imbalance: how far the channel means are from neutral, normalized.
    // A C-41/Phoenix negative carries a strong cast; a positive is more balanced.
    let chan_max = mean[0].max(mean[1]).max(mean[2]);
    let chan_min = mean[0].min(mean[1]).min(mean[2]);
    let imbalance = (chan_max - chan_min) / chan_max.max(1e-4); // 0..1

    // Positive evidence: wide tonal spread AND low cast. Negative evidence is the
    // inverse. Map each to 0..1 with simple, tunable anchors.
    //   spread:    >= 0.20 reads as full-range positive; <= 0.06 as flat negative.
    //   imbalance: <= 0.10 reads neutral (positive); >= 0.35 reads cast (negative).
    let spread_pos = ((spread - 0.06) / (0.20 - 0.06)).clamp(0.0, 1.0);
    let cast_neg = ((imbalance - 0.10) / (0.35 - 0.10)).clamp(0.0, 1.0);
    let positive_score = (spread_pos + (1.0 - cast_neg)) / 2.0; // 0..1

    // Confidence = distance from the 0.5 fence, scaled to 0..1.
    let confidence = ((positive_score - 0.5).abs() * 2.0).clamp(0.0, 1.0);

    // Default-to-negative margin: only call it positive when clearly past the fence.
    const POSITIVE_MARGIN: f32 = 0.60;
    (positive_score >= POSITIVE_MARGIN, confidence)
}
```

- [ ] **Step 4: Register the module**

In `crates/film-core/src/lib.rs`, add alongside the other `pub mod` lines:

```rust
pub mod classify;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p film-core classify`
Expected: PASS — all four classify tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/classify.rs crates/film-core/src/lib.rs
git commit -m "feat(engine): tonal-inversion negative/positive classifier"
```

---

## Task 3: Backend wiring — detect on develop, plumb `positive` through commands

**Files:**
- Modify: `app/src-tauri/src/session.rs` (`InvertParams` struct ~50, `Developed` struct, `ImageEntry` struct)
- Modify: `app/src-tauri/src/commands.rs` (`default_invert_params` ~96, `build_params` ~190, `develop_heavy` ~482, `resolve_to_uniforms`)
- Modify: `app/src-tauri/src/catalog.rs` (only if `CatalogImage`/snapshot is built there)

- [ ] **Step 1: Add `positive` to the Rust `InvertParams`**

In `app/src-tauri/src/session.rs`, add to `pub struct InvertParams` (after the `hdr` field ~line 81):

```rust
    /// Positive passthrough (slide/print): skip inversion, render the scan with
    /// exposure + WB only. Seeded by the develop-time classifier; user-overridable.
    #[serde(default)]
    pub positive: bool,
```

- [ ] **Step 2: Add `positive` to `Developed` and `ImageEntry`**

In `app/src-tauri/src/session.rs`, find `pub struct Developed` and add:

```rust
    /// Develop-time classification: true = positive scan (no inversion).
    pub positive: bool,
    /// Classifier confidence 0..1 (diagnostic; not currently surfaced in UI).
    pub positive_confidence: f32,
```

Find `pub struct ImageEntry` and add (it derives `Serialize`):

```rust
    /// Develop-time negative/positive classification (true = positive).
    #[serde(default)]
    pub positive: bool,
```

- [ ] **Step 3: Set the field everywhere `InvertParams`/`ImageEntry` is constructed**

In `app/src-tauri/src/commands.rs`, `default_invert_params()` (~line 164, before the closing `}`):

```rust
        positive: false,
```

`build_params` (~line 195, inside the returned `InversionParams { ... }`, add before `..Default::default()`):

```rust
        positive: p.positive,
```

- [ ] **Step 4: Run detection in `develop_heavy` and return it**

In `app/src-tauri/src/commands.rs`, `develop_heavy` (~line 496, right after `let (base, base_confidence) = auto_base(&working);`):

```rust
    let (positive, positive_confidence) = film_core::classify::classify_positive(&working);
```

In the same function, where `img.developed = Some(Developed { ... })` is built (~line 526), add the two fields:

```rust
            positive,
            positive_confidence,
```

And where the `ImageEntry { ... }` is built (~line 534), add:

```rust
            positive,
```

- [ ] **Step 5: Set `positive` on the GPU uniforms**

Find `resolve_to_uniforms` in `app/src-tauri/src/commands.rs` (referenced from `resolved_inversion` ~1555 and `resolve_params`). Add `positive: p.positive,` to the `ResolvedInversion { ... }` it constructs. (The `ResolvedInversion` Rust struct — search `struct ResolvedInversion` — must also gain `pub positive: bool` with `#[serde(default)]`.)

- [ ] **Step 6: Carry `positive` on any other `ImageEntry`/`CatalogImage` construction**

Run: `grep -rn "ImageEntry {" app/src-tauri/src/`
For every construction site found (e.g. `import_image`, catalog reload in `catalog.rs`), add `positive: false,` (reload images re-seed from persisted params, so a literal default is correct). If a `CatalogImage` struct exists and is serialized to the frontend snapshot, add `#[serde(default)] pub positive: bool` to it and set it from the stored row (or `false`).

- [ ] **Step 7: Build to verify it compiles**

Run: `cd app/src-tauri && cargo build`
Expected: SUCCESS — no missing-field or unknown-field errors.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs app/src-tauri/src/catalog.rs
git commit -m "feat(develop): classify negative/positive on develop and plumb the flag through commands"
```

---

## Task 4: GPU preview — positive branch in the INVERT shader

**Files:**
- Modify: `app/src/lib/viewport/gl/invert.ts` (`ResolvedInversion` ~2-16, `InversionUniforms` ~19-33, `toInversionUniforms` ~35-51)
- Modify: `app/src/lib/viewport/gl/uniforms.ts` (uniform binding)
- Modify: `app/src/lib/viewport/gl/shaders.ts` (INVERT_FRAG ~191)
- Test: `app/src/lib/viewport/gl/invert.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/viewport/gl/invert.test.ts` (follow the existing test style in that file — import `toInversionUniforms` and a sample `ResolvedInversion`):

```ts
import { describe, it, expect } from "vitest";
import { toInversionUniforms, type ResolvedInversion } from "./invert";

describe("positive flag", () => {
  const base: ResolvedInversion = {
    base: [0.7, 0.6, 0.5], wb: [1, 1, 1], m_pre: Array(9).fill(0), m_post: Array(9).fill(0),
    exposure: 1, black: 0, gamma: 0.4545, mode: 3, d_max: 1.5,
    print_exposure: 1, paper_black: 0, paper_grade: 0.95, soft_clip: 0.9, positive: true,
  };
  it("round-trips positive through toInversionUniforms", () => {
    expect(toInversionUniforms(base).positive).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/lib/viewport/gl/invert.test.ts`
Expected: FAIL — `positive` is not a property of `ResolvedInversion` / `InversionUniforms`.

- [ ] **Step 3: Add `positive` to the TS interfaces + mapper**

In `app/src/lib/viewport/gl/invert.ts`:
- Add to `ResolvedInversion` (after `soft_clip: number;`): `positive: boolean;`
- Add to `InversionUniforms` (after `soft_clip: number;`): `positive: boolean;`
- Add to the object returned by `toInversionUniforms` (after `soft_clip: r.soft_clip,`): `positive: r.positive,`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/lib/viewport/gl/invert.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `u_positive` uniform + shader branch**

In `app/src/lib/viewport/gl/shaders.ts`, INVERT_FRAG, after the `uniform bool u_raw;` line (~203):

```glsl
uniform bool u_positive;      // true → positive passthrough (no inversion), WB+exposure only
```

In `void main()` of INVERT_FRAG, after the `if (u_raw) { ... }` line (~285), before `o = vec4(invert(rgb), 1.0);`:

```glsl
  if (u_positive) {
    // Positive passthrough: display-encode the linear scan with WB + exposure
    // gain. Mirrors engine.rs develop_positive_px (pow(rgb*pe*wb, 1/2.2)).
    o = vec4(pow(max(rgb * u_print_exposure * u_wb, 0.0), vec3(1.0/2.2)), 1.0); return;
  }
```

- [ ] **Step 6: Bind the uniform**

In `app/src/lib/viewport/gl/uniforms.ts`, find where the INVERT-pass uniforms are set (look for `u_raw` or `u_soft_clip` binding via `gl.uniform1i`/`gl.uniform1f`). Add alongside, matching the existing pattern for `u_raw` (a bool is bound with `gl.uniform1i(loc, value ? 1 : 0)`):

```ts
gl.uniform1i(loc("u_positive"), u.positive ? 1 : 0);
```

(Use whatever `loc(...)`/location-lookup helper the surrounding code already uses; mirror the `u_raw` line exactly.)

- [ ] **Step 7: Verify build + tests**

Run: `cd app && npx vitest run src/lib/viewport/gl/ && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: tests PASS; no new type errors.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/viewport/gl/invert.ts app/src/lib/viewport/gl/uniforms.ts app/src/lib/viewport/gl/shaders.ts app/src/lib/viewport/gl/invert.test.ts
git commit -m "feat(gpu): positive passthrough branch in the INVERT shader"
```

---

## Task 5: TypeScript state — `positive` on params + entries

**Files:**
- Modify: `app/src/lib/api.ts` (`InvertParams` ~42-84, `defaultParams` ~300-328, `ImageEntry` ~19-22, `CatalogImage` ~129-132)
- Test: `app/src/lib/perImage.test.ts` (or add a small assertion in an existing api test)

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/perImage.test.ts` (it already imports test utilities; add `defaultParams` to the imports from `./api`):

```ts
import { defaultParams } from "./api";

it("defaults positive to false (negative)", () => {
  expect(defaultParams().positive).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/lib/perImage.test.ts`
Expected: FAIL — `positive` missing from `defaultParams()` / type error.

- [ ] **Step 3: Add `positive` to the interfaces + default**

In `app/src/lib/api.ts`:
- `InvertParams` (after `pc_samples: PointColorSample[];`, before the closing brace ~84):

```ts
  /** Positive passthrough: render the scan without inversion (slide/print). */
  positive: boolean;
```

- `defaultParams()` return object (after `pc_samples: [],` ~327):

```ts
  positive: false,
```

- `ImageEntry` (after `offline: boolean;` ~21): `positive: boolean;`
- `CatalogImage` (after `has_ir: boolean;` ~131): `positive: boolean;`

- [ ] **Step 4: Patch the catalog snapshot mapper for the new entry field**

In `app/src/lib/catalog.ts`, `applySnapshot` (~56), the `entries` map builds `ImageEntry` from `CatalogImage`. Add `positive: ci.positive ?? false,` so reload carries it (params backfill at line 51 already merges `positive` via `{ ...defaultParams(), ...e.params }`).

- [ ] **Step 5: Run the test + type check**

Run: `cd app && npx vitest run src/lib/perImage.test.ts && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: PASS; resolve any "missing property `positive`" errors at `ImageEntry` construction sites flagged by svelte-check by adding `positive: false` (e.g. in `applySnapshot`, any test fixtures).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/catalog.ts app/src/lib/perImage.test.ts
git commit -m "feat(state): positive flag on InvertParams + image entries"
```

---

## Task 6: Seed `positive` into params on first develop

**Files:**
- Modify: `app/src/lib/workflow.ts` (`developAll` ~78-102)
- Test: none (integration behavior; covered manually + by the type system). If a `workflow.test.ts` exists, add the assertion below.

- [ ] **Step 1: Add the seeding helper + call**

In `app/src/lib/workflow.ts`, add `editsById` and `defaultParams` to the imports from `./store` and `./api` respectively (check existing import lines — `editsById` is exported from `./store`, `defaultParams` from `./api`).

In `developAll`, replace the body of the `for` loop's success branch (~86-87):

```ts
      const updated = await api.developImage(id);
      images.update((list) => list.map((i) => (i.id === id ? updated : i)));
      // First-develop seed: adopt the classifier's verdict only when the image has
      // no stored edits yet, so re-develop / existing manual overrides are untouched.
      editsById.update((m) =>
        m[id] ? m : { ...m, [id]: { ...defaultParams(), positive: updated.positive } });
```

- [ ] **Step 2: Type check**

Run: `cd app && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/workflow.ts
git commit -m "feat(develop): seed positive verdict into params on first develop"
```

---

## Task 7: Basic panel — Inverse button (positive) + treat-as-positive link (negative)

**Files:**
- Modify: `app/src/lib/develop/Basic.svelte` (script ~1-142, markup ~160-174, styles ~210+)

Uses i18n keys defined in Task 8: `basic.positiveLabel`, `basic.inverseBtn`, `basic.treatPositive`.

- [ ] **Step 1: Add the toggle handler (script section)**

In `app/src/lib/develop/Basic.svelte`, after `function resetBasic() { ... }` (~141), add:

```ts
  // Flip this image between negative (Cineon inversion) and positive (passthrough).
  // Re-renders live; analysis (base/D_max) already ran at develop time so the flip
  // is instant in both directions. Undoable.
  function togglePositive() {
    params.update((p) => ({ ...p, positive: !p.positive }));
    commitActive();
  }
```

- [ ] **Step 2: Make the film-base controls conditional on negative mode**

In the markup, wrap the existing "Crop re-analysis" button + "Film Base" block (lines ~162-174, from the `<!-- Crop re-analysis -->` comment through the `{#if lowConfBase}...{/if}`) in a negative/positive conditional. Replace that whole region with:

```svelte
      {#if $params.positive}
        <!-- Positive image: no inversion; offer to invert anyway. -->
        <p class="posnote">{$t('basic.positiveLabel')}</p>
        <button class="recal" on:click={togglePositive}>{$t('basic.inverseBtn')}</button>
      {:else}
        <!-- Crop re-analysis (re-derive D_max + WB from the current crop) -->
        <button class="recal reanalyze" on:click={reanalyze}>{$t('base.reanalyze')}</button>

        <!-- Film Base: tap the swatch to pick the rebate; the pick auto-applies to this image -->
        <div class="sub">{$t('base.title')}</div>
        <button class="baseswatch" class:on={$baseSampling} on:click={toggleRecalibrate}
                title={$t('base.recalibrate')} aria-label={$t('base.recalibrate')}>
          <span class="cube big" style="background:{baseCss(effBase)}"></span>
          <span class="pick"><Icon name="pipette" size={18} /></span>
        </button>
        {#if lowConfBase}
          <p class="lowconf">{$t('base.lowConfidence')}</p>
        {/if}
        <!-- Misdetection escape hatch: treat this negative as a positive instead. -->
        <button class="treatpos" on:click={togglePositive}>{$t('basic.treatPositive')}</button>
      {/if}
```

(Everything below — White Balance, Tone, Presence sliders — stays as-is and remains live in both modes.)

- [ ] **Step 3: Add styles**

In the `<style>` block of `app/src/lib/develop/Basic.svelte`, add:

```css
  .posnote { font-size: 12px; color: var(--text-dim); margin: 14px 0 8px; line-height: 1.4; }
  .treatpos { background: transparent; border: 0; color: var(--text-dim);
    font-size: 11px; text-decoration: underline; cursor: pointer; padding: 6px 0 0; }
  .treatpos:hover { color: var(--text); }
```

- [ ] **Step 4: Type check + lint the component**

Run: `cd app && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: no errors. (The i18n keys resolve at runtime; `$t` of an undefined key falls back to the key string, so this passes even before Task 8 — but do Task 8 to get real copy.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/develop/Basic.svelte
git commit -m "feat(develop): Basic panel swaps to Inverse button for positives; treat-as-positive link for negatives"
```

---

## Task 8: i18n strings

**Files:**
- Modify: `i18n-strings.csv`
- Run: `scripts/gen-i18n.py` (regenerates `app/src/lib/i18n/dict.ts` — never hand-edit dict.ts)

- [ ] **Step 1: Add the rows to the CSV**

Append to `i18n-strings.csv` (columns: `key,en,zh,file,note`). Match the existing quoting style; provide the Chinese column too (the generator expects it):

```csv
basic.positiveLabel,"This is a positive image — it won't be inverted. Tap below to invert it anyway.","这是一张正片图像——不会进行反相。如需反相，请点击下方。","src/lib/develop/Basic.svelte","paragraph"
basic.inverseBtn,"Inverse","反相","src/lib/develop/Basic.svelte","button"
basic.treatPositive,"Looks like a negative — treat as positive instead?","看起来像负片——改为按正片处理？","src/lib/develop/Basic.svelte","link"
```

- [ ] **Step 2: Regenerate the dictionary**

Run: `python3 scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` updated; the three new keys appear under both `en` and `zh`.

- [ ] **Step 3: Verify the keys generated**

Run: `grep -n "positiveLabel\|inverseBtn\|treatPositive" app/src/lib/i18n/dict.ts`
Expected: matches in the generated dictionary.

- [ ] **Step 4: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(i18n): strings for positive-image label, Inverse button, treat-as-positive link"
```

---

## Final verification

- [ ] **Backend tests + build:** `cargo test -p film-core && (cd app/src-tauri && cargo build)` → all green.
- [ ] **Frontend tests + type check:** `cd app && npx vitest run && npx svelte-check --threshold error` → all green.
- [ ] **Manual smoke (the real proof):** build the app, import a known **positive** (slide/positive scan) and a known **negative** (C-41), plus a **B&W** and a **Phoenix** frame if available. Hit Develop. Confirm:
  - The positive opens un-inverted and editable; its Basic panel shows the label + **Inverse** button.
  - Tapping **Inverse** flips it to the Cineon render and restores the film-base controls; tapping again flips back (live, no spinner).
  - The negatives open inverted as before; their Basic panel shows the existing controls plus the quiet **"treat as positive"** link, which flips them to passthrough.
  - Reload the app — each image's negative/positive state persists.
- [ ] If detection misclassifies the B&W or Phoenix samples, note it: the override makes the app correct regardless, and the `classify_positive` anchors (`spread`/`imbalance` thresholds in `classify.rs`) are the single place to tune. Adjust and re-run the smoke test; the `classify` unit tests guard the invariants.
