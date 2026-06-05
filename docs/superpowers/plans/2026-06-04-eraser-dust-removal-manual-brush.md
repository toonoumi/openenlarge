# Eraser / Dust Removal — Manual Brush (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Lightroom-style manual Eraser brush to the Develop tab that content-aware-inpaints brushed dust, non-destructively, with full-res output on export. Works on every image (no IR required).

**Architecture:** Dust is a new **post-invert render stage** (mirrors `finish`): `render_view` and `export_image` map normalized brush strokes → output pixels and Telea-inpaint them before finishing. Strokes live in per-image edit state (`dustById` store), stored as normalized polylines so they survive zoom/re-develop/export. The Rust inpaint engine is isolated behind one `film_core::dust` module so the algorithm stays swappable.

**Tech Stack:** Rust (`film-core` lib, `src-tauri` Tauri commands), `inpaint` crate (Telea/Fast-Marching, EUPL-1.2), `ndarray`; SvelteKit + TypeScript (vitest).

**Scope note:** This is **Plan A**. The **global IR smart-removal** feature (design §1.1) is **Plan B** — it reuses `film_core::dust` from here and additionally threads the IR plane through `proxy`/`orient`/`rotate`/`crop`. Out of scope for this plan.

**Refinements vs. the design doc** (approved intent unchanged — non-destructive, full-res on export, live feel):
- Stroke = **polyline** `{ points: [{x,y}], r }` (not a single dab) so ⌘Z undoes a whole drag.
- Brush radius `r` is **normalized to image width** (zoom-independent; maps cleanly to output px).
- Dust applies **per render** as a stage (driven by edit state), not as an incremental mutation of the cached `working` buffer. Same non-destructive result; simpler and correct given `render_view` re-inverts each frame.

**Build/test commands** (cargo is not on PATH — always prefix):
- Rust: `source "$HOME/.cargo/env" && cargo test -p film-core` and `... -p app` (the `src-tauri` crate is named `app`; confirm with `source "$HOME/.cargo/env" && cargo test` at repo root).
- TS: `cd app && npm run test` (vitest), `npm run check` (svelte-check).

---

## File Structure

**Create:**
- `crates/film-core/src/dust.rs` — Telea inpaint engine + mask rasterization (the only file that touches the `inpaint` crate).
- `app/src/lib/develop/dust.ts` — TS stroke types, edit-state reducers, brush↔screen math.
- `app/src/lib/develop/dust.test.ts` — vitest for the above.
- `app/src/lib/develop/EraserPanel.svelte` — brush-size slider, disabled IR toggle (Plan B placeholder), Reset.

**Modify:**
- `crates/film-core/src/lib.rs` — `pub mod dust;` + re-export.
- `crates/film-core/Cargo.toml` — add `inpaint`, `ndarray` deps.
- `app/src-tauri/src/commands.rs` — `DustStroke` DTO, `ViewSpec.dust`, `view_stamps`/`export_stamps`, apply dust in `render_view` + `export_image`.
- `app/src/lib/api.ts` — `DustStroke` type, `ViewSpec.dust`, `exportImage` dust arg.
- `app/src/lib/store.ts` — `dustById` store + `activeDust` derived.
- `app/src/lib/develop/Toolbar.svelte` — enable the eraser tool.
- `app/src/lib/viewport/Viewport.svelte` — eraser mode: circle cursor, scroll→brush, stroke capture, pass `dust` to `renderView`.
- `app/src/lib/tabs/Develop.svelte` — render EraserPanel, own brush + dust state, ⌘Z undo, pass dust to Viewport + export.

---

## Task 1: `film_core::dust` — Stamp + mask rasterization (pure)

**Files:**
- Create: `crates/film-core/src/dust.rs`
- Modify: `crates/film-core/src/lib.rs`

- [ ] **Step 1: Declare the module**

In `crates/film-core/src/lib.rs`, add alongside the other `pub mod` lines:

```rust
pub mod dust;
```

- [ ] **Step 2: Write the failing test**

Create `crates/film-core/src/dust.rs` with only:

