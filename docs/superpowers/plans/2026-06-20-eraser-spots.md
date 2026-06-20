# Eraser improvements: fast fine-tune + per-spot icons & delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-fill fine-tuning fast after global dust removal, and let users see every heal spot as an eraser-icon marker and delete individual spots.

**Architecture:** Backend splits the MI-GAN heal into Stage A (auto-dust mask, cached per image) and Stage B (brush strokes only), so a fine-tune stroke no longer re-inpaints every global spot. The backend also emits the active global spot centroids; the frontend renders eraser-icon markers for both brush strokes and global spots, supports tap-to-select / double-tap / delete-hotkey removal, and persists a per-image "keep these spots" exclusion list.

**Tech Stack:** Rust (Tauri 2 commands, `film-core` image crate, MI-GAN/U-Net via `autodust` engine), TypeScript + Svelte frontend, WebGL2 viewport, vitest (TS) + cargo (Rust) tests.

## Global Constraints

- Work is committed directly on `main` (no feature branches).
- i18n strings are generated: edit `/i18n-strings.csv` (columns `key,en,zh,file,note`) then run `python3 scripts/gen-i18n.py`. NEVER edit `dict.ts` directly.
- Normalized coordinates: `DustPoint {x,y}` are both in `[0,1]` of the displayed/baked image. Marker positions and exclusion seeds use this same space.
- Stage-A cache is proxy/fit tier only (`hires == false`); deep-zoom recomputes.
- Rust commands run on `cargo test` from `app/src-tauri`; `film-core` tests run with `cargo test -p film-core`. TS tests run with `npx vitest run` from `app/`; type-check with `npm run check`.

---

### Task 1: Backend — auto-dust exclusions + blob centroids

Add a "keep this spot" exclusion list to the bake spec, teach the auto-dust mask builder to drop excluded blobs, and replace the blob *count* with blob *centroids* (the data the UI markers need).

**Files:**
- Modify: `app/src-tauri/src/gpu_upload.rs:12-30` (BakeSpec struct) and its 3 test literals (`:209`, `:245`, `:272`)
- Modify: `app/src-tauri/src/commands.rs` — `auto_dust_mask` (`:2112`), replace `count_blobs` (`:2154`), add `drop_excluded` + `blob_centroids`
- Test: `app/src-tauri/src/commands.rs` `#[cfg(test)]` module (existing, near `:2428`)

**Interfaces:**
- Produces: `fn blob_centroids(mask: &film_core::dust::Mask) -> Vec<[f64; 2]>` (normalized centroids); `fn drop_excluded(mask: &mut film_core::dust::Mask, exclusions: &[[f64; 2]])`; `auto_dust_mask(..., exclusions: &[[f64; 2]], cached: Option<...>)` (new `exclusions` param before `cached`); `BakeSpec.auto_dust_exclusions: Vec<[f64; 2]>`.

- [ ] **Step 1: Write the failing tests** (add to the `#[cfg(test)]` module in `commands.rs`, after the existing `union_mask_*` tests)

```rust
    #[test]
    fn blob_centroids_finds_one_blob_center() {
        // 4x4 frame, a single 2x2 set block at (x=2..3, y=0..1) → centroid (2.5,0.5).
        let mut bits = vec![false; 16];
        for &i in &[2usize, 3, 6, 7] {
            bits[i] = true;
        }
        let mask = film_core::dust::Mask { x0: 0, y0: 0, w: 4, h: 4, bits };
        let c = blob_centroids(&mask);
        assert_eq!(c.len(), 1);
        assert!((c[0][0] - 2.5 / 4.0).abs() < 1e-6, "cx {}", c[0][0]);
        assert!((c[0][1] - 0.5 / 4.0).abs() < 1e-6, "cy {}", c[0][1]);
    }

    #[test]
    fn drop_excluded_clears_only_the_seeded_blob() {
        // Two separate single-pixel blobs: keep one via an exclusion seed on it.
        let mut bits = vec![false; 16];
        bits[0] = true; // blob A at (0,0)
        bits[10] = true; // blob B at (2,2)
        let mut mask = film_core::dust::Mask { x0: 0, y0: 0, w: 4, h: 4, bits };
        // Seed on blob B (normalized center of pixel (2,2)).
        drop_excluded(&mut mask, &[[2.0 / 4.0, 2.0 / 4.0]]);
        assert!(mask.bits[0], "blob A kept");
        assert!(!mask.bits[10], "blob B cleared");
        assert_eq!(blob_centroids(&mask).len(), 1);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app/src-tauri && cargo test blob_centroids_finds_one_blob_center drop_excluded_clears_only_the_seeded_blob`
Expected: FAIL — `cannot find function blob_centroids` / `drop_excluded`.

- [ ] **Step 3: Add `blob_centroids` and `drop_excluded`** (in `commands.rs`, replacing the `count_blobs` function at `:2154`)

