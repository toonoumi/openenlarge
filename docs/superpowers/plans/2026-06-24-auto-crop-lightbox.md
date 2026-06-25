# Auto-trim Lightbox Border on Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On import, automatically detect a bright lightbox/scanner border around a film scan and set the image's initial crop to the framed content, with a toast notification.

**Architecture:** A pure detection function in `film-core` finds the non-white content bounding box on the already-decoded thumbnail and returns a normalized rect, guarded so it only fires on an unmistakable 4-sided flat-white border. `import_image` runs it and returns the rect on `ImageEntry`. The frontend import loop wraps the rect into a `CropRect`, commits it to `cropById` (which auto-persists), and shows a toast.

**Tech Stack:** Rust (`film-core` crate, Tauri commands), TypeScript/Svelte frontend, Python i18n generator.

## Global Constraints

- Detection is **per-image**, computed independently on each import. No roll-wide crop.
- **When in doubt, do not crop.** Any guard failure → return `None`, no crop, no toast.
- No manual "Auto" re-trigger button. Users adjust crops by hand (Frame = one image, Roll = global) via existing semantics — do not touch them.
- i18n strings are generated: edit `i18n-strings.csv` then run `scripts/gen-i18n.py`. **Never edit the generated `dict.ts` directly** (regeneration wipes hand-added keys).
- `film-core` stays serde-free in this feature: the detection function returns a plain `Option<[f32; 4]>` ( `[x, y, w, h]` normalized 0..1); serde wrapping happens in the Tauri layer.
- The toast copy is exactly: **"Lightbox detected, automatically trimming"**.

---

### Task 1: Lightbox detection function (`film-core`)

**Files:**
- Create: `crates/film-core/src/autocrop.rs`
- Modify: `crates/film-core/src/lib.rs` (register module)
- Test: inline `#[cfg(test)] mod tests` in `crates/film-core/src/autocrop.rs`

**Interfaces:**
- Consumes: `film_core::image::Image` (`width: usize`, `height: usize`, `pixels: Vec<[f32; 3]>`, linear-light RGB).
- Produces: `pub fn detect_lightbox_crop(img: &Image) -> Option<[f32; 4]>` — returns `[x, y, w, h]` normalized to 0..1 on success, `None` when no confident lightbox border is found.

- [ ] **Step 1: Register the module**

In `crates/film-core/src/lib.rs`, add the module declaration in alphabetical order (between `pub mod image;` and `pub mod tone;` — note `autocrop` is actually first alphabetically, so put it at the very top of the `pub mod` list, before `pub mod bench;`):

```rust
pub mod autocrop;
```

- [ ] **Step 2: Write the failing tests**

Create `crates/film-core/src/autocrop.rs` with tests first:

```rust
//! Detect a bright lightbox / scanner border around a film scan and return the
//! framed content rectangle. Runs on the import-time thumbnail. Conservative by
//! design: only fires on an unmistakable 4-sided flat-white border, otherwise
//! returns `None` (leave the image full-frame).

use crate::image::Image;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::Image;

    /// Build a `w`×`h` image filled with `bg`, then paint an inner rectangle
    /// [x0,x1)×[y0,y1) with `fg`.
    fn boxed(
        w: usize,
        h: usize,
        bg: [f32; 3],
        fg: [f32; 3],
        x0: usize,
        y0: usize,
        x1: usize,
        y1: usize,
    ) -> Image {
        let mut img = Image::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
                img.pixels[y * w + x] = if inside { fg } else { bg };
            }
        }
        img
    }

    const WHITE: [f32; 3] = [1.0, 1.0, 1.0];
    const GRAY: [f32; 3] = [0.3, 0.25, 0.2];

    #[test]
    fn detects_white_border_around_content() {
        // 100×100, white border 10px on every side, gray center [10,90)×[10,90).
        let img = boxed(100, 100, WHITE, GRAY, 10, 10, 90, 90);
        let r = detect_lightbox_crop(&img).expect("should detect border");
        let [x, y, w, h] = r;
        assert!((x - 0.10).abs() < 0.02, "x={x}");
        assert!((y - 0.10).abs() < 0.02, "y={y}");
        assert!((w - 0.80).abs() < 0.02, "w={w}");
        assert!((h - 0.80).abs() < 0.02, "h={h}");
    }

    #[test]
    fn no_border_returns_none() {
        // Solid gray, no white margin anywhere.
        let img = boxed(100, 100, GRAY, GRAY, 0, 0, 100, 100);
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn one_bright_edge_is_not_a_frame() {
        // White only along the top 10 rows; other three sides are gray.
        // Not a closing frame → None.
        let img = boxed(100, 100, GRAY, WHITE, 0, 0, 100, 10);
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn gradient_border_is_rejected_by_variance() {
        // Build a frame whose border is a vertical brightness gradient (like a
        // sky), bright enough to pass the white threshold at the very edge but
        // high-variance across the margin → rejected.
        let (w, h) = (100usize, 100usize);
        let mut img = Image::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let inside = x >= 10 && x < 90 && y >= 10 && y < 90;
                let v = if inside { 0.3 } else { 0.90 + 0.10 * (x as f32 / w as f32) };
                img.pixels[y * w + x] = [v, v, v];
            }
        }
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn runaway_crop_is_rejected() {
        // White border 40px each side on a 100px image → would trim 40% per
        // side (> 25% cap) → None.
        let img = boxed(100, 100, WHITE, GRAY, 40, 40, 60, 60);
        assert_eq!(detect_lightbox_crop(&img), None);
    }

    #[test]
    fn ignores_tiny_or_degenerate_images() {
        let img = Image::new(1, 1);
        assert_eq!(detect_lightbox_crop(&img), None);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p film-core autocrop`