```rust
//! Manual dust removal: rasterize brush stamps to a windowed mask, then Telea-inpaint.

/// A brush dab in image PIXEL coordinates. `r` is the radius in pixels.
#[derive(Debug, Clone, Copy)]
pub struct Stamp {
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
}

/// A binary mask confined to a window (origin `x0,y0`, size `w*h`) of the image.
/// `bits[y*w + x]` is true where a pixel should be inpainted. Empty → `w==0 || h==0`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mask {
    pub x0: usize,
    pub y0: usize,
    pub w: usize,
    pub h: usize,
    pub bits: Vec<bool>,
}

/// Rasterize `stamps` (pixel coords) into a windowed mask on a `img_w`×`img_h` image.
/// Each dab is grown by `grow` px (soft dilation). The window is padded by `pad` px
/// beyond the dabs (clamped to the image) so the inpainter has known source pixels
/// around the hole. Returns an empty mask if nothing lands inside the image.
pub fn rasterize(img_w: usize, img_h: usize, stamps: &[Stamp], grow: f32, pad: usize) -> Mask {
    let empty = Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
    if img_w == 0 || img_h == 0 || stamps.is_empty() {
        return empty;
    }
    // Union bounds of all grown dabs (float), then intersect with the image.
    let mut minx = f32::MAX;
    let mut miny = f32::MAX;
    let mut maxx = f32::MIN;
    let mut maxy = f32::MIN;
    for s in stamps {
        let re = s.r + grow;
        minx = minx.min(s.cx - re);
        miny = miny.min(s.cy - re);
        maxx = maxx.max(s.cx + re);
        maxy = maxy.max(s.cy + re);
    }
    let x0 = (minx.floor() as isize - pad as isize).max(0) as usize;
    let y0 = (miny.floor() as isize - pad as isize).max(0) as usize;
    let x1 = ((maxx.ceil() as isize + pad as isize).max(0) as usize + 1).min(img_w);
    let y1 = ((maxy.ceil() as isize + pad as isize).max(0) as usize + 1).min(img_h);
    if x1 <= x0 || y1 <= y0 {
        return empty;
    }
    let (w, h) = (x1 - x0, y1 - y0);
    let mut bits = vec![false; w * h];
    for s in stamps {
        let re2 = (s.r + grow) * (s.r + grow);
        for yy in 0..h {
            for xx in 0..w {
                let px = (x0 + xx) as f32 + 0.5;
                let py = (y0 + yy) as f32 + 0.5;
                let d2 = (px - s.cx) * (px - s.cx) + (py - s.cy) * (py - s.cy);
                if d2 <= re2 {
                    bits[yy * w + xx] = true;
                }
            }
        }
    }
    Mask { x0, y0, w, h, bits }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rasterize_marks_a_disc_and_leaves_a_known_border() {
        let m = rasterize(100, 100, &[Stamp { cx: 50.0, cy: 50.0, r: 3.0 }], 1.0, 4);
        // Center is masked.
        let lx = 50 - m.x0;
        let ly = 50 - m.y0;
        assert!(m.bits[ly * m.w + lx], "disc center must be masked");
        // The window has an unmasked border (source pixels for inpaint).
        assert!(!m.bits[0], "top-left of window must be unmasked");
        // Disc radius ~ r+grow=4 → corners of the window are outside the disc.
        assert!(m.w >= 9 && m.h >= 9, "window covers disc + pad");
    }

    #[test]
    fn rasterize_empty_when_no_stamps_or_offscreen() {
        assert_eq!(rasterize(100, 100, &[], 1.0, 4).w, 0);
        let off = rasterize(100, 100, &[Stamp { cx: -50.0, cy: -50.0, r: 2.0 }], 1.0, 1);
        assert_eq!(off.w, 0, "fully off-image dab → empty mask");
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p film-core dust::`
Expected: PASS (2 tests). The impl is included with the test above because the types are shared.

- [ ] **Step 4: Commit**

```bash
git add crates/film-core/src/dust.rs crates/film-core/src/lib.rs
git commit -m "feat(film-core): dust mask rasterization (Stamp + windowed Mask)"
```

---

## Task 2: Inpaint engine — wrap the `inpaint` crate behind one function

**Files:**
- Modify: `crates/film-core/Cargo.toml`
- Modify: `crates/film-core/src/dust.rs`

This is the **only** task that touches the third-party crate. If the pinned version's `telea_inpaint` signature differs from the one coded here, **only `inpaint_masked` changes** — the test below is the gate.

- [ ] **Step 1: Add dependencies**

In `crates/film-core/Cargo.toml`, under `[dependencies]`:

```toml
inpaint = "0.1"
ndarray = "0.16"
```

- [ ] **Step 2: Write the failing test**

Append to `crates/film-core/src/dust.rs` (inside the file, above `#[cfg(test)]` add the function; add the test inside the existing `tests` module):

Function (add after `rasterize`):

```rust
use crate::Image;
use ndarray::{Array2, Array3};

/// Inpaint the masked pixels of `img` using Telea / Fast Marching, operating only
/// on the mask's window. `radius` is the Telea neighborhood size (px). No-op on an
/// empty mask.
pub fn inpaint_masked(img: &mut Image, mask: &Mask, radius: u32) {
    if mask.w == 0 || mask.h == 0 {
        return;
    }
    let (w, h) = (mask.w, mask.h);
    // Copy the window into (h, w, 3) and the mask into (h, w).
    let mut region = Array3::<f32>::zeros((h, w, 3));
    let mut m = Array2::<f32>::zeros((h, w));
    for yy in 0..h {
        for xx in 0..w {
            let gi = (mask.y0 + yy) * img.width + (mask.x0 + xx);
            let p = img.pixels[gi];
            region[[yy, xx, 0]] = p[0];
            region[[yy, xx, 1]] = p[1];
            region[[yy, xx, 2]] = p[2];
            if mask.bits[yy * w + xx] {
                m[[yy, xx]] = 1.0;
            }
        }
    }
    // Isolated third-party call. If the crate's signature changed, adjust ONLY this line.
    let _ = inpaint::telea_inpaint(&mut region.view_mut(), &m.view(), radius);
    // Write back only the masked pixels.
    for yy in 0..h {
        for xx in 0..w {
            if mask.bits[yy * w + xx] {
                let gi = (mask.y0 + yy) * img.width + (mask.x0 + xx);
                img.pixels[gi] = [region[[yy, xx, 0]], region[[yy, xx, 1]], region[[yy, xx, 2]]];
            }
        }
    }
}
```

