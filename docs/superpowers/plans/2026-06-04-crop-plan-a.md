# Crop — Plan A (no rotation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive crop box (brackets, rule-of-thirds, move/resize, Shift aspect-lock, aspect presets, orientation/`x`, default 80%, commit-on-leave/Enter, Esc-discard) whose committed per-image crop applies to the develop preview and the export. No rotation (that's Plan B).

**Architecture:** The committed crop is per-image state (`cropById` store). The backend `render_view`/`export_image` take a normalized `image_crop` and crop the working/full image before the existing pipeline. In crop mode `Develop` swaps `Viewport` for a focused `CropView` (full image at Fit) + `CropOverlay` (the interactive box) + `CropPanel` (aspect/orientation/reset); all geometry lives in a pure, tested `cropMath.ts`. Out of crop mode, `Viewport` renders with the committed crop applied.

**Tech Stack:** Rust (Tauri), TypeScript, Svelte 5, vitest, cargo test. cargo NOT on PATH — prefix with `source "$HOME/.cargo/env" && `. Frontend cwd: `/Users/mohaelder/Repos/filmrev/app`.

**Spec:** `docs/superpowers/specs/2026-06-04-crop-tool-design.md` (Plan A section).
**Branch:** `feat/develop-redesign`.

---

## File Structure

**Create:**
- `app/src/lib/crop/types.ts` — `CropRect`, `Rect`, `Handle` types.
- `app/src/lib/crop/presets.ts` (+ `.test.ts`) — aspect presets + `effectiveRatio`.
- `app/src/lib/crop/cropMath.ts` (+ `.test.ts`) — pure geometry (screen↔norm, hit-test, resize, clamp, conform, default80).
- `app/src/lib/crop/CropOverlay.svelte` — the box, brackets, grid, scrim, pointer interactions.
- `app/src/lib/crop/CropView.svelte` — full image at Fit + hosts `CropOverlay`.
- `app/src/lib/crop/CropPanel.svelte` — aspect dropdown, orientation/`x`, reset.

**Modify:**
- `app/src-tauri/src/commands.rs` — `ViewSpec.image_crop`; `render_view` pre-crop; `export_image` gains `image_crop` param; `crop_px` helper + test.
- `app/src/lib/api.ts` — `ViewSpec.image_crop?`; `exportImage` gains `imageCrop` arg.
- `app/src/lib/store.ts` — `cropById` writable + `activeCrop` derived.
- `app/src/lib/viewport/Viewport.svelte` — `imageCrop` prop → ViewSpec + srcKey.
- `app/src/lib/tabs/Develop.svelte` — crop-mode swap, commit/discard/keys, effective dims, export crop.

---

## Task 1: Backend `image_crop`

**Files:** Modify `app/src-tauri/src/commands.rs`

- [ ] **Step 1: Add a failing test for the pixel-mapping helper**

In the `#[cfg(test)] mod tests` of `commands.rs`:
```rust
    #[test]
    fn crop_px_maps_and_clamps_normalized_rect() {
        // full image when rect covers everything
        assert_eq!(crop_px([0.0, 0.0, 1.0, 1.0], 100, 80), (0, 0, 100, 80));
        // centered half
        assert_eq!(crop_px([0.25, 0.25, 0.5, 0.5], 100, 80), (25, 20, 50, 40));
        // clamps out-of-range and keeps at least 1px
        let (x, y, w, h) = crop_px([0.9, 0.9, 0.5, 0.5], 100, 80);
        assert!(x < 100 && y < 80 && w >= 1 && h >= 1 && x + w <= 100 && y + h <= 80);
    }
```

- [ ] **Step 2: Run to confirm FAIL**

Run: `source "$HOME/.cargo/env" && cargo test --manifest-path app/src-tauri/Cargo.toml crop_px`
Expected: compile error (`crop_px` undefined).

- [ ] **Step 3: Implement the helper + thread `image_crop`**

Add the helper near the other free fns in `commands.rs`:
```rust
/// Map a normalized crop rect [x,y,w,h] (0..1) to integer pixels on a w×h image,
/// clamped to bounds with a 1px minimum.
fn crop_px(norm: [f64; 4], w: usize, h: usize) -> (usize, usize, usize, usize) {
    let x = (norm[0] * w as f64).round().clamp(0.0, (w - 1) as f64) as usize;
    let y = (norm[1] * h as f64).round().clamp(0.0, (h - 1) as f64) as usize;
    let cw = (norm[2] * w as f64).round().clamp(1.0, (w - x) as f64) as usize;
    let ch = (norm[3] * h as f64).round().clamp(1.0, (h - y) as f64) as usize;
    (x, y, cw, ch)
}
```

Add `image_crop` to `ViewSpec` (after `finish`):
```rust
    /// Normalized [x,y,w,h] persistent crop on the original image; applied before
    /// the zoom/view crop. None = whole image.
    #[serde(default)]
    pub image_crop: Option<[f64; 4]>,
```