```rust
/// Connected components (4-neighbour) of the set pixels in a whole-frame mask,
/// returning each blob's centroid normalized to [0,1] (x by width, y by height).
/// These are the distinct dust/defect spots surfaced to the UI as heal markers.
fn blob_centroids(mask: &film_core::dust::Mask) -> Vec<[f64; 2]> {
    let (w, h) = (mask.w, mask.h);
    let mut out = Vec::new();
    if w == 0 || h == 0 {
        return out;
    }
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    for start in 0..w * h {
        if !mask.bits[start] || seen[start] {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut sx, mut sy, mut n) = (0usize, 0usize, 0usize);
        while let Some(p) = stack.pop() {
            let (x, y) = (p % w, p / w);
            sx += x;
            sy += y;
            n += 1;
            let mut push = |q: usize, seen: &mut Vec<bool>, stack: &mut Vec<usize>| {
                if mask.bits[q] && !seen[q] {
                    seen[q] = true;
                    stack.push(q);
                }
            };
            if x > 0 { push(p - 1, &mut seen, &mut stack); }
            if x + 1 < w { push(p + 1, &mut seen, &mut stack); }
            if y > 0 { push(p - w, &mut seen, &mut stack); }
            if y + 1 < h { push(p + w, &mut seen, &mut stack); }
        }
        if n > 0 {
            out.push([(sx as f64 / n as f64) / w as f64, (sy as f64 / n as f64) / h as f64]);
        }
    }
    out
}

/// Remove from `mask` any connected blob touched by an excluded seed point
/// (normalized [0,1]) — i.e. global dust the user chose to KEEP. A small search
/// window tolerates sub-pixel drift between the stored centroid and the
/// re-thresholded mask. Mutates the mask in place.
fn drop_excluded(mask: &mut film_core::dust::Mask, exclusions: &[[f64; 2]]) {
    let (w, h) = (mask.w, mask.h);
    if w == 0 || h == 0 || exclusions.is_empty() {
        return;
    }
    const WIN: i32 = 6; // px radius to snap a seed onto its blob
    for ex in exclusions {
        let cx = ((ex[0] * w as f64).round() as i32).clamp(0, w as i32 - 1);
        let cy = ((ex[1] * h as f64).round() as i32).clamp(0, h as i32 - 1);
        let mut seed: Option<usize> = None;
        'find: for dy in -WIN..=WIN {
            for dx in -WIN..=WIN {
                let x = cx + dx;
                let y = cy + dy;
                if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                    continue;
                }
                let i = y as usize * w + x as usize;
                if mask.bits[i] {
                    seed = Some(i);
                    break 'find;
                }
            }
        }
        let Some(s) = seed else { continue };
        let mut stack = vec![s];
        mask.bits[s] = false;
        while let Some(p) = stack.pop() {
            let (x, y) = (p % w, p / w);
            let mut clear = |q: usize, bits: &mut Vec<bool>, stack: &mut Vec<usize>| {
                if bits[q] {
                    bits[q] = false;
                    stack.push(q);
                }
            };
            if x > 0 { clear(p - 1, &mut mask.bits, &mut stack); }
            if x + 1 < w { clear(p + 1, &mut mask.bits, &mut stack); }
            if y > 0 { clear(p - w, &mut mask.bits, &mut stack); }
            if y + 1 < h { clear(p + w, &mut mask.bits, &mut stack); }
        }
    }
}
```

- [ ] **Step 4: Thread `exclusions` into `auto_dust_mask`** (at `commands.rs:2112`)

Change the signature and body so it drops excluded blobs after thresholding:

```rust
fn auto_dust_mask(
    app_data: &Path,
    baked: &film_core::Image,
    ip: &InversionParams,
    mode: Mode,
    sensitivity: f32,
    exclusions: &[[f64; 2]],
    cached: Option<(usize, usize, Vec<f32>)>,
) -> (film_core::dust::Mask, Option<(usize, usize, Vec<f32>)>) {
    let (w, h) = (baked.width, baked.height);
    let empty = film_core::dust::Mask { x0: 0, y0: 0, w: 0, h: 0, bits: Vec::new() };
    let positive = invert_image(baked, ip, mode);
    let (prob, fresh) = match cached {
        Some((cw, ch, p)) if (cw, ch) == (w, h) && p.len() == w * h => (p, None),
        _ => match crate::autodust::engine::detect(app_data, &positive) {
            Ok(p) => (p.clone(), Some((w, h, p))),
            Err(_) => return (empty, None),
        },
    };
    let max_blob = (crate::autodust::MAX_BLOB * w.max(h) / 2000).max(1);
    let mut mask = film_core::dust::prob_defect_mask(w, h, &prob, sensitivity, max_blob);
    drop_excluded(&mut mask, exclusions);
    (mask, fresh)
}
```