Test (add inside `mod tests`):

```rust
    #[test]
    fn inpaint_removes_a_speck_against_a_solid_field() {
        // Solid gray 21x21 with one white "dust" pixel in the middle.
        let n = 21usize;
        let mut img = Image {
            width: n,
            height: n,
            pixels: vec![[0.4, 0.4, 0.4]; n * n],
            ir: None,
        };
        let mid = (n / 2) * n + (n / 2);
        img.pixels[mid] = [1.0, 1.0, 1.0];
        let mask = rasterize(n, n, &[Stamp { cx: 10.0, cy: 10.0, r: 1.0 }], 1.0, 4);
        inpaint_masked(&mut img, &mask, 3);
        // The speck is now close to the surrounding gray, not white.
        let p = img.pixels[mid];
        assert!(p[0] < 0.6, "speck should be filled toward gray, got {:?}", p);
        // A far-away pixel is untouched.
        assert_eq!(img.pixels[0], [0.4, 0.4, 0.4]);
    }
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `source "$HOME/.cargo/env" && cargo test -p film-core dust::tests::inpaint_removes_a_speck`
Expected: PASS. If it fails to COMPILE on `telea_inpaint`, run `source "$HOME/.cargo/env" && cargo doc -p inpaint --no-deps --open` (or read `~/.cargo/registry/src/*/inpaint-*/src/lib.rs`) to get the exact signature, fix only the isolated call line, and re-run. The behavioral assertion is the real gate.

- [ ] **Step 4: Commit**

```bash
git add crates/film-core/Cargo.toml crates/film-core/src/dust.rs Cargo.lock
git commit -m "feat(film-core): inpaint_masked via Telea (inpaint crate, isolated seam)"
```

---

## Task 3: `dust::apply` — public one-call entry (rasterize + inpaint)

**Files:**
- Modify: `crates/film-core/src/dust.rs`

- [ ] **Step 1: Write the failing test**

Add the function (after `inpaint_masked`):

```rust
/// Default soft-dilation (px) added to each dab so the hole fully covers the speck.
pub const GROW: f32 = 1.5;
/// Default Telea neighborhood radius (px).
pub const RADIUS: u32 = 3;

/// Rasterize `stamps` (image pixel coords) and inpaint them in place. No-op when
/// `stamps` is empty or nothing lands inside the image.
pub fn apply(img: &mut Image, stamps: &[Stamp]) {
    let mask = rasterize(img.width, img.height, stamps, GROW, (RADIUS + 2) as usize);
    inpaint_masked(img, &mask, RADIUS);
}
```

Test (inside `mod tests`):

```rust
    #[test]
    fn apply_is_noop_without_stamps_and_heals_with_them() {
        let n = 21usize;
        let mut img = Image { width: n, height: n, pixels: vec![[0.3, 0.5, 0.7]; n * n], ir: None };
        let before = img.clone();
        apply(&mut img, &[]);
        assert_eq!(img, before, "no stamps → unchanged");

        img.pixels[10 * n + 10] = [0.0, 0.0, 0.0];
        apply(&mut img, &[Stamp { cx: 10.0, cy: 10.0, r: 1.5 }]);
        let p = img.pixels[10 * n + 10];
        assert!(p[0] > 0.1 && p[2] > 0.4, "dark speck healed toward field, got {:?}", p);
    }
```

- [ ] **Step 2: Run the test**

Run: `source "$HOME/.cargo/env" && cargo test -p film-core dust::tests::apply_is_noop`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add crates/film-core/src/dust.rs
git commit -m "feat(film-core): dust::apply entry (rasterize + Telea inpaint)"
```

---

## Task 4: Wire dust into `render_view` (preview)

**Files:**
- Modify: `app/src-tauri/src/commands.rs`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `commands.rs`:

```rust
    #[test]
    fn viewspec_dust_defaults_empty_and_parses_points() {
        let d: ViewSpec = serde_json::from_str(
            r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false}"#).unwrap();
        assert!(d.dust.is_empty(), "dust defaults to empty when omitted");
        let p: ViewSpec = serde_json::from_str(
            r#"{"crop":[0,0,10,10],"out_w":10,"out_h":10,"raw":false,
                "dust":[{"points":[[0.5,0.5],[0.6,0.5]],"r":0.02}]}"#).unwrap();
        assert_eq!(p.dust.len(), 1);
        assert_eq!(p.dust[0].points.len(), 2);
    }

    #[test]
    fn view_stamps_maps_normalized_points_to_output_pixels() {
        // base image 200x100; view crop = whole base; output 400x200 (2x).
        let dust = vec![DustStroke { points: vec![[0.5, 0.5]], r: 0.01 }];
        let s = view_stamps(&dust, 200, 100, 0, 0, 200, 100, 400, 200);
        assert_eq!(s.len(), 1);
        assert!((s[0].cx - 200.0).abs() < 0.5, "x: 0.5*200*2 = 200");
        assert!((s[0].cy - 100.0).abs() < 0.5, "y: 0.5*100*2 = 100");
        // r normalized to base width: 0.01*200 = 2 base px → *2 scale = 4 out px.
        assert!((s[0].r - 4.0).abs() < 0.5, "r mapped to output px, got {}", s[0].r);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `source "$HOME/.cargo/env" && cargo test -p app view_stamps`
Expected: FAIL — `DustStroke` / `view_stamps` not found, `ViewSpec` has no `dust`.

- [ ] **Step 3: Add the DTO, the `ViewSpec` field, and the mapping helper**

In `commands.rs`, add near the top (after the imports), and a `Stamp` import:

```rust
use film_core::dust::{self, Stamp};
```

Add the DTO above `ViewSpec`:

```rust
/// A brush stroke from the UI: a polyline of points normalized to the DISPLAYED
/// image ([0,1] each), with radius `r` normalized to the displayed image WIDTH.
#[derive(Debug, Clone, Deserialize)]
pub struct DustStroke {
    pub points: Vec<[f64; 2]>,
    pub r: f64,
}
```

Add the field to `ViewSpec` (after `angle`):

```rust
    #[serde(default)] pub dust: Vec<DustStroke>,