In `render_view`, after obtaining `dev` and computing `s_scale`, pre-crop the
working image. Replace the part that currently does the view crop:
```rust
    let s_scale = dev.working.width as f64 / img.metadata.width.max(1) as f64;
    let cx = (view.crop[0] * s_scale).max(0.0).round() as usize;
    let cy = (view.crop[1] * s_scale).max(0.0).round() as usize;
    let cw = (view.crop[2] * s_scale).round().max(1.0) as usize;
    let ch = (view.crop[3] * s_scale).round().max(1.0) as usize;
    let cropped = crop(&dev.working, cx, cy, cw, ch);
```
with:
```rust
    let s_scale = dev.working.width as f64 / img.metadata.width.max(1) as f64;
    // Persistent crop first (in working px), so the view crop is relative to it.
    let base_img = match view.image_crop {
        Some(nc) => {
            let (ix, iy, iw, ih) = crop_px(nc, dev.working.width, dev.working.height);
            crop(&dev.working, ix, iy, iw, ih)
        }
        None => dev.working.clone(),
    };
    let cx = (view.crop[0] * s_scale).max(0.0).round() as usize;
    let cy = (view.crop[1] * s_scale).max(0.0).round() as usize;
    let cw = (view.crop[2] * s_scale).round().max(1.0) as usize;
    let ch = (view.crop[3] * s_scale).round().max(1.0) as usize;
    let cropped = crop(&base_img, cx, cy, cw, ch);
```
(`dev.working.clone()` is acceptable; `crop` already returns a new image. If
`dev` is borrowed immutably this clone is required to own `base_img`.)

In `export_image`, add an `image_crop: Option<[f64;4]>` parameter and apply it to
the decoded full image before inversion. New signature + body:
```rust
#[tauri::command]
pub fn export_image(
    id: String, params: InvertParams, out_path: String,
    image_crop: Option<[f64; 4]>, session: State<Session>,
) -> Result<(), String> {
    let (path, base, thumb) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (img.path.clone(), dev.base, dev.thumb.clone())
    };
    let full = decode_any(Path::new(&path))?;
    let full = match image_crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, full.width, full.height);
            crop(&full, x, y, w, h)
        }
        None => full,
    };
    let ip = resolve_params(&params, &thumb, base);
    let inv = invert_image(&full, &ip, mode_from(&params.mode));
    let fin = finish_image(&inv, &finish_from(&params));
    film_core::export::write_tiff16(&fin, Path::new(&out_path)).map_err(|e| format!("{e}"))
}
```

- [ ] **Step 4: Run tests + clippy**

Run: `source "$HOME/.cargo/env" && cargo test --manifest-path app/src-tauri/Cargo.toml && cargo clippy --manifest-path app/src-tauri/Cargo.toml 2>&1 | tail -6`
Expected: all pass (15 tests); clippy no new warnings.

- [ ] **Step 5: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src-tauri/src/commands.rs
git commit -m "feat(backend): persistent image_crop in render_view + export_image"
```

---

## Task 2: TS contract + per-image crop store

**Files:** Modify `app/src/lib/api.ts`, `app/src/lib/store.ts`; Create `app/src/lib/crop/types.ts`

- [ ] **Step 1: Crop types**

Create `app/src/lib/crop/types.ts`:
```ts
/** Normalized rectangle on the original image, components in 0..1. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Committed per-image crop. aspect is a preset id or "custom". */
export interface CropRect {
  rect: Rect;
  aspect: string;
  orientation: "landscape" | "portrait";
}

export type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | null;
```

- [ ] **Step 2: `api.ts` — ViewSpec.image_crop + exportImage arg**

In `ViewSpec`, add:
```ts
  image_crop?: [number, number, number, number] | null; // normalized persistent crop
```
Change `exportImage` to take an optional crop:
```ts
  exportImage: (id: string, params: InvertParams, outPath: string, imageCrop: [number, number, number, number] | null = null) =>
    invoke<void>("export_image", { id, params, outPath, imageCrop }),
```

- [ ] **Step 3: `store.ts` — per-image crop**

Add to imports: `import type { CropRect } from "./crop/types";`
Add the stores (after the `params`/`editsById` block):
```ts
/** Per-image committed crop (null = full image). */
export const cropById = writable<Record<string, CropRect | null>>({});
/** The active image's committed crop. */
export const activeCrop = derived([cropById, activeId], ([m, id]) => (id ? m[id] ?? null : null));
```

- [ ] **Step 4: Typecheck**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run check 2>&1 | tail -12`
Expected: no new errors (only the pre-existing `workflow.test.ts` error). a11y warnings fine.

- [ ] **Step 5: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/crop/types.ts app/src/lib/api.ts app/src/lib/store.ts
git commit -m "feat(app): crop types, ViewSpec.image_crop, exportImage crop arg, cropById store"
```

---

## Task 3: Pure crop geometry — presets + cropMath (tested)

**Files:** Create `app/src/lib/crop/presets.ts` (+ `.test.ts`), `app/src/lib/crop/cropMath.ts` (+ `.test.ts`)

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/crop/presets.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PRESETS, effectiveRatio } from "./presets";

describe("presets", () => {
  it("includes Original first and the required ids", () => {
    expect(PRESETS[0].id).toBe("original");
    const ids = PRESETS.map((p) => p.id);
    for (const id of ["1:1", "4:5", "8.5:11", "5:7", "2:3", "4:4", "16:9", "16:10"])
      expect(ids).toContain(id);
  });
  it("effectiveRatio: landscape >= 1, portrait <= 1", () => {
    expect(effectiveRatio("4:5", 1.5, "landscape")).toBeCloseTo(5 / 4);
    expect(effectiveRatio("4:5", 1.5, "portrait")).toBeCloseTo(4 / 5);
  });
  it("Original resolves to the native ratio (oriented)", () => {
    expect(effectiveRatio("original", 1.5, "landscape")).toBeCloseTo(1.5);
    expect(effectiveRatio("original", 1.5, "portrait")).toBeCloseTo(1 / 1.5);
  });
});
```