Expected: FAIL — `cannot find function detect_lightbox_crop in this scope`.

- [ ] **Step 4: Implement `detect_lightbox_crop`**

Add above the `#[cfg(test)]` block in `crates/film-core/src/autocrop.rs`:

```rust
// A pixel counts as "white" when all three linear channels are near max.
const WHITE_THRESH: f32 = 0.90;
// A border row/column is a "white margin" when this fraction of its pixels are white.
const WHITE_FRAC: f32 = 0.95;
// Per-side trim must stay under this fraction of the dimension (rejects runaway crops).
const MAX_TRIM: f32 = 0.25;
// The trimmed border must be flat: high mean brightness, low variance.
const MARGIN_MEAN_MIN: f32 = 0.92;
const MARGIN_STD_MAX: f32 = 0.05;

fn is_white(p: [f32; 3]) -> bool {
    p[0] >= WHITE_THRESH && p[1] >= WHITE_THRESH && p[2] >= WHITE_THRESH
}

/// Detect a bright lightbox/scanner border. Returns the content rect as
/// `[x, y, w, h]` normalized 0..1, or `None` if there is no confident 4-sided
/// flat-white border. See module docs for the conservative guard rules.
pub fn detect_lightbox_crop(img: &Image) -> Option<[f32; 4]> {
    let (w, h) = (img.width, img.height);
    if w < 8 || h < 8 {
        return None;
    }
    let px = |x: usize, y: usize| img.pixels[y * w + x];

    let row_is_margin = |y: usize| -> bool {
        let white = (0..w).filter(|&x| is_white(px(x, y))).count();
        white as f32 / w as f32 >= WHITE_FRAC
    };
    let col_is_margin = |x: usize| -> bool {
        let white = (0..h).filter(|&y| is_white(px(x, y))).count();
        white as f32 / h as f32 >= WHITE_FRAC
    };

    // Scan inward from each edge to the first non-margin line.
    let top = (0..h).find(|&y| !row_is_margin(y)).unwrap_or(h);
    let bottom = (0..h).rev().find(|&y| !row_is_margin(y)).unwrap_or(0);
    let left = (0..w).find(|&x| !col_is_margin(x)).unwrap_or(w);
    let right = (0..w).rev().find(|&x| !col_is_margin(x)).unwrap_or(0);

    // Closing frame: every side must have at least one white-margin line, and the
    // content box must be non-degenerate.
    if top == 0 || left == 0 || bottom + 1 >= h || right + 1 >= w {
        return None;
    }
    if right <= left || bottom <= top {
        return None;
    }

    // Modest trim: each side keeps the crop reasonable.
    let trim_top = top as f32 / h as f32;
    let trim_bottom = (h - 1 - bottom) as f32 / h as f32;
    let trim_left = left as f32 / w as f32;
    let trim_right = (w - 1 - right) as f32 / w as f32;
    if trim_top >= MAX_TRIM
        || trim_bottom >= MAX_TRIM
        || trim_left >= MAX_TRIM
        || trim_right >= MAX_TRIM
    {
        return None;
    }

    // Flatness: the trimmed border must be uniformly bright (rejects skies/walls).
    // Accumulate luma over the four margin bands (outside the content box).
    let mut sum = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut n = 0u64;
    for y in 0..h {
        for x in 0..w {
            let in_content = x >= left && x <= right && y >= top && y <= bottom;
            if in_content {
                continue;
            }
            let p = px(x, y);
            let luma = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) as f64;
            sum += luma;
            sum_sq += luma * luma;
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }
    let mean = sum / n as f64;
    let var = (sum_sq / n as f64 - mean * mean).max(0.0);
    let std = var.sqrt();
    if mean < MARGIN_MEAN_MIN as f64 || std > MARGIN_STD_MAX as f64 {
        return None;
    }

    let x = left as f32 / w as f32;
    let y = top as f32 / h as f32;
    let rw = (right - left + 1) as f32 / w as f32;
    let rh = (bottom - top + 1) as f32 / h as f32;
    Some([x, y, rw, rh])
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p film-core autocrop`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/autocrop.rs crates/film-core/src/lib.rs
git commit -m "feat(autocrop): lightbox border detection in film-core"
```

---

### Task 2: Wire detection through import (`app/src-tauri`)

**Files:**
- Modify: `app/src-tauri/src/session.rs` (add `AutoCropRect` + `ImageEntry.auto_crop`)
- Modify: `app/src-tauri/src/commands.rs` (`import_compute` + `import_image`)

**Interfaces:**
- Consumes: `film_core::autocrop::detect_lightbox_crop(&Image) -> Option<[f32; 4]>` from Task 1.
- Produces: `ImageEntry.auto_crop: Option<AutoCropRect>` where `AutoCropRect { x, y, w, h: f32 }` serializes to the frontend as `{ x, y, w, h }`.

- [ ] **Step 1: Add `AutoCropRect` and the `ImageEntry` field**

In `app/src-tauri/src/session.rs`, add the struct just above `pub struct ImageEntry {` (match the existing derive style on neighboring serializable structs — check the top of the file for the exact derives; `ImageEntry` is `Serialize`):

`Serialize`/`Deserialize` are already imported at the top of `session.rs` (`use serde::{Deserialize, Serialize};`):

```rust
/// Import-time auto-detected lightbox crop, normalized 0..1 on the source image.
/// Present only on freshly imported entries that had a confident lightbox border.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AutoCropRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}
```

Then add the field at the end of `ImageEntry` (after `thumb_stale`):

```rust
    /// Import-time auto lightbox crop, normalized 0..1. None when no confident
    /// border was found. Only set on fresh imports; the frontend applies it once.
    #[serde(default)]
    pub auto_crop: Option<AutoCropRect>,
```

- [ ] **Step 2: Default the field in `insert_with_id`**

In `app/src-tauri/src/session.rs`, in `insert_with_id`, add to the `ImageEntry { ... }` literal (after `thumb_stale: false,`):

```rust
            auto_crop: None,
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p app` (the `app/src-tauri` crate is named `app`).
Expected: builds clean.

- [ ] **Step 4: Compute the crop in `import_compute`**

In `app/src-tauri/src/commands.rs`, change `import_compute`'s return type and body. Update the signature:

```rust
fn import_compute(
    path: String,
) -> Result<
    (
        String,
        String,
        crate::metadata::Metadata,
        String,
        Option<[f32; 4]>,
    ),
    String,
> {
```

Immediately **after** the `let preview: Option<film_core::Image> = match ext.as_str() { ... };` block and **before** `let thumbnail = match preview { ... }` (which moves `preview`), insert:

```rust
    // Detect a bright lightbox/scanner border on the decoded preview so the
    // frontend can set the image's initial crop to the framed content.
    let auto_crop = preview
        .as_ref()
        .and_then(film_core::autocrop::detect_lightbox_crop);
```

Then update the final `Ok(...)` of `import_compute` to include it:

```rust
    Ok((thumbnail, file_name, metadata, metadata_json, auto_crop))
}
```

- [ ] **Step 5: Thread it through `import_image`**

In `app/src-tauri/src/commands.rs`, in `import_image`, update the destructuring of the `spawn_blocking` result:

```rust
    let (thumbnail, file_name, metadata, metadata_json, auto_crop) =
        tauri::async_runtime::spawn_blocking(move || import_compute(path_for_compute))
            .await
            .map_err(|e| e.to_string())??;
```

Then change the final return so the entry carries the detected crop:

```rust
    let mut entry = session.insert_with_id(id, cached);
    entry.auto_crop = auto_crop.map(|[x, y, w, h]| crate::session::AutoCropRect { x, y, w, h });
    Ok(entry)
```

(Replace the existing `Ok(session.insert_with_id(id, cached))`.)

- [ ] **Step 6: Verify it compiles**

Run: `cargo build` from `app/src-tauri/`.
Expected: builds clean, no warnings about unused `auto_crop`.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs
git commit -m "feat(autocrop): return detected lightbox crop from import_image"
```

---

### Task 3: Apply the crop + toast on the frontend

**Files:**
- Modify: `app/src/lib/api.ts` (`ImageEntry` type)
- Modify: `app/src/lib/workflow.ts` (`importPaths` applies the crop + toast)
- Modify: `i18n-strings.csv` (new toast string)
- Generated: `app/src/lib/i18n/dict.ts` (via `scripts/gen-i18n.py` — do not hand-edit)

**Interfaces:**
- Consumes: `ImageEntry.auto_crop?: { x: number; y: number; w: number; h: number } | null` from Task 2; `CropRect` from `app/src/lib/crop/types.ts`; `cropById` store (auto-persisted via the catalog wire); `showToast`, `translate`.
- Produces: a committed `cropById[id]` entry of shape `CropRect` and a toast on detection.

- [ ] **Step 1: Extend the `ImageEntry` TS type**

In `app/src/lib/api.ts`, add to the `ImageEntry` interface (after `thumb_stale?: boolean;`):

```ts
  /** Import-time auto-detected lightbox crop, normalized 0..1; applied once by the import loop. */
  auto_crop?: { x: number; y: number; w: number; h: number } | null;
```

- [ ] **Step 2: Add the toast string to the i18n CSV**

In `i18n-strings.csv`, append a new row (columns are `key,en,zh,ja,ko,file,note`):

```
toast.lightboxTrimmed,"Lightbox detected, automatically trimming","检测到灯箱，自动裁切","ライトボックスを検出、自動でトリミングしました","라이트박스 감지됨, 자동으로 잘라냄",src/lib/workflow.ts,toast
```

- [ ] **Step 3: Regenerate the i18n dictionary**

Run: `python3 scripts/gen-i18n.py`
Expected: regenerates `app/src/lib/i18n/dict.ts` including the `toast.lightboxTrimmed` key. Confirm with:

Run: `grep -n "lightboxTrimmed" app/src/lib/i18n/dict.ts`
Expected: at least one match.

- [ ] **Step 4: Apply the crop in `importPaths`**

In `app/src/lib/workflow.ts`, add imports at the top (merge into existing import lines where possible):

```ts
import { cropById } from "./store";
import type { CropRect } from "./crop/types";
```

(`images`, `activeId` are already imported from `./store`; `showToast` and `translate` are already imported. Add `cropById` to the existing `./store` import rather than duplicating it.)

Then, inside `importPaths`, after `activeId.update((id) => id ?? entry.id);`, add:

```ts
      if (entry.auto_crop) {
        const a = entry.auto_crop;
        const crop: CropRect = {
          rect: { x: a.x, y: a.y, w: a.w, h: a.h },
          aspect: "original",
          orientation: "landscape",
          rot90: 0,
          flipH: false,
          flipV: false,
          angle: 0,
        };
        cropById.update((m) => ({ ...m, [entry.id]: crop }));
        showToast(translate("toast.lightboxTrimmed"));
      }
```

(Committing to `cropById` auto-persists via the catalog wire `wireRecord(cropById, crop.save)` — no explicit `saveCrop` call needed, matching `Develop.svelte`.)

- [ ] **Step 5: Typecheck + build the frontend**

Run: `cd app && npm run check` (`svelte-kit sync && svelte-check`).
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/workflow.ts i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(autocrop): apply lightbox crop + toast on import"
```

---

### Task 4: Manual GUI smoke test

**Files:** none (verification only).

- [ ] **Step 1: Build and launch the app**

Run the app via the project's dev launcher (e.g. `cd app && npm run tauri dev`).

- [ ] **Step 2: Verify the three cases**

- Import a **DSLR/lightbox scan** (RAW with a blown-white surround): the imported frame's crop is trimmed to the film frame and the toast "Lightbox detected, automatically trimming" appears.
- Import a **flatbed-on-white scan**: same behavior.
- Import an **already-positive image with a bright sky touching an edge**: no crop change, no toast.

- [ ] **Step 3: Verify adjustability**

Open a trimmed image in **Frame** and confirm the crop is fully editable (drag handles work, the auto-crop was just an initial rect). Adjust a crop in **Roll** and confirm it still mirrors globally (unchanged behavior).

---

## Self-Review Notes

- **Spec coverage:** detection module + guards (Task 1); per-image computation and `ImageEntry` plumbing (Task 2); `CropRect` wrap + `cropById` persist + toast + i18n (Task 3); the three manual cases incl. case-3 no-misfire (Task 4). Roll/Frame semantics deliberately untouched.
- **Guard mapping:** 4-sided closing frame (`top/left/bottom/right` checks), low-variance flat white (`MARGIN_MEAN_MIN`/`MARGIN_STD_MAX`), modest trim (`MAX_TRIM` 25%/side). "When in doubt, don't crop" = every guard returns `None`.
- **Type consistency:** Rust `detect_lightbox_crop -> Option<[f32;4]>` → `AutoCropRect{x,y,w,h}` → TS `auto_crop?:{x,y,w,h}` → `CropRect.rect`. Names line up across tasks.
- **Confirmed at write time:** `app/src-tauri` crate is `app` (→ `cargo build -p app`); frontend typecheck is `npm run check`; `ImageEntry` derives `Serialize` only but `Deserialize` is also in scope, so `AutoCropRect` deriving both is fine.