(The single caller is updated in Task 2; it will not compile standalone until then — that's expected and verified at the end of Task 2.)

- [ ] **Step 5: Add `auto_dust_exclusions` to `BakeSpec`** (`gpu_upload.rs:29`, after the `auto_dust` field)

```rust
    /// AI auto-dust: detector-driven defect mask, MI-GAN healed at bake time.
    #[serde(default)]
    pub auto_dust: AutoDust,
    /// Normalized [x,y] seed points for auto-dust blobs the user chose to KEEP
    /// (excluded from removal). Deleting a global heal spot adds its centroid here.
    #[serde(default)]
    pub auto_dust_exclusions: Vec<[f64; 2]>,
```

Add `auto_dust_exclusions: Vec::new(),` to each of the 3 `BakeSpec { … }` test literals in this file (after their `auto_dust: AutoDust::default(),` lines at `:225`, `:258`, `:285`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app/src-tauri && cargo test blob_centroids_finds_one_blob_center drop_excluded_clears_only_the_seeded_blob`
Expected: PASS. (Full-crate build still red until Task 2 fixes the `auto_dust_mask` call site — acceptable mid-task; these two unit tests compile and pass.)

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/gpu_upload.rs app/src-tauri/src/commands.rs
git commit -m "feat(eraser): auto-dust exclusions + blob centroids"
```

---

### Task 2: Backend — two-stage heal with cached auto-dust buffer (the bug fix)

Split the heal so global auto-dust is inpainted once and cached; brush strokes heal on top. This is what makes fine-tuning fast. Also emit the active spot centroids to the UI.

**Files:**
- Modify: `app/src-tauri/src/session.rs:269` (new cache field), `:321-326` (evict)
- Modify: `app/src-tauri/src/commands.rs` — add `autodust_heal` + `autodust_heal_key`, refactor `bake_for_view_from_baked` (`:2191`), rewrite `working_baked_pixels` body (`:2230`)
- Test: `commands.rs` `#[cfg(test)]` module

**Interfaces:**
- Consumes: `blob_centroids`, `drop_excluded`, `auto_dust_mask(..., exclusions, cached)` from Task 1.
- Produces: `fn autodust_heal(app_data, img, mask, base) -> Image` (Stage A); `fn autodust_heal_key(sensitivity: f32, exclusions: &[[f64;2]]) -> String`; `bake_for_view_from_baked(app_data, img, spec, base)` (auto_mask param REMOVED); `Session.autodust_healed: Mutex<HashMap<String,(String, Image)>>`. Event `autodust://result` payload becomes `{ id, count, spots: [[x,y],…] }`.

- [ ] **Step 1: Write the failing tests** (add to the `#[cfg(test)]` module in `commands.rs`)

```rust
    #[test]
    fn autodust_heal_key_is_stable_and_distinguishes_inputs() {
        let a = autodust_heal_key(50.0, &[[0.1, 0.2]]);
        assert_eq!(a, autodust_heal_key(50.0, &[[0.1, 0.2]]), "same inputs → same key");
        assert_ne!(a, autodust_heal_key(60.0, &[[0.1, 0.2]]), "sensitivity changes key");
        assert_ne!(a, autodust_heal_key(50.0, &[[0.1, 0.2], [0.3, 0.4]]), "exclusions change key");
        assert_ne!(a, autodust_heal_key(50.0, &[]), "no exclusions differs");
    }

    #[test]
    fn bake_for_view_telea_heals_strokes_without_auto_mask() {
        // migan=false → classic Telea fill heals the stroke; no app_data needed.
        let mut pixels = vec![[0.5_f32, 0.5, 0.5]; 16];
        pixels[5] = [0.9, 0.9, 0.9]; // speck at (1,1)
        let img = film_core::Image { width: 4, height: 4, pixels, ir: None };
        let spec = BakeSpec {
            rot90: 0, flip_h: false, flip_v: false, angle: 0.0, image_crop: None,
            dust: vec![DustStroke { points: vec![[0.25, 0.25]], r: 0.5 }],
            ir_removal: IrRemoval { enabled: false, sensitivity: 0.0 },
            skip_dust_heal: false, migan: false,
            auto_dust: AutoDust::default(), auto_dust_exclusions: Vec::new(),
        };
        let out = bake_for_view_from_baked(Path::new("/nonexistent"), img, &spec, [0.0; 3]);
        assert!((out.pixels[5][0] - 0.5).abs() < 0.35, "speck healed: {}", out.pixels[5][0]);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app/src-tauri && cargo test autodust_heal_key_is_stable bake_for_view_telea_heals_strokes`
Expected: FAIL — `cannot find function autodust_heal_key`; `bake_for_view_from_baked` takes 5 args (arity mismatch).

- [ ] **Step 3: Add the session cache field** (`session.rs`, after the `autodust_prob` field at `:269`)

```rust
    pub autodust_prob: Mutex<HashMap<String, (usize, usize, Vec<f32>)>>,
    /// Cached auto-dust-healed baked buffer per image id, keyed by a heal signature
    /// (sensitivity + exclusions). Lets a fine-tune brush stroke re-heal only its own
    /// region instead of re-inpainting every global dust spot. Proxy (fit) tier only;
    /// dropped when the detector prob map is recomputed (geometry/content change) or
    /// on LRU eviction.
    pub autodust_healed: Mutex<HashMap<String, (String, Image)>>,
```

In `evict_lru` (`session.rs:321-326`), also drop the healed buffer for evicted ids:

```rust
        if !evicted.is_empty() {
            let mut probs = self.autodust_prob.lock().unwrap();
            let mut healed = self.autodust_healed.lock().unwrap();
            for id in &evicted {
                probs.remove(id);
                healed.remove(id);
            }
        }
```

- [ ] **Step 4: Add `autodust_heal` + `autodust_heal_key` and refactor `bake_for_view_from_baked`** (`commands.rs`, replacing the function at `:2186-2224`)

```rust
/// MI-GAN-heal ONLY the auto-dust defect mask onto a geometry-baked buffer (Stage A).
/// Returns the healed buffer; the caller then heals brush strokes on top (Stage B).
/// No-op when the mask is empty or the model isn't installed.
fn autodust_heal(
    app_data: &Path,
    mut img: film_core::Image,
    mask: &film_core::dust::Mask,
    base: [f32; 3],
) -> film_core::Image {
    if mask.bits.iter().any(|&b| b) && crate::autodust::assets::installed(app_data) {
        let _ = crate::autodust::engine::inpaint(app_data, &mut img, mask, base);
    }
    img
}

/// Cache signature for the Stage-A auto-dust-healed buffer: sensitivity + the set of
/// kept-dust exclusions. Geometry is NOT included — a geometry change recomputes the
/// detector prob map (returns `fresh`), which the caller uses to drop this entry.
fn autodust_heal_key(sensitivity: f32, exclusions: &[[f64; 2]]) -> String {
    let mut s = format!("{:.2}", sensitivity);
    for e in exclusions {
        s.push_str(&format!("|{:.4},{:.4}", e[0], e[1]));
    }
    s
}

/// Heal an already-(geometry + auto-dust)-baked working buffer: brush dust strokes per
/// the spec's mode (classic Telea, MI-GAN, or skipped for the AI-mask overlay), then
/// IR. Global auto-dust is healed separately in Stage A (`autodust_heal`), so this no
/// longer touches the auto-dust mask — a fine-tune stroke only inpaints its own region.
fn bake_for_view_from_baked(
    app_data: &Path,
    mut img: film_core::Image,
    spec: &BakeSpec,
    base: [f32; 3],
) -> film_core::Image {
    let stamps = export_stamps(&spec.dust, img.width, img.height);
    let want_migan = spec.migan && crate::autodust::assets::installed(app_data);
    if want_migan {
        if !spec.skip_dust_heal {
            let mask = full_mask_from_stamps(img.width, img.height, &stamps);
            if mask.bits.iter().any(|&b| b) {
                let _ = crate::autodust::engine::inpaint(app_data, &mut img, &mask, base);
            }
        }
    } else if !spec.skip_dust_heal {
        film_core::dust::apply(&mut img, &stamps);
    }
    if spec.ir_removal.enabled {
        if let Some(ir) = img.ir.clone() {
            film_core::dust::apply_ir(&mut img, &ir, spec.ir_removal.sensitivity);
        }
    }
    img
}
```

- [ ] **Step 5: Rewrite `working_baked_pixels`** to do Stage A (cached) → Stage B, and emit centroids. Replace the block from `let cached = …` (`:2261`) through the end of the function (`:2295`):

```rust
    let cached_prob = if spec.auto_dust.enabled {
        session.autodust_prob.lock().unwrap().get(&id).cloned()
    } else {
        None
    };
    // Reuse the auto-dust-healed buffer only on the proxy tier (deep-zoom recomputes).
    let want_cache = spec.auto_dust.enabled && !hires;
    let cached_healed = if want_cache {
        session.autodust_healed.lock().unwrap().get(&id).cloned()
    } else {
        None
    };
    let do_auto = spec.auto_dust.enabled;
    let sens = spec.auto_dust.sensitivity;
    let exclusions = spec.auto_dust_exclusions.clone();
    // The heal can run the detector + MI-GAN (seconds) — keep it off the main thread so
    // the UI stays responsive. Returns any freshly computed prob map + a freshly healed
    // buffer to cache, and the active spot centroids to surface as UI markers.
    let (bytes, fresh, store_healed, spots) = tauri::async_runtime::spawn_blocking(move || {
        let baked = bake_geometry(&working, &spec);
        let mut fresh_prob = None;
        let mut store_healed: Option<(String, film_core::Image)> = None;
        let mut spots: Option<Vec<[f64; 2]>> = None;
        // Stage A: auto-dust heal (cached by sensitivity + exclusions).
        let stage_a = if do_auto && crate::autodust::assets::installed(&app_data) {
            let (mask, fr) = auto_dust_mask(&app_data, &baked, &ip, mode, sens, &exclusions, cached_prob);
            fresh_prob = fr;
            spots = Some(blob_centroids(&mask));
            let key = autodust_heal_key(sens, &exclusions);
            // A fresh prob means the detector re-ran (geometry/content changed) → any
            // cached heal is stale even if the key matches.
            match cached_healed {
                Some((ck, img)) if want_cache && ck == key && fresh_prob.is_none() => img,
                _ => {
                    let healed = autodust_heal(&app_data, baked, &mask, base);
                    if want_cache {
                        store_healed = Some((key, healed.clone()));
                    }
                    healed
                }
            }
        } else {
            baked
        };
        // Stage B: brush strokes + IR on top of the (cached) auto-dust-healed buffer.
        let healed = bake_for_view_from_baked(&app_data, stage_a, &spec, base);
        let (_, _, bytes) = pack_rgba16f(&healed, MAX_GPU_EDGE);
        (bytes, fresh_prob, store_healed, spots)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(p) = fresh {
        session.autodust_prob.lock().unwrap().insert(id.clone(), p);
    }
    if let Some(entry) = store_healed {
        session.autodust_healed.lock().unwrap().insert(id.clone(), entry);
    }
    if let Some(sp) = spots {
        use tauri::Emitter;
        let _ = app.emit(
            "autodust://result",
            serde_json::json!({ "id": id, "count": sp.len(), "spots": sp }),
        );
    }
    Ok(tauri::ipc::Response::new(bytes))
```

- [ ] **Step 6: Run the new tests + full crate build**

Run: `cd app/src-tauri && cargo test autodust_heal_key_is_stable bake_for_view_telea_heals_strokes && cargo build`
Expected: both tests PASS; `cargo build` succeeds (the `auto_dust_mask` call site from Task 1 now compiles with the `exclusions` argument).

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/commands.rs
git commit -m "perf(eraser): two-stage heal w/ cached auto-dust buffer; emit spot centroids"
```

---

### Task 3: Frontend data model — DustEdits fields, helpers, BakeSpec type

Add the persisted `autoDustExclusions` + `showSpots` fields and the pure helpers the UI needs, plus the `auto_dust_exclusions` wire field.

**Files:**
- Modify: `app/src/lib/develop/dust.ts`
- Modify: `app/src/lib/api.ts:110-116` (BakeSpec interface)
- Test: `app/src/lib/develop/dust.test.ts` (create)

**Interfaces:**
- Produces: `DustEdits.autoDustExclusions: DustPoint[]`, `DustEdits.showSpots: boolean`; `strokeCentroid(s): DustPoint`; `removeStrokeAt(d, i): DustEdits`; `addExclusion(d, p): DustEdits`; `setShowSpots(d, on): DustEdits`; `BakeSpec.auto_dust_exclusions: [number, number][]`.

- [ ] **Step 1: Write the failing tests** (create `app/src/lib/develop/dust.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { emptyDust, strokeCentroid, removeStrokeAt, addExclusion, setShowSpots } from "./dust";

describe("dust helpers", () => {
  it("strokeCentroid averages the polyline points", () => {
    expect(strokeCentroid({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], r: 0.1 })).toEqual({ x: 0.5, y: 0.5 });
    expect(strokeCentroid({ points: [], r: 0.1 })).toEqual({ x: 0, y: 0 });
  });

  it("removeStrokeAt removes by index and clears aiApplied", () => {
    const d = { ...emptyDust(), strokes: [{ points: [{ x: 0, y: 0 }], r: 0.1 }, { points: [{ x: 1, y: 1 }], r: 0.2 }], aiApplied: true };
    const out = removeStrokeAt(d, 0);
    expect(out.strokes).toHaveLength(1);
    expect(out.strokes[0].r).toBe(0.2);
    expect(out.aiApplied).toBe(false);
    expect(removeStrokeAt(d, 5).strokes).toHaveLength(2); // out of range → unchanged
  });

  it("addExclusion appends a kept-spot seed", () => {
    const out = addExclusion(emptyDust(), { x: 0.3, y: 0.4 });
    expect(out.autoDustExclusions).toEqual([{ x: 0.3, y: 0.4 }]);
  });

  it("setShowSpots toggles the overlay flag", () => {
    expect(setShowSpots(emptyDust(), false).showSpots).toBe(false);
  });

  it("emptyDust defaults the new fields", () => {
    expect(emptyDust().autoDustExclusions).toEqual([]);
    expect(emptyDust().showSpots).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run src/lib/develop/dust.test.ts`
Expected: FAIL — `strokeCentroid is not a function` (and others).

- [ ] **Step 3: Extend `DustEdits` + `emptyDust` and add helpers** (`dust.ts`)

In the `DustEdits` interface (after `aiApplied: boolean;`):

```ts
  aiApplied: boolean;
  /** Normalized seed points for global auto-dust spots the user chose to KEEP. */
  autoDustExclusions: DustPoint[];
  /** Show eraser-icon markers over heal locations in the viewport. */
  showSpots: boolean;
```

In `emptyDust()` (after `aiApplied: false,`):

```ts
  aiApplied: false,
  autoDustExclusions: [],
  showSpots: true,
```

Append the helpers at the end of the file:

```ts
/** Centroid (normalized) of a stroke's polyline — the eraser-marker anchor. */
export function strokeCentroid(s: DustStroke): DustPoint {
  if (s.points.length === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of s.points) { sx += p.x; sy += p.y; }
  return { x: sx / s.points.length, y: sy / s.points.length };
}
/** Remove the manual/AI heal spot (stroke) at `i`. Out-of-range → unchanged. */
export function removeStrokeAt(d: DustEdits, i: number): DustEdits {
  if (i < 0 || i >= d.strokes.length) return d;
  return { ...d, strokes: d.strokes.filter((_, k) => k !== i), aiApplied: false };
}
/** Keep a global auto-dust spot: exclude its centroid from removal. */
export function addExclusion(d: DustEdits, p: DustPoint): DustEdits {
  return { ...d, autoDustExclusions: [...d.autoDustExclusions, p] };
}
/** Toggle the heal-spot marker overlay. */
export function setShowSpots(d: DustEdits, showSpots: boolean): DustEdits {
  return { ...d, showSpots };
}
```

- [ ] **Step 4: Add the wire field to `BakeSpec`** (`api.ts:110-116`)

```ts
export interface BakeSpec {
  rot90: number; flip_h: boolean; flip_v: boolean; angle: number;
  image_crop: [number, number, number, number] | null;
  dust: DustStroke[];
  ir_removal: IrRemoval;
  auto_dust: AutoDust;
  auto_dust_exclusions: [number, number][];
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd app && npx vitest run src/lib/develop/dust.test.ts`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/develop/dust.ts app/src/lib/develop/dust.test.ts app/src/lib/api.ts
git commit -m "feat(eraser): DustEdits exclusions/showSpots fields + helpers"
```

---

### Task 4: Frontend stores — global spots + current selection

Hold the active image's global spot centroids and the currently selected heal spot.

**Files:**
- Modify: `app/src/lib/store.ts` (near the dust stores at `:30-34`)

**Interfaces:**
- Produces: `autodustSpotsById: Writable<Record<string, {x:number;y:number}[]>>`; `activeAutodustSpots: Readable<{x,y}[]>`; type `SpotSel = { kind: "stroke" | "auto"; index: number }`; `selectedSpot: Writable<SpotSel | null>`.

- [ ] **Step 1: Add the stores** (`store.ts`, after `activeDust` at `:34`)

```ts
/** Active image's global auto-dust spot centroids (normalized), from the backend
 *  `autodust://result` event. Cleared/replaced per image; drives the marker overlay. */
export const autodustSpotsById = writable<Record<string, { x: number; y: number }[]>>({});
export const activeAutodustSpots = derived([autodustSpotsById, activeId], ([m, id]) =>
  id ? m[id] ?? [] : []);

/** A selected heal spot: a brush stroke (by index into dust.strokes) or a global
 *  auto-dust spot (by index into activeAutodustSpots). null = nothing selected. */
export type SpotSel = { kind: "stroke" | "auto"; index: number };
export const selectedSpot = writable<SpotSel | null>(null);
```

(`writable`, `derived`, and `activeId` are already imported/defined in this file.)

- [ ] **Step 2: Verify the project still type-checks**

Run: `cd app && npm run check`
Expected: no NEW errors referencing `store.ts` (pre-existing warnings unrelated to this change are fine).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/store.ts
git commit -m "feat(eraser): stores for global spot centroids + selection"
```

---

### Task 5: EraserPanel — "Show heal spots" checkbox

**Files:**
- Modify: `/i18n-strings.csv` (add one row) → run `python3 scripts/gen-i18n.py`
- Modify: `app/src/lib/develop/EraserPanel.svelte`

**Interfaces:**
- Consumes: `setShowSpots` (Task 3).
- Produces: EraserPanel prop `showSpots: boolean` + dispatch event `showSpots: boolean`.

- [ ] **Step 1: Add the i18n string**

Add this row to `/i18n-strings.csv` (next to the other `eraser.*` rows, ~line 306):

```
eraser.showSpots,"Show heal spots","显示修复点","src/lib/develop/EraserPanel.svelte","label"
```

Run: `python3 scripts/gen-i18n.py`
Expected: regenerates `dict.ts` including `eraser.showSpots`. (Verify: `grep -n "eraser.showSpots" app/src/lib/i18n/dict.ts` — adjust path if the script writes elsewhere; do NOT hand-edit `dict.ts`.)

- [ ] **Step 2: Add the prop + checkbox** (`EraserPanel.svelte`)

In the `<script>` block, after `export let aiApplied = false;` (`:18`):

```ts
  /** Show eraser-icon markers over heal locations in the viewport. */
  export let showSpots = true;
```

Add `showSpots` to the dispatcher type (`:28-31`):

```ts
  const dispatch = createEventDispatcher<{
    reset: void; irEnabled: boolean; irSensitivity: number; brushMigan: boolean; aiErase: void;
    zoomArea: void; resetView: void; showSpots: boolean;
  }>();
```

In the markup, add the checkbox right before the final Reset button (before `<button class="row" on:click={() => dispatch("reset")}>` at `:86`):

```svelte
  <label class="check">
    <input type="checkbox" checked={showSpots}
           on:change={(e) => dispatch("showSpots", (e.target as HTMLInputElement).checked)} />
    <span>{$t('eraser.showSpots')}</span>
  </label>
```

(The `.check` style already exists in this component.)

- [ ] **Step 3: Verify it type-checks**

Run: `cd app && npm run check`
Expected: no new errors in `EraserPanel.svelte`.

- [ ] **Step 4: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts app/src/lib/develop/EraserPanel.svelte
git commit -m "feat(eraser): Show heal spots checkbox"
```

---

### Task 6: Viewport — render eraser-icon markers + hit-test select/double-tap

Render markers for brush strokes and global spots when `eraser && showSpots`, and turn taps near a marker into select / double-tap-remove events instead of paint strokes. Also send `auto_dust_exclusions` in the bake spec and fold it into the upload key.

**Files:**
- Modify: `app/src/lib/viewport/Viewport.svelte`

**Interfaces:**
- Consumes: `strokeCentroid` (Task 3); `SpotSel` (Task 4).
- Produces: Viewport props `showSpots: boolean`, `autoSpots: {x:number;y:number}[]`, `autoExclusions: {x:number;y:number}[]`, `selectedSpot: import("../store").SpotSel | null`; dispatch events `selectspot: SpotSel`, `removespot: SpotSel`.

- [ ] **Step 1: Add props + the marker model** (`Viewport.svelte` `<script>`)

After `export let aiApplied = false;` (`:44`) add:

```ts
  /** Heal-spot markers: show toggle, global spot centroids, kept-spot exclusions. */
  export let showSpots = true;
  export let autoSpots: { x: number; y: number }[] = [];
  export let autoExclusions: { x: number; y: number }[] = [];
  export let selectedSpot: import("../store").SpotSel | null = null;
```

Add `strokeCentroid` to the dust import (`:11`):

```ts
  import { screenRadius, strokeCentroid, type DustStroke } from "../develop/dust";
```

Add `selectspot`/`removespot` to the dispatcher type (`:56`), e.g. append:

```ts
  ; selectspot: import("../store").SpotSel; removespot: import("../store").SpotSel }>();
```

(Append the two members to the existing `createEventDispatcher<{…}>()` type literal rather than re-declaring it.)

- [ ] **Step 2: Add a derived marker list + element-space hit-test** (after `cursorR` at `:611`)

```ts
  // Marker anchors in normalized [0,1] space, both kinds, for rendering + hit-test.
  $: spotMarkers = [
    ...dust.map((s, index) => ({ kind: "stroke" as const, index, c: strokeCentroid(s) })),
    ...autoSpots.map((c, index) => ({ kind: "auto" as const, index, c })),
  ];
  // Markers are only interactive in the eraser tool while the toggle is on.
  $: spotsVisible = eraser && showSpots && spotMarkers.length > 0;
  const HIT_PX = 13; // tap radius (element px) to grab a marker instead of painting

  /** Nearest marker within HIT_PX of the event, or null. */
  function hitTestSpot(e: { clientX: number; clientY: number }): import("../store").SpotSel | null {
    const rect = el.getBoundingClientRect();
    const ex = e.clientX - rect.left, ey = e.clientY - rect.top;
    let best: import("../store").SpotSel | null = null;
    let bestD = HIT_PX * HIT_PX;
    for (const m of spotMarkers) {
      const mx = left + m.c.x * dispW, my = top + m.c.y * dispH;
      const d = (mx - ex) * (mx - ex) + (my - ey) * (my - ey);
      if (d <= bestD) { bestD = d; best = { kind: m.kind, index: m.index }; }
    }
    return best;
  }
  // Double-tap tracking: a second tap on the same marker within 300ms removes it.
  let lastTap: { kind: "stroke" | "auto"; index: number; t: number } | null = null;
```

- [ ] **Step 3: Intercept marker taps in `onDown`** (in the `if (eraser) { … }` paint branch at `:674-679`, before `painting = true;`)

```ts
    if (eraser) {
      if (spotsVisible && !marquee) {
        const hit = hitTestSpot(e);
        if (hit) {
          const now = performance.now();
          const same = lastTap && lastTap.kind === hit.kind && lastTap.index === hit.index && now - lastTap.t < 300;
          if (same) { dispatch("removespot", hit); lastTap = null; }
          else { dispatch("selectspot", hit); lastTap = { ...hit, t: now }; }
          return; // grabbed a marker → do not paint
        }
        lastTap = null;
      }
      painting = true;
      pending = [normPoint(e)];
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
```

- [ ] **Step 4: Send exclusions in the bake spec + upload key** (`:386-392` and `:354`)

In `uploadWorking`, the `spec` object — add the field:

```ts
        const spec = {
          rot90, flip_h: flipH, flip_v: flipV, angle,
          image_crop: imageCrop, dust, ir_removal: irRemoval,
          migan: brushMigan && aiApplied,
          skip_dust_heal: brushMigan && !aiApplied,
          auto_dust: { enabled: autoDustEnabled, sensitivity: autoDustSensitivity },
          auto_dust_exclusions: autoExclusions.map((p) => [p.x, p.y] as [number, number]),
        };
```

In `currentUploadKey()` (`:354`), append an exclusions term so a kept-spot change re-bakes (count is enough — `dustRev` already bumps, but keep the key honest):

```ts
      return `bake|${tier}|${id}|${developRev}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${brushMigan}|${aiApplied}|${autoDustEnabled}|${autoDustSensitivity}|${autoExclusions.length}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}`;
```

Add `autoExclusions` to the reactive upload trigger list (`:463`) so a change fires the upload:

```ts
  $: if (gpuEligible) { id; developRev; dustRev; irRemoval.enabled; irRemoval.sensitivity; brushMigan; aiApplied; autoDustEnabled; autoDustSensitivity; autoExclusions; imageCrop; rot90; flipH; flipV; angle; hiTier; uploadWorking(); }
```

- [ ] **Step 5: Render the markers** (markup, after the `{#if showMask}…{/if}` block at `:787`)

```svelte
  {#if spotsVisible}
    <div class="spots" style="left:{left}px; top:{top}px; width:{dispW}px; height:{dispH}px;" aria-hidden="true">
      {#each spotMarkers as m}
        <span class="spot" class:sel={selectedSpot && selectedSpot.kind === m.kind && selectedSpot.index === m.index}
              style="left:{m.c.x * dispW}px; top:{m.c.y * dispH}px;">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path d="M16.2 3.6 3.6 16.2a2 2 0 0 0 0 2.8l1.4 1.4a2 2 0 0 0 2.8 0L20.4 7.8a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0Z"
                  fill="currentColor" opacity="0.92" />
            <path d="M9 20.4h11" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </span>
      {/each}
    </div>
  {/if}
```

Add styles (in the `<style>` block):

```css
  .spots { position: absolute; pointer-events: none; z-index: 4; overflow: visible; }
  .spot { position: absolute; transform: translate(-50%, -50%); display: grid; place-items: center;
    width: 20px; height: 20px; border-radius: 50%; color: #fff;
    background: rgba(0,0,0,0.45); box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.35); }
  .spot.sel { color: #111; background: rgba(244,157,78,0.95);
    box-shadow: 0 0 0 2px rgba(244,157,78,0.6), 0 0 0 1px rgba(0,0,0,0.5); }
```

(The overlay is `pointer-events:none`; selection/removal go through `onDown`'s JS hit-test so taps on empty space still paint.)

- [ ] **Step 6: Verify it type-checks**

Run: `cd app && npm run check`
Expected: no new errors in `Viewport.svelte`. (Wiring of the new props/events happens in Task 7; unused-prop warnings are acceptable until then.)

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/viewport/Viewport.svelte
git commit -m "feat(eraser): heal-spot markers + tap-to-select/double-tap in viewport"
```

---

### Task 7: Develop — wire spots, selection, delete-hotkey, and removal

Listen for the backend centroids, feed the new props to the Viewport, handle select/remove events, and make the delete hotkey remove a selected spot when the eraser tool is active.

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte`

**Interfaces:**
- Consumes: `autodustSpotsById`, `activeAutodustSpots`, `selectedSpot`, `SpotSel` (Task 4); `removeStrokeAt`, `addExclusion`, `setShowSpots` (Task 3); Viewport events `selectspot`/`removespot` and prop names from Task 6.

- [ ] **Step 1: Imports + the result listener** (`Develop.svelte`)

Add to the store import (`:5`): `autodustSpotsById, activeAutodustSpots, selectedSpot`.
Add to the dust import (`:30`): `removeStrokeAt, addExclusion, setShowSpots`.
Add `import { listen } from "@tauri-apps/api/event";` near the other imports.

In the existing `onMount` (the prefetcher one at `:50-53`), also subscribe to the spots event:

```ts
  onMount(() => {
    const prefetcher = createPreviewPrefetcher();
    let un: (() => void) | null = null;
    listen<{ id: string; count: number; spots: [number, number][] }>("autodust://result", (e) => {
      const { id, spots } = e.payload;
      autodustSpotsById.update((m) => ({ ...m, [id]: (spots ?? []).map(([x, y]) => ({ x, y })) }));
    }).then((u) => { un = u; });
    return () => { prefetcher.stop(); un?.(); };
  });
```

- [ ] **Step 2: Selection lifecycle + removal handlers** (after `updateDust` at `:363`)

```ts
  const setShowSpotsEdit = (on: boolean) => updateDust((d) => setShowSpots(d, on));
  // Clear any selection when leaving the eraser tool or switching image.
  $: if ($tool !== "eraser") selectedSpot.set(null);
  $: { $activeId; selectedSpot.set(null); }

  /** Remove a heal spot: a brush stroke, or a global spot (kept via exclusion). */
  function removeSpot(sel: import("../store").SpotSel) {
    if (sel.kind === "stroke") {
      updateDust((d) => removeStrokeAt(d, sel.index));
    } else {
      const c = $activeAutodustSpots[sel.index];
      if (c) updateDust((d) => addExclusion(d, c));
    }
    selectedSpot.set(null);
  }
```

- [ ] **Step 3: Delete-hotkey guard** (in `runCombo`, the `case "nav.delete"` at `:263-268`)

```ts
      case "nav.delete": {
        if (inTextField()) return false;
        // In the eraser tool, the delete hotkey removes the selected heal spot
        // (not the image).
        if ($tool === "eraser" && get(selectedSpot)) {
          e.preventDefault();
          removeSpot(get(selectedSpot)!);
          return true;
        }
        e.preventDefault();
        const ids = deleteSelectionIds(); if (ids.length) deleteTarget.set(ids);
        return true;
      }
```

- [ ] **Step 4: Pass the new props/events to the Viewport** (`:459-471`)

Add to the `<Viewport>` props:

```svelte
                  showSpots={dust.showSpots} autoSpots={$activeAutodustSpots}
                  autoExclusions={dust.autoDustExclusions} selectedSpot={$selectedSpot}
```

Add to the `<Viewport>` event handlers:

```svelte
                  on:selectspot={(e) => selectedSpot.set(e.detail)}
                  on:removespot={(e) => removeSpot(e.detail)}
```

- [ ] **Step 5: Wire the EraserPanel checkbox** (`:500-510`)

Add the prop + handler to `<EraserPanel …>`:

```svelte
                         showSpots={dust.showSpots}
                         on:showSpots={(e) => setShowSpotsEdit(e.detail)}
```

- [ ] **Step 6: Verify type-check + full unit suite**

Run: `cd app && npm run check && npx vitest run`
Expected: no new type errors; all unit tests pass. If `npm run check` flags DustEdits object literals missing `autoDustExclusions`/`showSpots` in `src/lib/catalog.test.ts`, `src/lib/develop/history.test.ts`, or `src/lib/library/gridHiRes.test.ts`, add `autoDustExclusions: [], showSpots: true,` to each such literal (or switch it to spread `...emptyDust()`), then re-run.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/tabs/Develop.svelte app/src/lib/catalog.test.ts app/src/lib/develop/history.test.ts app/src/lib/library/gridHiRes.test.ts
git commit -m "feat(eraser): wire spot markers, selection, and delete-to-remove"
```

---

### Task 8: ExportModal — satisfy the new BakeSpec field + final verification

The `BakeSpec` interface now requires `auto_dust_exclusions`; the export path constructs a `BakeSpec` and must include it. Then verify the whole feature builds and runs.

**Files:**
- Modify: `app/src/lib/export/ExportModal.svelte:240-246`

- [ ] **Step 1: Add the field to the export spec** (`ExportModal.svelte`, the `const spec: BakeSpec = { … }` at `:240`)

```ts
        const spec: BakeSpec = {
          rot90: …, flip_h: …, flip_v: …, angle: …,   // keep existing values
          image_crop: …,                               // keep existing
          dust: …, ir_removal: …,                      // keep existing
          auto_dust: { enabled: false, sensitivity: 50 },
          auto_dust_exclusions: [],
        };
```

(Only add the `auto_dust_exclusions: []` line; leave every existing field as-is. Export does not run auto-dust, so an empty list is correct.)

- [ ] **Step 2: Full build + checks**

Run: `cd app && npm run check && npx vitest run`
Then: `cd app/src-tauri && cargo test && cargo build`
Expected: type-check clean, all TS + Rust tests pass, Rust builds.

- [ ] **Step 3: Manual smoke test** (GUI)

Launch the app (the project's run skill / `npm run tauri dev` from `app/`). In Develop → Eraser on a developed image:
1. Enable global AI dust removal; confirm eraser-icon markers appear on detected spots and the "N dust spots removed" toast still fires.
2. Enable "Brush AI", paint a small stroke, click "AI erase" — confirm it applies **quickly** (no multi-second re-inpaint of all global spots). This is the bug fix.
3. Toggle "Show heal spots" off/on — markers hide/show.
4. Tap a global spot marker (selects, highlights), press Cmd/Ctrl+Backspace — that dust returns (kept). Double-tap another global marker — same effect.
5. Tap a brush-stroke marker, press delete — that stroke is removed.
6. Switch images and back; reopen the app — kept-spot choices and strokes persist; the delete hotkey outside the eraser tool still deletes the image.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/export/ExportModal.svelte
git commit -m "feat(eraser): export spec carries auto_dust_exclusions"
```

---

## Self-Review notes (verified against the spec)

- **Bug fix (Part 1):** Tasks 1–2 — two-stage heal + `autodust_healed` cache keyed by `(sensitivity, exclusions)`, dropped on fresh prob / LRU evict; proxy tier only. ✔
- **Spot icons (Part 2):** Tasks 5–7 — `showSpots` checkbox, markers for strokes (`strokeCentroid`) + global spots (`autodust://result` → `autodustSpotsById`). ✔
- **Per-spot delete (Part 2):** Tasks 6–7 — hit-test select, double-tap, and `nav.delete` guard; stroke→`removeStrokeAt`, global→`addExclusion`. ✔
- **Persistence:** `autoDustExclusions` + `showSpots` ride existing `save_dust` JSON; `catalog.ts` merges with `emptyDust()` defaults. No backend persistence change needed. ✔
- **Type consistency:** `SpotSel`, `strokeCentroid`, `removeStrokeAt`, `addExclusion`, `setShowSpots`, `autodust_heal`, `autodust_heal_key`, `blob_centroids`, `drop_excluded`, `auto_dust_exclusions` used identically across tasks. ✔
- **Out of scope (per spec):** export does not heal auto-dust, so exclusions don't affect exported pixels (Task 8 just satisfies the type with `[]`). Detector/MI-GAN/Telea models unchanged; no per-spot undo system. ✔