Create `app/src/lib/crop/cropMath.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { clampRect, conform, applyDrag, default80, toScreen, MIN } from "./cropMath";
import type { Rect } from "./types";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("clampRect", () => {
  it("keeps the rect inside [0,1] and at least MIN", () => {
    const c = clampRect(r(-0.2, 0.9, 0.5, 0.5));
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(c.w).toBeGreaterThanOrEqual(MIN);
  });
});

describe("conform", () => {
  it("produces the target aspect ratio (w/h), centered, in bounds", () => {
    const c = conform(r(0.1, 0.1, 0.8, 0.8), 2); // wide 2:1
    expect(c.w / c.h).toBeCloseTo(2, 2);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("default80", () => {
  it("is centered 80% with the native ratio", () => {
    const c = default80(2); // native 2:1
    expect(c.w).toBeCloseTo(0.8, 2);
    expect(c.w / c.h).toBeCloseTo(2, 1);
    expect(c.x + c.w / 2).toBeCloseTo(0.5, 2);
  });
});

describe("applyDrag", () => {
  it("move shifts the rect by the delta", () => {
    const c = applyDrag("move", r(0.3, 0.3, 0.4, 0.4), 0.1, -0.1, null);
    expect(c.x).toBeCloseTo(0.4);
    expect(c.y).toBeCloseTo(0.2);
    expect(c.w).toBeCloseTo(0.4);
  });
  it("east handle grows width, freeform", () => {
    const c = applyDrag("e", r(0.2, 0.2, 0.3, 0.3), 0.1, 0, null);
    expect(c.w).toBeCloseTo(0.4);
    expect(c.x).toBeCloseTo(0.2);
  });
  it("corner with aspect lock preserves the ratio", () => {
    const c = applyDrag("se", r(0.2, 0.2, 0.3, 0.3), 0.2, 0.0, 1); // square lock
    expect(c.w / c.h).toBeCloseTo(1, 2);
  });
});

describe("toScreen", () => {
  it("maps a normalized rect into the image's screen rect", () => {
    const s = toScreen(r(0.5, 0, 0.5, 1), { left: 100, top: 50, width: 200, height: 100 });
    expect(s).toEqual({ left: 200, top: 50, width: 100, height: 100 });
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npx vitest run src/lib/crop/`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `presets.ts`**

```ts
export interface AspectPreset { id: string; label: string; ratio: number | null } // w/h; null = original

export const PRESETS: AspectPreset[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "1:1", label: "1 × 1", ratio: 1 },
  { id: "4:5", label: "4 × 5  ·  8 × 10", ratio: 4 / 5 },
  { id: "8.5:11", label: "8.5 × 11", ratio: 8.5 / 11 },
  { id: "5:7", label: "5 × 7", ratio: 5 / 7 },
  { id: "2:3", label: "2 × 3  ·  4 × 6", ratio: 2 / 3 },
  { id: "4:4", label: "4 × 4", ratio: 1 },
  { id: "16:9", label: "16 × 9", ratio: 16 / 9 },
  { id: "16:10", label: "16 × 10", ratio: 16 / 10 },
];

/** Effective target ratio (w/h) for a preset under an orientation.
 *  landscape → ≥1, portrait → ≤1. "original"/"custom" use the native ratio. */
export function effectiveRatio(
  id: string, nativeRatio: number, orientation: "landscape" | "portrait",
): number {
  const p = PRESETS.find((x) => x.id === id);
  const base = p && p.ratio != null ? p.ratio : nativeRatio;
  return orientation === "landscape" ? Math.max(base, 1 / base) : Math.min(base, 1 / base);
}

export function labelFor(id: string): string {
  if (id === "custom") return "Custom";
  return PRESETS.find((p) => p.id === id)?.label ?? "Custom";
}
```

- [ ] **Step 4: Implement `cropMath.ts`**