```

Add the mapping helper (free function, e.g. after `crop_px`):

```rust
/// Map normalized strokes → `Stamp`s in OUTPUT pixel space. `base_w/base_h` are the
/// displayed (oriented+cropped) image dims at working res; `(cx,cy,cw,ch)` is the
/// view crop taken from it; `out_w/out_h` is the rendered size of that crop.
fn view_stamps(
    dust: &[DustStroke], base_w: usize, base_h: usize,
    cx: usize, cy: usize, cw: usize, ch: usize, out_w: u32, out_h: u32,
) -> Vec<Stamp> {
    if cw == 0 || ch == 0 {
        return Vec::new();
    }
    let sx = out_w as f64 / cw as f64;
    let sy = out_h as f64 / ch as f64;
    let mut out = Vec::new();
    for stroke in dust {
        let r = (stroke.r * base_w as f64 * sx).max(0.5);
        for pt in &stroke.points {
            let bx = pt[0] * base_w as f64;
            let by = pt[1] * base_h as f64;
            out.push(Stamp {
                cx: ((bx - cx as f64) * sx) as f32,
                cy: ((by - cy as f64) * sy) as f32,
                r: r as f32,
            });
        }
    }
    out
}
```

- [ ] **Step 4: Apply dust in `render_view`**

In `render_view`, replace the non-raw tail (currently):

```rust
    let ip = resolve_params(&params, &dev.thumb, dev.base);
    let inv = invert_image(&scaled, &ip, mode_from(&params.mode));
    let out = if view.finish { finish_image(&inv, &finish_from(&params)) } else { inv };
    to_jpeg_b64(&out, false, PREVIEW_JPEG_QUALITY)
```

with:

```rust
    let ip = resolve_params(&params, &dev.thumb, dev.base);
    let mut inv = invert_image(&scaled, &ip, mode_from(&params.mode));
    let stamps = view_stamps(
        &view.dust, base_img.width, base_img.height,
        cx, cy, cropped.width, cropped.height, view.out_w.max(1), view.out_h.max(1),
    );
    dust::apply(&mut inv, &stamps);
    let out = if view.finish { finish_image(&inv, &finish_from(&params)) } else { inv };
    to_jpeg_b64(&out, false, PREVIEW_JPEG_QUALITY)
```

Note: `cropped` is the `Image` already bound earlier in the function (`let cropped = crop(&base_img, cx, cy, cw, ch);`); using its real `.width/.height` keeps the mapping exact at image edges.

- [ ] **Step 5: Run tests**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS (new + existing command tests green).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(backend): apply dust strokes as a render stage in render_view"
```

---

## Task 5: Wire dust into `export_image` (full-res)

**Files:**
- Modify: `app/src-tauri/src/commands.rs`

- [ ] **Step 1: Write the failing test**

Add to `mod tests`:

```rust
    #[test]
    fn export_stamps_maps_normalized_points_to_full_res_pixels() {
        let dust = vec![DustStroke { points: vec![[0.25, 0.5]], r: 0.01 }];
        let s = export_stamps(&dust, 400, 200);
        assert_eq!(s.len(), 1);
        assert!((s[0].cx - 100.0).abs() < 0.5, "0.25*400");
        assert!((s[0].cy - 100.0).abs() < 0.5, "0.5*200");
        assert!((s[0].r - 4.0).abs() < 0.5, "0.01*400");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `source "$HOME/.cargo/env" && cargo test -p app export_stamps`
Expected: FAIL — `export_stamps` not found.

- [ ] **Step 3: Add the helper**

In `commands.rs` (near `view_stamps`):

```rust
/// Map normalized strokes → `Stamp`s on a full-res `w`×`h` image (no view crop).
fn export_stamps(dust: &[DustStroke], w: usize, h: usize) -> Vec<Stamp> {
    let mut out = Vec::new();
    for stroke in dust {
        let r = (stroke.r * w as f64).max(0.5) as f32;
        for pt in &stroke.points {
            out.push(Stamp { cx: (pt[0] * w as f64) as f32, cy: (pt[1] * h as f64) as f32, r });
        }
    }
    out
}
```

- [ ] **Step 4: Add the `dust` arg and apply it**

Change the `export_image` signature to add `dust` (after `angle`, before `session`):

```rust
pub fn export_image(
    id: String, params: InvertParams, out_path: String,
    image_crop: Option<[f64; 4]>,
    rot90: u8, flip_h: bool, flip_v: bool, angle: f32,
    dust: Vec<DustStroke>,
    session: State<Session>,
) -> Result<(), String> {
```

Replace the inversion tail (currently):

```rust
    let ip = resolve_params(&params, &thumb, base);
    let inv = invert_image(&full, &ip, mode_from(&params.mode));
    let fin = finish_image(&inv, &finish_from(&params));
    film_core::export::write_tiff16(&fin, Path::new(&out_path)).map_err(|e| format!("{e}"))
```

with:

```rust
    let ip = resolve_params(&params, &thumb, base);
    let mut inv = invert_image(&full, &ip, mode_from(&params.mode));
    let stamps = export_stamps(&dust, inv.width, inv.height);
    dust::apply(&mut inv, &stamps);
    let fin = finish_image(&inv, &finish_from(&params));
    film_core::export::write_tiff16(&fin, Path::new(&out_path)).map_err(|e| format!("{e}"))
```

- [ ] **Step 5: Run tests**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(backend): apply dust strokes at full-res in export_image"
```

---

## Task 6: TS stroke types + edit-state store

**Files:**
- Create: `app/src/lib/develop/dust.ts`
- Create: `app/src/lib/develop/dust.test.ts`
- Modify: `app/src/lib/api.ts`
- Modify: `app/src/lib/store.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/develop/dust.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyDust, addStroke, undoStroke, resetDust,
  screenRadius, normRadius, type DustEdits, type DustStroke,
} from "./dust";

const stroke = (r: number): DustStroke => ({ points: [{ x: 0.5, y: 0.5 }], r });

describe("dust edit-state", () => {
  it("adds, undoes, and resets strokes immutably", () => {
    const d0 = emptyDust();
    const d1 = addStroke(d0, stroke(0.02));
    const d2 = addStroke(d1, stroke(0.03));
    expect(d0.strokes.length).toBe(0); // original untouched
    expect(d2.strokes.length).toBe(2);
    expect(undoStroke(d2).strokes.length).toBe(1);
    expect(resetDust().strokes.length).toBe(0);
  });
  it("undo on empty is safe", () => {
    expect(undoStroke(emptyDust()).strokes.length).toBe(0);
  });
});

describe("brush radius mapping", () => {
  it("round-trips normalized ↔ screen radius", () => {
    const imgW = 4000, eff = 0.25; // 0.25 display px per image px
    const screen = screenRadius(0.02, imgW, eff); // 0.02*4000*0.25 = 20
    expect(screen).toBeCloseTo(20, 5);
    expect(normRadius(screen, imgW, eff)).toBeCloseTo(0.02, 5);
  });
  it("normRadius is safe at zero", () => {
    expect(normRadius(10, 0, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd app && npm run test -- dust.test`
Expected: FAIL — module `./dust` not found.

- [ ] **Step 3: Implement `dust.ts`**

Create `app/src/lib/develop/dust.ts`:

```ts
/** A point normalized to the displayed image ([0,1] in both axes). */
export interface DustPoint { x: number; y: number }
/** A brush stroke: a polyline + radius normalized to the displayed image WIDTH. */
export interface DustStroke { points: DustPoint[]; r: number }
/** Per-image dust edit state. */
export interface DustEdits { strokes: DustStroke[] }

export const emptyDust = (): DustEdits => ({ strokes: [] });

export function addStroke(d: DustEdits, s: DustStroke): DustEdits {
  return { strokes: [...d.strokes, s] };
}
export function undoStroke(d: DustEdits): DustEdits {
  return { strokes: d.strokes.slice(0, -1) };
}
export function resetDust(): DustEdits {
  return { strokes: [] };
}

/** Normalized-to-width radius → on-screen pixels at the current zoom `eff`. */
export function screenRadius(normR: number, imgW: number, eff: number): number {
  return normR * imgW * eff;
}
/** On-screen pixel radius → normalized-to-width radius. */
export function normRadius(screenR: number, imgW: number, eff: number): number {
  return imgW > 0 && eff > 0 ? screenR / (imgW * eff) : 0;
}
```

- [ ] **Step 4: Add the wire type + export arg in `api.ts`**

In `app/src/lib/api.ts`, add the type (near `ViewSpec`):

```ts
export interface DustStroke { points: { x: number; y: number }[]; r: number }
```

Add `dust` to `ViewSpec`:

```ts
  dust?: DustStroke[];
```

Change `exportImage` to forward dust (add param + invoke field):

```ts
  exportImage: (
    id: string, params: InvertParams, outPath: string,
    imageCrop: [number, number, number, number] | null = null,
    geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {},
    dust: DustStroke[] = [],
  ) =>
    invoke<void>("export_image", {
      id, params, outPath, imageCrop,
      rot90: geom.rot90 ?? 0, flipH: geom.flip_h ?? false,
      flipV: geom.flip_v ?? false, angle: geom.angle ?? 0, dust,
    }),
```

- [ ] **Step 5: Add the store**

In `app/src/lib/store.ts`, add after the `cropById`/`activeCrop` block:

```ts
import { emptyDust, type DustEdits } from "./develop/dust";

/** Per-image dust edits (eraser strokes). */
export const dustById = writable<Record<string, DustEdits>>({});
/** The active image's dust edits. */
export const activeDust = derived([dustById, activeId], ([m, id]) =>
  id ? m[id] ?? emptyDust() : emptyDust());
```

(Place the `import` with the other imports at the top of the file.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd app && npm run test -- dust.test && npm run check`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/develop/dust.ts app/src/lib/develop/dust.test.ts app/src/lib/api.ts app/src/lib/store.ts
git commit -m "feat(app): dust edit-state types, reducers, store, wire types"
```

---

## Task 7: EraserPanel component

**Files:**
- Create: `app/src/lib/develop/EraserPanel.svelte`

- [ ] **Step 1: Implement the panel**

Create `app/src/lib/develop/EraserPanel.svelte` (mirrors `CropPanel.svelte` styling):

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";

  /** Brush radius normalized to image width (0.005..0.2). */
  export let brush: number;
  /** Whether the active image carries an IR plane (Plan B enables the toggle). */
  export let hasIr = false;

  const dispatch = createEventDispatcher<{ reset: void }>();
</script>

<div class="section">
  <div class="head"><span>Eraser</span></div>

  <button
    class="ir" disabled
    title={hasIr ? "Coming soon" : "Requires an infrared scan channel"}
  >
    Remove dust (IR) <span class="soon">soon</span>
  </button>

  <div class="sub">Brush size</div>
  <div class="slrow">
    <input type="range" min="0.005" max="0.2" step="0.001" bind:value={brush} />
    <span class="val">{(brush * 100).toFixed(1)}%</span>
  </div>

  <button class="row" on:click={() => dispatch("reset")}>Reset</button>
  <div class="hint">Scroll to resize · click or drag to erase dust · ⌘Z to undo</div>
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { color: var(--text); font-weight: 600; padding: 4px 0; }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 12px 0 4px; }
  .ir { width: 100%; display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: default; opacity: 0.5; }
  .soon { font-size: 10px; border: 1px solid var(--glass-brd); border-radius: 4px;
    padding: 0 5px; color: var(--text-dim); }
  .slrow { display: flex; align-items: center; gap: 8px; }
  .slrow input[type="range"] { flex: 1; accent-color: var(--accent); }
  .val { font-size: 12px; color: var(--text); width: 44px; text-align: right;
    font-variant-numeric: tabular-nums; }
  .row { width: 100%; display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; margin: 6px 0; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: no new errors (component compiles).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/develop/EraserPanel.svelte
git commit -m "feat(app): EraserPanel (brush size, Reset, IR placeholder)"
```

---

## Task 8: Viewport eraser mode — cursor, scroll-to-resize, stroke capture

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte`

This is UI behavior on a Svelte component; it has no unit test in this repo (the repo tests pure logic in `view.ts`/`dust.ts`, which Task 6 covers). Verify manually per Step 6.

- [ ] **Step 1: Add eraser props, dispatcher, and the dust wire-through**

In the `<script>` of `Viewport.svelte`, after the existing `export let angle = 0;`:

```ts
  import { createEventDispatcher } from "svelte";
  import { screenRadius, type DustStroke } from "../develop/dust";

  export let eraser = false;
  /** Brush radius normalized to image width. */
  export let brush = 0.03;
  /** Committed strokes for this image (rendered by the backend). */
  export let dust: DustStroke[] = [];
  /** Bumped by the parent on any dust change to force a re-render. */
  export let dustRev = 0;

  const dispatch = createEventDispatcher<{ stroke: DustStroke; brush: number }>();
```

- [ ] **Step 2: Send `dust` to the backend and re-render on changes**

In `render()`, add `dust` to the `renderView` payload:

```ts
      const data = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw, finish: !(useGL && renderer),
        image_crop: imageCrop, rot90, flip_h: flipH, flip_v: flipV, angle, dust,
      });
```

Add `dustRev` to `srcKey` so a committed/undone/reset stroke triggers a re-fetch:

```ts
  $: srcKey = `${id}|${raw}|${eff}|${vpW}|${vpH}|${params.mode}|${params.stock}|${params.exposure}|${params.temp}|${params.tint}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}|${dustRev}`;
```

- [ ] **Step 3: Reassign scroll to brush size in eraser mode**

Replace `onWheel`:

```ts
  function onWheel(e: WheelEvent) {
    if (!interactive) return;
    // In eraser mode the wheel resizes the brush; a trackpad PINCH (ctrlKey) still zooms.
    if (eraser && !e.ctrlKey) {
      e.preventDefault();
      const next = Math.min(0.2, Math.max(0.005, brush * Math.exp(-e.deltaY * 0.0015)));
      dispatch("brush", next);
      return;
    }
    stopAnim();
    e.preventDefault();
    const [ix, iy] = imgPoint(e);
    const ns = Math.min(8, Math.max(fit, eff * Math.exp(-e.deltaY * 0.0015)));
    cx = ix + (cx - ix) * (eff / ns);
    cy = iy + (cy - iy) * (eff / ns);
    scale = ns;
  }
```

- [ ] **Step 4: Capture strokes and track the cursor**

Add stroke/cursor state after the `let lastX...` line:

```ts
  // Eraser: live cursor position (element coords) + the in-progress stroke (normalized).
  let curX = -100, curY = -100, hovering = false;
  let painting = false;
  let pending: { x: number; y: number }[] = [];
  $: cursorR = screenRadius(brush, imgW, eff);

  function normPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const [ix, iy] = imgPoint(e);
    return { x: ix / imgW, y: iy / imgH };
  }
  function onEraserMove(e: PointerEvent) {
    const rect = el.getBoundingClientRect();
    curX = e.clientX - rect.left;
    curY = e.clientY - rect.top;
    if (painting) pending = [...pending, normPoint(e)];
  }
```

Guard the existing pan handlers so they do nothing while erasing, and add the eraser branches. Replace `onDown`, `onMove`, `onUp`:

```ts
  function onDown(e: PointerEvent) {
    if (!interactive) return;
    if (eraser) {
      painting = true;
      pending = [normPoint(e)];
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    stopAnim();
    downX = lastX = e.clientX; downY = lastY = e.clientY; moved = false;
    panning = zoomed;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!interactive) return;
    if (eraser) { onEraserMove(e); return; }
    if (!(e.buttons & 1)) return;
    if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true;
    if (panning && moved) {
      cx -= (e.clientX - lastX) / eff;
      cy -= (e.clientY - lastY) / eff;
      clampCenter();
    }
    lastX = e.clientX; lastY = e.clientY;
  }
  function onUp(e: PointerEvent) {
    if (eraser) {
      if (painting && pending.length > 0) dispatch("stroke", { points: pending, r: brush });
      painting = false; pending = [];
      return;
    }
    if (interactive && !moved) {
      const [ix, iy] = imgPoint(e);
      startAnim();
      if (zoomed) { scale = fit; cx = imgW / 2; cy = imgH / 2; }
      else { scale = 1.0; cx = ix; cy = iy; }
    }
    panning = false; moved = false;
  }
```

Add hover enter/leave handlers (to show/hide the cursor):

```ts
  function onEnter() { if (eraser) hovering = true; }
  function onLeave() { hovering = false; painting = false; pending = []; }
```

- [ ] **Step 5: Render the circle cursor overlay**

On the root `.vp` div, add `class:erasing={eraser}` and the enter/leave handlers:

```svelte
<div
  class="vp" class:interactive class:zoomed class:erasing={eraser}
  bind:this={el}
  on:wheel={onWheel}
  on:pointerdown={onDown} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onCancel}
  on:pointerenter={onEnter} on:pointerleave={onLeave}
>
```

Inside `.vp`, after the `<SpinOverlay .../>` line, add the cursor:

```svelte
  {#if eraser && hovering}
    <div class="brush" style="left:{curX}px; top:{curY}px; width:{cursorR * 2}px; height:{cursorR * 2}px;"></div>
  {/if}
```

Add styles (inside `<style>`):

```css
  .vp.erasing { cursor: none; }
  .brush { position: absolute; border-radius: 50%; pointer-events: none; z-index: 3;
    transform: translate(-50%, -50%); border: 1.5px solid rgba(255,255,255,0.9);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.4); }
```

- [ ] **Step 6: Typecheck + manual verification**

Run: `cd app && npm run check`
Expected: no new type errors.

Manual (after Task 9 wires it in): in Develop, pick Eraser; confirm the circle follows the cursor, scroll resizes it, pinch still zooms, click/drag over a speck heals it on release.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(app): Viewport eraser mode (brush cursor, scroll-resize, stroke capture)"
```

---

## Task 9: Wire the Eraser tool into Develop

**Files:**
- Modify: `app/src/lib/develop/Toolbar.svelte`
- Modify: `app/src/lib/tabs/Develop.svelte`

- [ ] **Step 1: Enable the tool**

In `app/src/lib/develop/Toolbar.svelte`, change the eraser entry:

```ts
    { id: "eraser", icon: "eraser", label: "Eraser", enabled: true },
```

- [ ] **Step 2: Add dust state + handlers in Develop**

In `app/src/lib/tabs/Develop.svelte` `<script>`, extend the store import and add imports:

```ts
  import { activeId, params, images, tool, cropById, activeCrop, dustById, activeDust } from "../store";
  import EraserPanel from "../develop/EraserPanel.svelte";
  import { addStroke, undoStroke, resetDust, emptyDust, type DustStroke } from "../develop/dust";
```

Add brush + dust reactive state (near the other `let` declarations):

```ts
  let brush = 0.03;            // normalized-to-width brush radius
  let dustRev = 0;            // bumped on any dust change to force Viewport re-render
  $: dust = $activeDust;

  function commitStroke(s: DustStroke) {
    const id = $activeId; if (!id) return;
    dustById.update((m) => ({ ...m, [id]: addStroke(m[id] ?? emptyDust(), s) }));
    dustRev++;
  }
  function undoDust() {
    const id = $activeId; if (!id) return;
    dustById.update((m) => ({ ...m, [id]: undoStroke(m[id] ?? emptyDust()) }));
    dustRev++;
  }
  function resetDustEdits() {
    const id = $activeId; if (!id) return;
    dustById.update((m) => ({ ...m, [id]: resetDust() }));
    dustRev++;
  }
```

- [ ] **Step 3: Handle ⌘Z in eraser mode**

In the existing `onKey` function, add at the top of the body (after `const meta = ...`):

```ts
    if ($tool === "eraser" && meta && (e.key === "z" || e.key === "Z")) {
      e.preventDefault(); undoDust(); return;
    }
```

- [ ] **Step 4: Render the eraser Viewport + panel**

In the center `{#if active?.developed}` block, extend the tool branches so Eraser uses the normal Viewport in eraser mode. Replace the `{#if $tool === "crop"} ... {:else} <Viewport .../> {/if}` with:

```svelte
      {#if $tool === "crop"}
        <CropView id={$activeId} params={$params} imgW={oW} imgH={oH}
                  bind:rect {lockRatio} {rot90} {flipH} {flipV} {angle}
                  on:custom={() => (aspect = "custom")} on:straighten={(e) => onStraighten(e.detail)} />
      {:else}
        <Viewport id={$activeId} params={$params} imgW={effW} imgH={effH} imageCrop={imageCrop}
                  rot90={cRot} flipH={committed?.flipH ?? false} flipV={committed?.flipV ?? false} angle={committed?.angle ?? 0}
                  eraser={$tool === "eraser"} {brush} dust={dust.strokes} {dustRev}
                  on:stroke={(e) => commitStroke(e.detail)} on:brush={(e) => (brush = e.detail)} />
      {/if}
```

In the right panel, add the eraser branch after the crop branch:

```svelte
      {#if $tool === "edit"}
        <Basic />
      {:else if $tool === "crop"}
        <CropPanel bind:aspect bind:orientation bind:angle
                   on:preset={(e) => onPreset(e.detail)} on:swap={onSwap} on:reset={onReset}
                   on:rotate={(e) => onRotate(e.detail)} on:flip={(e) => onFlip(e.detail)} />
      {:else if $tool === "eraser"}
        <EraserPanel bind:brush on:reset={resetDustEdits} />
      {/if}
```

- [ ] **Step 5: Pass dust to export**

In `exportTiff`, forward the strokes:

```ts
      await api.exportImage($activeId, $params, out, imageCrop, {
        rot90: committed?.rot90 ?? 0, flip_h: committed?.flipH ?? false,
        flip_v: committed?.flipV ?? false, angle: committed?.angle ?? 0,
      }, dust.strokes);
```

- [ ] **Step 6: Typecheck + full test suites**

Run:
```bash
cd app && npm run check && npm run test
source "$HOME/.cargo/env" && cargo test
```
Expected: type-clean; vitest green; all Rust tests green.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/develop/Toolbar.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(app): wire Eraser tool into Develop (panel, strokes, undo, export)"
```

---

## Task 10: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Launch the app**

Run: `cd app && npm run tauri dev` (or the project's documented launch; see `.claude` skills). Import a developed image.

- [ ] **Step 2: Verify the brush UX**
- Select **Eraser** in the toolbar → right panel shows Eraser; the IR toggle is **disabled** with the "Requires an infrared scan channel" tooltip.
- The cursor becomes a **circle** following the pointer.
- **Scroll** resizes the circle (panel % updates); a trackpad **pinch** still zooms.
- **Tap** a dust speck → it disappears on release. **Drag** across a hair → the path heals.
- **⌘Z** removes the last stroke; **Reset** clears all.
- Zoom to 100% → the circle shrinks on screen but erases the same real area; previously erased spots stay clean.

- [ ] **Step 3: Verify export**
- Export a 16-bit TIFF; open it → erased spots are healed at full resolution.

- [ ] **Step 4: Regression**
- Switch to **Edit** and **Crop** tools → both behave exactly as before (cursor, zoom/pan, crop). No dust circle leaks into other tools.

- [ ] **Step 5: Commit any fixes, then finalize**

```bash
git add -A && git commit -m "fix(app): eraser verification follow-ups"   # only if changes were needed
```

---

## Self-Review (completed)

- **Spec coverage:** Manual brush (design §1.2, §4–5) — Tasks 1–9. Non-destructive edit state (§2) — Task 6. Telea via `inpaint` crate (§3) — Task 2. Image-space radius + scroll-resize + pinch-still-zooms (§5) — Tasks 6, 8. Pointer-up commit, stroke stack + ⌘Z + Reset (§7 of dialogue) — Tasks 8, 9. Testing (§6) — Tasks 1–6. **Global IR pass (§1.1) is deferred to Plan B** (noted up front; the IR toggle ships disabled).
- **Placeholders:** none — every code/test step contains full code and exact commands.
- **Type consistency:** `Stamp{cx,cy,r}`, `Mask{x0,y0,w,h,bits}`, `DustStroke{points,r}` (Rust DTO + TS), `dust::apply`/`rasterize`/`inpaint_masked`, `view_stamps`/`export_stamps`, store `dustById`/`activeDust`, props `eraser`/`brush`/`dust`/`dustRev`, events `stroke`/`brush` — all match across tasks.
- **Crate-API risk:** isolated to one line in `inpaint_masked` (Task 2), gated by a behavioral test.