```ts
import type { Rect, Handle } from "./types";

export const MIN = 0.05; // minimum normalized box size

export interface ScreenRect { left: number; top: number; width: number; height: number }

/** Normalized rect → screen px rect within the image's screen rect. */
export function toScreen(r: Rect, img: ScreenRect): ScreenRect {
  return {
    left: img.left + r.x * img.width,
    top: img.top + r.y * img.height,
    width: r.w * img.width,
    height: r.h * img.height,
  };
}

/** Container px point → normalized image point (clamped 0..1). */
export function toNorm(px: number, py: number, img: ScreenRect): [number, number] {
  const nx = (px - img.left) / Math.max(1, img.width);
  const ny = (py - img.top) / Math.max(1, img.height);
  return [Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny))];
}

/** Which handle (if any) is under a container-px point. `tol` in px. */
export function handleAt(px: number, py: number, box: ScreenRect, tol: number): Handle {
  const l = box.left, t = box.top, rgt = box.left + box.width, b = box.top + box.height;
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const near = (a: number, bb: number) => Math.abs(a - bb) <= tol;
  const onL = near(px, l), onR = near(px, rgt), onT = near(py, t), onB = near(py, b);
  const midX = near(px, cx), midY = near(py, cy);
  const inX = px >= l - tol && px <= rgt + tol, inY = py >= t - tol && py <= b + tol;
  if (onL && onT) return "nw"; if (onR && onT) return "ne";
  if (onL && onB) return "sw"; if (onR && onB) return "se";
  if (onT && midX && inX) return "n"; if (onB && midX && inX) return "s";
  if (onL && midY && inY) return "w"; if (onR && midY && inY) return "e";
  if (px > l && px < rgt && py > t && py < b) return "move";
  return null;
}

/** Apply a normalized drag delta for a handle. aspect=w/h locks the ratio. */
export function applyDrag(h: Handle, r: Rect, dnx: number, dny: number, aspect: number | null): Rect {
  if (h === "move") return clampRect({ ...r, x: r.x + dnx, y: r.y + dny }, true);
  let { x, y, w, hh } = { x: r.x, y: r.y, w: r.w, hh: r.h };
  const east = h === "e" || h === "ne" || h === "se";
  const west = h === "w" || h === "nw" || h === "sw";
  const south = h === "s" || h === "se" || h === "sw";
  const north = h === "n" || h === "ne" || h === "nw";
  if (east) w += dnx;
  if (west) { x += dnx; w -= dnx; }
  if (south) hh += dny;
  if (north) { y += dny; hh -= dny; }
  if (aspect != null) {
    // Re-derive height from width (or vice-versa) anchored at the moving corner.
    if (h === "e" || h === "w") { const nh = w / aspect; y += (hh - nh) / 2; hh = nh; }
    else if (h === "n" || h === "s") { const nw = hh * aspect; x += (w - nw) / 2; w = nw; }
    else {
      const nh = w / aspect;
      if (north) y += hh - nh;
      hh = nh;
    }
  }
  return clampRect({ x, y, w, h: hh });
}

/** Clamp into [0,1] with a MIN size. When move=true, preserve size (just shift). */
export function clampRect(r: Rect, move = false): Rect {
  if (move) {
    const w = Math.min(r.w, 1), h = Math.min(r.h, 1);
    return { w, h, x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)) };
  }
  let { x, y, w, h } = r;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  w = Math.max(MIN, Math.min(1, w));
  h = Math.max(MIN, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

/** Centered rect of a target aspect (w/h) fitting within [0,1], ~80% of the frame. */
export function conform(r: Rect, aspect: number): Rect {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let w = Math.min(r.w, 1), h = w / aspect;
  if (h > 1) { h = 1; w = h * aspect; }
  if (w > 1) { w = 1; h = w / aspect; }
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
}

/** Default centered 80% rect with the native aspect ratio (w/h). */
export function default80(nativeRatio: number): Rect {
  let w = 0.8, h = 0.8;
  if (nativeRatio >= 1) h = w / nativeRatio; else w = h * nativeRatio;
  return clampRect({ x: 0.5 - w / 2, y: 0.5 - h / 2, w, h });
}
```

Note: `applyDrag`'s destructuring uses `hh` for height to avoid clashing with the
handle `h`. Keep it as written.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npx vitest run src/lib/crop/ && npm run check 2>&1 | tail -10`
Expected: all crop tests pass; no new typecheck errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/crop/presets.ts app/src/lib/crop/presets.test.ts app/src/lib/crop/cropMath.ts app/src/lib/crop/cropMath.test.ts
git commit -m "feat(app): pure crop geometry — presets + cropMath (tested)"
```

---

## Task 4: CropOverlay component

**Files:** Create `app/src/lib/crop/CropOverlay.svelte`

- [ ] **Step 1: Create `CropOverlay.svelte`**

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { Rect, Handle } from "./types";
  import { toScreen, handleAt, applyDrag, type ScreenRect } from "./cropMath";

  export let rect: Rect;             // bound by the parent (draft)
  export let img: ScreenRect;        // displayed image rect, container px
  export let lockRatio: number;      // effective w/h; used when Shift is held

  const dispatch = createEventDispatcher<{ custom: void }>();

  let host: HTMLDivElement;
  let active: Handle = null;
  let startRect: Rect = rect;
  let startX = 0, startY = 0;
  let hover: Handle = null;

  $: box = toScreen(rect, img);
  // Thirds guide offsets within the box.
  $: vx = [box.left + box.width / 3, box.left + (2 * box.width) / 3];
  $: hy = [box.top + box.height / 3, box.top + (2 * box.height) / 3];

  const CURSOR: Record<string, string> = {
    move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  };
  $: cursor = active ? CURSOR[active] : (hover ? CURSOR[hover] : "default");

  function localXY(e: PointerEvent): [number, number] {
    const r = host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onMove(e: PointerEvent) {
    const [px, py] = localXY(e);
    if (!active) { hover = handleAt(px, py, box, 12); return; }
    const dnx = (px - startX) / Math.max(1, img.width);
    const dny = (py - startY) / Math.max(1, img.height);
    const lock = e.shiftKey ? lockRatio : null;
    rect = applyDrag(active, startRect, dnx, dny, lock);
    if (active !== "move" && lock == null) dispatch("custom");
  }
  function onDown(e: PointerEvent) {
    const [px, py] = localXY(e);
    const h = handleAt(px, py, box, 12);
    if (!h) return;
    active = h; startRect = rect; startX = px; startY = py;
    host.setPointerCapture(e.pointerId);
  }
  function onUp() { active = null; }
</script>

<div
  bind:this={host} class="overlay" style="cursor:{cursor}"
  on:pointerdown={onDown} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onUp}
>
  <!-- dim scrim: 4 rects around the box -->
  <div class="scrim" style="left:0; top:0; right:0; height:{box.top}px"></div>
  <div class="scrim" style="left:0; top:{box.top + box.height}px; right:0; bottom:0"></div>
  <div class="scrim" style="left:0; top:{box.top}px; width:{box.left}px; height:{box.height}px"></div>
  <div class="scrim" style="left:{box.left + box.width}px; top:{box.top}px; right:0; height:{box.height}px"></div>

  <!-- box + thirds -->
  <div class="frame" style="left:{box.left}px; top:{box.top}px; width:{box.width}px; height:{box.height}px"></div>
  {#each vx as x}<div class="grid v" style="left:{x}px; top:{box.top}px; height:{box.height}px"></div>{/each}
  {#each hy as y}<div class="grid h" style="top:{y}px; left:{box.left}px; width:{box.width}px"></div>{/each}

  <!-- 8 brackets -->
  {#each [["nw",box.left,box.top],["ne",box.left+box.width,box.top],["sw",box.left,box.top+box.height],["se",box.left+box.width,box.top+box.height],["n",box.left+box.width/2,box.top],["s",box.left+box.width/2,box.top+box.height],["w",box.left,box.top+box.height/2],["e",box.left+box.width,box.top+box.height/2]] as b}
    <div class="bracket" style="left:{b[1]}px; top:{b[2]}px"></div>
  {/each}
</div>

<style>
  .overlay { position: absolute; inset: 0; user-select: none; touch-action: none; }
  .scrim { position: absolute; background: rgba(0,0,0,0.5); }
  .frame { position: absolute; border: 1px solid rgba(255,255,255,0.9); box-sizing: border-box; }
  .grid { position: absolute; background: rgba(255,255,255,0.3); }
  .grid.v { width: 1px; } .grid.h { height: 1px; }
  .bracket { position: absolute; width: 12px; height: 12px; transform: translate(-50%,-50%);
    border-radius: 2px; background: rgba(230,230,230,0.95); box-shadow: 0 0 2px rgba(0,0,0,0.6); }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run check 2>&1 | tail -12`
Expected: no new errors from `CropOverlay.svelte` (a11y warning on the pointer-handler div is acceptable, matching the codebase pattern).

- [ ] **Step 3: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/crop/CropOverlay.svelte
git commit -m "feat(app): CropOverlay — box, brackets, thirds, scrim, drag/resize"
```

---

## Task 5: CropView component

**Files:** Create `app/src/lib/crop/CropView.svelte`

- [ ] **Step 1: Create `CropView.svelte`**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { api, type InvertParams } from "../api";
  import type { Rect } from "./types";
  import CropOverlay from "./CropOverlay.svelte";
  import type { ScreenRect } from "./cropMath";

  export let id: string | null;
  export let params: InvertParams;
  export let imgW = 0;
  export let imgH = 0;
  export let rect: Rect;          // bound draft rect
  export let lockRatio: number;

  const PAD = 60;
  const CAP = 5000;
  let el: HTMLDivElement;
  let src = "";
  let vpW = 0, vpH = 0;

  function measure() { if (el) { vpW = el.clientWidth; vpH = el.clientHeight; } }
  onMount(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (el) ro.observe(el);
    return () => ro.disconnect();
  });

  // Fit the FULL image inside the padded viewport.
  $: avW = Math.max(1, vpW - 2 * PAD);
  $: avH = Math.max(1, vpH - 2 * PAD);
  $: fit = imgW > 0 && imgH > 0 && vpW > 0 ? Math.min(avW / imgW, avH / imgH) : 0;
  $: dispW = imgW * fit;
  $: dispH = imgH * fit;
  $: imgScreen = { left: (vpW - dispW) / 2, top: (vpH - dispH) / 2, width: dispW, height: dispH } as ScreenRect;

  let lastKey = "";
  async function render() {
    if (!id || !imgW || !vpW) return;
    const rscale = Math.min(fit, CAP / Math.max(imgW, imgH));
    const out_w = Math.max(1, Math.round(imgW * rscale));
    const out_h = Math.max(1, Math.round(imgH * rscale));
    try {
      src = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw: false, finish: true, image_crop: null,
      });
    } catch { /* keep last */ }
  }
  // Re-fetch the full image only when image / view size / inversion params change.
  $: key = `${id}|${vpW}|${vpH}|${imgW}|${imgH}|${params.mode}|${params.stock}|${params.exposure}|${params.temp}|${params.tint}|${params.contrast}|${params.highlights}|${params.shadows}|${params.whites}|${params.blacks}|${params.texture}|${params.vibrance}|${params.saturation}`;
  $: if (key !== lastKey) { lastKey = key; render(); }
</script>

<div class="cropvp" bind:this={el}>
  {#if src}
    <img {src} alt="crop" draggable="false"
      style="position:absolute; left:{imgScreen.left}px; top:{imgScreen.top}px; width:{dispW}px; height:{dispH}px;" />
    <CropOverlay bind:rect {img}={imgScreen} {lockRatio} on:custom />
  {:else}<div class="hint">…</div>{/if}
</div>

<style>
  .cropvp { position: relative; width: 100%; height: 100%; overflow: hidden;
    border-radius: 10px; user-select: none; }
  .hint { color: var(--text-dim); position: absolute; inset: 0; display: grid; place-items: center; }
</style>
```

Note: `<CropOverlay bind:rect {img}={imgScreen} ... />` — Svelte prop rename: the
overlay prop is `img`; pass `img={imgScreen}`. Write it as `img={imgScreen}` (not
`{img}={imgScreen}`). Correct line:
```svelte
    <CropOverlay bind:rect img={imgScreen} {lockRatio} on:custom />
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run check 2>&1 | tail -12`
Expected: no new errors from `CropView.svelte`.

- [ ] **Step 3: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/crop/CropView.svelte
git commit -m "feat(app): CropView — full image at Fit hosting the crop overlay"
```

---

## Task 6: CropPanel component

**Files:** Create `app/src/lib/crop/CropPanel.svelte`

- [ ] **Step 1: Create `CropPanel.svelte`**

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { PRESETS, labelFor } from "./presets";

  export let aspect: string;                       // bound preset id or "custom"
  export let orientation: "landscape" | "portrait"; // bound
  const dispatch = createEventDispatcher<{ preset: string; swap: void; reset: void }>();
</script>

<div class="section">
  <div class="head"><span>Crop</span></div>

  <div class="sub">Aspect ratio</div>
  <select value={aspect} on:change={(e) => dispatch("preset", (e.target as HTMLSelectElement).value)}>
    {#if aspect === "custom"}<option value="custom">Custom</option>{/if}
    {#each PRESETS as p}<option value={p.id}>{p.label}</option>{/each}
  </select>
  <div class="current">{labelFor(aspect)}</div>

  <button class="row" on:click={() => dispatch("swap")}>
    Orientation: {orientation === "landscape" ? "Landscape" : "Portrait"} <span class="key">X</span>
  </button>
  <button class="row" on:click={() => dispatch("reset")}>Reset</button>

  <div class="hint">Enter to apply · Esc to discard · Shift locks the ratio</div>
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { color: var(--text); font-weight: 600; padding: 4px 0; }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 12px 0 4px; }
  select { width: 100%; padding: 6px; border-radius: 8px; background: var(--bg-1);
    color: var(--text); border: 1px solid var(--glass-brd); }
  .current { font-size: 12px; color: var(--text-dim); margin: 4px 0 8px; }
  .row { width: 100%; display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; margin-bottom: 6px; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
  .key { font-size: 10px; border: 1px solid var(--glass-brd); border-radius: 4px; padding: 0 5px;
    color: var(--text-dim); }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run check 2>&1 | tail -10`
Expected: no new errors.
```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/crop/CropPanel.svelte
git commit -m "feat(app): CropPanel — aspect presets, orientation, reset"
```

---

## Task 7: Develop integration + Viewport imageCrop

**Files:** Modify `app/src/lib/viewport/Viewport.svelte`, `app/src/lib/tabs/Develop.svelte`

- [ ] **Step 1: Viewport `imageCrop` prop**

In `Viewport.svelte` script, add the prop (near the other `export let`):
```ts
  export let imageCrop: [number, number, number, number] | null = null;
```
In `render()`, add `image_crop: imageCrop` to the `renderView` `ViewSpec` object
(both the GL and non-GL fetch use the same object), i.e. change:
```ts
      const data = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw, finish: !(useGL && renderer),
      });
```
to:
```ts
      const data = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw, finish: !(useGL && renderer),
        image_crop: imageCrop,
      });
```
Add `imageCrop` to `srcKey` so a committed-crop change re-fetches:
```ts
  $: srcKey = `${id}|${raw}|${eff}|${vpW}|${vpH}|${params.mode}|${params.stock}|${params.exposure}|${params.temp}|${params.tint}|${imageCrop ? imageCrop.join(',') : 'full'}`;
```

- [ ] **Step 2: Rewrite `Develop.svelte` for crop mode**

Replace `app/src/lib/tabs/Develop.svelte` entirely:
```svelte
<script lang="ts">
  import { save } from "@tauri-apps/plugin-dialog";
  import { activeId, params, images, tool, cropById, activeCrop } from "../store";
  import { api } from "../api";
  import Filmstrip from "../panels/Filmstrip.svelte";
  import Viewport from "../viewport/Viewport.svelte";
  import QualityMenu from "../viewport/QualityMenu.svelte";
  import Histogram from "../viewport/Histogram.svelte";
  import Toolbar from "../develop/Toolbar.svelte";
  import Basic from "../develop/Basic.svelte";
  import GlassPanel from "../glass/GlassPanel.svelte";
  import CropView from "../crop/CropView.svelte";
  import CropPanel from "../crop/CropPanel.svelte";
  import type { Rect, CropRect } from "../crop/types";
  import { default80, conform } from "../crop/cropMath";
  import { effectiveRatio } from "../crop/presets";

  $: active = $images.find((i) => i.id === $activeId);
  $: origW = active?.metadata.width ?? 0;
  $: origH = active?.metadata.height ?? 0;
  $: nativeRatio = origH > 0 ? origW / origH : 1;

  // Committed crop → effective dims + image_crop for the normal Viewport.
  $: committed = $activeCrop;
  $: effW = committed ? Math.max(1, Math.round(committed.rect.w * origW)) : origW;
  $: effH = committed ? Math.max(1, Math.round(committed.rect.h * origH)) : origH;
  $: imageCrop = committed
    ? [committed.rect.x, committed.rect.y, committed.rect.w, committed.rect.h] as [number, number, number, number]
    : null;

  // ---- Crop draft state (only while tool === "crop") ----
  let rect: Rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  let aspect = "original";
  let orientation: "landscape" | "portrait" = "landscape";
  let cropInit = false;

  function startCrop() {
    const c = $activeCrop;
    if (c) { rect = { ...c.rect }; aspect = c.aspect; orientation = c.orientation; }
    else { rect = default80(nativeRatio); aspect = "original"; orientation = nativeRatio >= 1 ? "landscape" : "portrait"; }
    cropInit = true;
  }
  function commitCrop() {
    const id = $activeId; if (!id || !cropInit) return;
    const c: CropRect = { rect, aspect, orientation };
    cropById.update((m) => ({ ...m, [id]: c }));
  }
  function discardCrop() {
    const c = $activeCrop;
    if (c) { rect = { ...c.rect }; aspect = c.aspect; orientation = c.orientation; }
    else { rect = default80(nativeRatio); aspect = "original"; }
  }
  function onPreset(id: string) {
    aspect = id;
    rect = conform(rect, effectiveRatio(id, nativeRatio, orientation));
  }
  function onSwap() {
    orientation = orientation === "landscape" ? "portrait" : "landscape";
    rect = conform(rect, effectiveRatio(aspect, nativeRatio, orientation));
  }
  function onReset() { rect = default80(nativeRatio); aspect = "original"; orientation = nativeRatio >= 1 ? "landscape" : "portrait"; }

  $: lockRatio = effectiveRatio(aspect, nativeRatio, orientation);

  // Enter crop mode → init draft; leave crop mode → commit.
  let prevTool = $tool;
  $: {
    if ($tool === "crop" && prevTool !== "crop") startCrop();
    if ($tool !== "crop" && prevTool === "crop") { commitCrop(); cropInit = false; }
    prevTool = $tool;
  }

  function onKey(e: KeyboardEvent) {
    if ($tool !== "crop") return;
    if (e.key === "Enter") { commitCrop(); tool.set("edit"); }
    else if (e.key === "Escape") { discardCrop(); }
    else if (e.key === "x" || e.key === "X") { onSwap(); }
  }

  // ---- thumbnail refresh / context menu / export (unchanged behavior) ----
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshThumb() {
    if (thumbTimer) clearTimeout(thumbTimer);
    const id = $activeId;
    if (!id) return;
    thumbTimer = setTimeout(async () => {
      try {
        const t = await api.thumbnail(id, $params);
        images.update((xs) => xs.map((i) => (i.id === id ? { ...i, thumbnail: t } : i)));
      } catch { /* ignore */ }
    }, 400);
  }
  $: $params, $activeId, refreshThumb();

  let menu: { x: number; y: number } | null = null;
  function onContext(e: MouseEvent) { e.preventDefault(); menu = { x: e.clientX, y: e.clientY }; }

  let exporting = false, msg = "";
  async function exportTiff() {
    if (!$activeId) return;
    const out = await save({ defaultPath: "redroom-export.tiff", filters: [{ name: "TIFF", extensions: ["tiff"] }] });
    if (!out) return;
    exporting = true; msg = "";
    try { await api.exportImage($activeId, $params, out, imageCrop); msg = "Exported ✓"; }
    catch (e) { msg = "Error: " + e; }
    exporting = false;
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="layout" on:contextmenu={onContext}>
  <section class="center">
    {#if active?.developed}
      {#if $tool === "crop"}
        <CropView id={$activeId} params={$params} imgW={origW} imgH={origH}
                  bind:rect {lockRatio} on:custom={() => (aspect = "custom")} />
      {:else}
        <Viewport id={$activeId} params={$params} imgW={effW} imgH={effH} imageCrop={imageCrop} />
      {/if}
    {:else}<div class="hint">Not developed yet</div>{/if}
  </section>

  <aside class="right">
    <GlassPanel>
      <Histogram />
      <Toolbar />
      {#if $tool === "edit"}
        <Basic />
      {:else if $tool === "crop"}
        <CropPanel bind:aspect bind:orientation
                   on:preset={(e) => onPreset(e.detail)} on:swap={onSwap} on:reset={onReset} />
      {/if}
      <button class="export" on:click={exportTiff} disabled={exporting || !$activeId}>
        {exporting ? "Exporting…" : "Export 16-bit TIFF"}
      </button>
      {#if msg}<div class="msg">{msg}</div>{/if}
    </GlassPanel>
  </aside>

  <footer class="bottom"><Filmstrip /></footer>
</div>
{#if menu}<QualityMenu x={menu.x} y={menu.y} on:close={() => (menu = null)} />{/if}

<style>
  .layout { display: grid; height: 100%; gap: 12px;
    grid-template-columns: 1fr 300px; grid-template-rows: 1fr 88px;
    grid-template-areas: "center right" "bottom bottom"; }
  .right { grid-area: right; min-height: 0; overflow-y: auto; }
  .center { grid-area: center; min-height: 0; display: grid; place-items: center; }
  .hint { color: var(--text-dim); }
  .bottom { grid-area: bottom; }
  .export { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 10px;
    background: var(--accent); color: white; font-weight: 600; cursor: pointer; }
  .export:disabled { opacity: 0.5; }
  .msg { margin-top: 8px; color: var(--text-dim); font-size: 12px; }
</style>
```

- [ ] **Step 3: Typecheck + unit tests**

Run: `cd /Users/mohaelder/Repos/filmrev/app && npm run check 2>&1 | tail -15 && npx vitest run 2>&1 | tail -5`
Expected: no new typecheck errors (only the pre-existing `workflow.test.ts`); all vitest pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/mohaelder/Repos/filmrev
git add app/src/lib/viewport/Viewport.svelte app/src/lib/tabs/Develop.svelte
git commit -m "feat(app): wire crop tool into Develop (CropView/CropPanel, commit/discard/keys, export crop)"
```

---

## Task 8: Verification + manual smoke

**Files:** none

- [ ] **Step 1: Automated checks**

Run:
```
source "$HOME/.cargo/env" && cargo test --manifest-path app/src-tauri/Cargo.toml 2>&1 | grep "test result"
cd /Users/mohaelder/Repos/filmrev/app && npm run check 2>&1 | tail -1 && npx vitest run 2>&1 | tail -4
```
Expected: backend tests pass (15); svelte-check shows only the pre-existing `workflow.test.ts` error; all vitest pass.

- [ ] **Step 2: Manual smoke (user, in the running app)**

In Develop on a developed image, click the **Crop** toolbar tool:
- The full image shows with a default **80%** crop box, brackets at 4 corners + 4
  edge midpoints, rule-of-thirds guides, dimmed surround.
- **Drag inside** moves the box; **drag a bracket** resizes; **Shift** while
  resizing locks the current ratio.
- The **aspect dropdown** (Original, 1×1, 4×5, 8.5×11, 5×7, 2×3, 4×4, 16×9, 16×10)
  conforms the box; the active ratio name shows; freeform resize shows **Custom**.
- **Orientation** button and the **`x`** key swap portrait/landscape.
- **Enter** (or switching to Edit) commits → the Edit view now shows the **cropped**
  image; **Esc** discards unsaved changes.
- **Export** produces a TIFF cropped to the committed rect.
- Crop is **per-image** (cropping A doesn't change B).

- [ ] **Step 3: Final commit (only if smoke needed fixups)**

```bash
cd /Users/mohaelder/Repos/filmrev
git add -A && git commit -m "fix: crop tool smoke fixups"
```

---

## Self-Review notes

- **Spec coverage (Plan A):** data model + per-image store (Task 2); backend
  image_crop in preview+export (Task 1); pure geometry presets/cropMath (Task 3);
  CropOverlay box/brackets/thirds/scrim/drag/resize/Shift-lock (Task 4); CropView
  full-image-at-Fit (Task 5); CropPanel aspect/orientation/`x`/reset (Task 6);
  Develop crop-mode swap, commit-on-leave/Enter, Esc-discard, default-80%, effective
  dims, export crop (Task 7); verification (Task 8).
- **Placeholder scan:** none — full code in every step. (Two inline notes correct a
  Svelte prop-pass form and the `hh` height alias — both explicit.)
- **Type consistency:** `Rect`/`CropRect`/`Handle` (types.ts) used in cropMath,
  CropOverlay, CropView, Develop; `ScreenRect` from cropMath used in CropView/
  CropOverlay; `effectiveRatio`/`PRESETS`/`labelFor` (presets.ts) used in Develop/
  CropPanel; `ViewSpec.image_crop` matches Rust `#[serde(default)] Option<[f64;4]>`
  and TS `image_crop?`; `exportImage(..., imageCrop)` matches the Rust
  `export_image(..., image_crop, session)` arg order (Tauri matches by name:
  `imageCrop` → `image_crop`).
- **Known carry-over:** the pre-existing `workflow.test.ts` `path` error is
  unrelated and out of scope.
