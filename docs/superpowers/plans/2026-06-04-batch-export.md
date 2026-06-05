# Batch Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single "Export 16-bit TIFF" button with a top-nav Export button that opens a modal to multi-select developed images, choose a format (JPEG/TIFF/PNG with quality/bit-depth options), and batch-export them to a chosen folder.

**Architecture:** Frontend orchestrates the loop — an `ExportModal` reads each selected image's per-image edits from the existing `editsById`/`cropById`/`dustById` stores and calls a generalized `export_image` command once per file. New PNG/JPEG/8-bit-TIFF encoders live in `src-tauri/encode.rs` (which has the `image` crate); 16-bit TIFF keeps the existing `film_core::export::write_tiff16`. film-core is unchanged.

**Tech Stack:** Rust (Tauri commands, `image` 0.25 crate), SvelteKit + TypeScript, vitest, `@tauri-apps/plugin-dialog`, `@tauri-apps/api/path`.

**Environment note:** Run `source "$HOME/.cargo/env"` before any `cargo` command. Frontend commands run in `app/`.

---

## File Structure

**Backend (Rust):**
- Modify `app/src-tauri/src/encode.rs` — add `to_rgb16`, `write_png`, `write_tiff8`, `encode_jpeg_bytes`, `write_jpeg`.
- Modify `app/src-tauri/src/commands.rs` — add `ExportFormat` struct; change `export_image` to take `format` and dispatch to the right encoder.

**Frontend (TypeScript/Svelte):**
- Modify `app/src/lib/api.ts` — add `ExportFormat` type; extend `exportImage` with a trailing `format` arg.
- Create `app/src/lib/export/selection.ts` + `selection.test.ts` — pure multi-select model.
- Create `app/src/lib/export/naming.ts` + `naming.test.ts` — original filename → `<stem>.<ext>`.
- Modify `app/src/lib/store.ts` — add `developedImages` / `hasDeveloped` derived stores.
- Create `app/src/lib/export/ExportModal.svelte` — the picker + format panel + export loop.
- Modify `app/src/routes/+page.svelte` — Export nav button (right of Develop) + mount modal.
- Modify `app/src/lib/tabs/Develop.svelte` — remove the old export button, `exportTiff()`, and `save` import.

---

## Task 1: Backend encoders in `encode.rs`

**Files:**
- Modify: `app/src-tauri/src/encode.rs`

- [ ] **Step 1: Write the failing tests**

Add these tests to the existing `#[cfg(test)] mod tests` block in `app/src-tauri/src/encode.rs` (keep the existing two tests):

```rust
    fn gradient(w: usize, h: usize) -> Image {
        let mut px = Vec::with_capacity(w * h);
        for i in 0..w * h {
            let t = (i as f32) / ((w * h) as f32);
            px.push([t, 1.0 - t, (t * 2.0).fract()]);
        }
        Image { width: w, height: h, pixels: px, ir: None }
    }

    #[test]
    fn png8_writes_decodable_file() {
        let p = std::env::temp_dir().join("filmrev_t1_png8.png");
        write_png(&gradient(8, 4), &p, 8).unwrap();
        let d = image::open(&p).unwrap();
        assert_eq!((d.width(), d.height()), (8, 4));
    }

    #[test]
    fn png16_writes_decodable_file() {
        let p = std::env::temp_dir().join("filmrev_t1_png16.png");
        write_png(&gradient(8, 4), &p, 16).unwrap();
        let d = image::open(&p).unwrap();
        assert_eq!((d.width(), d.height()), (8, 4));
        assert_eq!(d.color().bits_per_pixel(), 48); // 16-bit RGB
    }

    #[test]
    fn tiff8_writes_decodable_file() {
        let p = std::env::temp_dir().join("filmrev_t1_tiff8.tiff");
        write_tiff8(&gradient(6, 3), &p).unwrap();
        let d = image::open(&p).unwrap();
        assert_eq!((d.width(), d.height()), (6, 3));
    }

    #[test]
    fn jpeg_quality_is_monotonic() {
        let g = gradient(64, 64);
        let lo = encode_jpeg_bytes(&g, 20).unwrap().len();
        let hi = encode_jpeg_bytes(&g, 95).unwrap().len();
        assert!(hi >= lo, "hi {hi} should be >= lo {lo}");
    }

    #[test]
    fn jpeg_respects_max_bytes() {
        let g = gradient(64, 64);
        let big = encode_jpeg_bytes(&g, 95).unwrap().len() as u64;
        let floor = encode_jpeg_bytes(&g, 1).unwrap().len() as u64;
        let cap = (big / 4).max(1);
        let p = std::env::temp_dir().join("filmrev_t1_cap.jpg");
        write_jpeg(&g, &p, 95, Some(cap)).unwrap();
        let got = std::fs::metadata(&p).unwrap().len();
        assert!(got <= cap || got == floor, "got {got} cap {cap} floor {floor}");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source "$HOME/.cargo/env" && cargo test -p app --lib encode 2>&1 | tail -20`
Expected: compile errors — `write_png`, `write_tiff8`, `encode_jpeg_bytes`, `write_jpeg` not found.

- [ ] **Step 3: Implement the encoders**

At the top of `app/src-tauri/src/encode.rs`, extend the `use image::...` line to include `Rgb` u16 support and `Path`. Replace:

```rust
use image::{ImageBuffer, ImageEncoder, Rgb};
```

with:

```rust
use image::{ImageBuffer, ImageEncoder, Rgb};
use std::path::Path;
```

Then add these functions (after `to_rgb8`, before the `#[cfg(test)]` block):

```rust
/// Build a 16-bit RGB buffer from the toned image (no gamma — output is already
/// display-encoded, matching the TIFF/preview path).
fn to_rgb16(img: &Image) -> ImageBuffer<Rgb<u16>, Vec<u16>> {
    let mut buf: ImageBuffer<Rgb<u16>, Vec<u16>> =
        ImageBuffer::new(img.width as u32, img.height as u32);
    for (i, px) in img.pixels.iter().enumerate() {
        let x = (i % img.width) as u32;
        let y = (i / img.width) as u32;
        let enc = |v: f32| -> u16 { (v.clamp(0.0, 1.0) * 65535.0).round() as u16 };
        buf.put_pixel(x, y, Rgb([enc(px[0]), enc(px[1]), enc(px[2])]));
    }
    buf
}

/// Write a PNG file at 8 or 16 bits. Format is inferred from the `.png` path.
pub fn write_png(img: &Image, path: &Path, bits: u8) -> Result<(), String> {
    if bits == 16 {
        to_rgb16(img).save(path).map_err(|e| format!("png16 write: {e}"))
    } else {
        to_rgb8(img, false).save(path).map_err(|e| format!("png8 write: {e}"))
    }
}

/// Write an 8-bit RGB TIFF (16-bit goes through film_core::export::write_tiff16).
pub fn write_tiff8(img: &Image, path: &Path) -> Result<(), String> {
    to_rgb8(img, false).save(path).map_err(|e| format!("tiff8 write: {e}"))
}

/// Encode the toned image to in-memory JPEG bytes at the given quality (1–100).
pub fn encode_jpeg_bytes(img: &Image, quality: u8) -> Result<Vec<u8>, String> {
    let buf = to_rgb8(img, false);
    let mut bytes: Vec<u8> = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality.clamp(1, 100))
        .encode(buf.as_raw(), buf.width(), buf.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(bytes)
}

/// Write a JPEG file. Encodes at `quality`; if `max_bytes` is set and the result
/// exceeds it, binary-searches quality downward to the largest value that fits
/// (floor at quality 1).
pub fn write_jpeg(img: &Image, path: &Path, quality: u8, max_bytes: Option<u64>) -> Result<(), String> {
    let ceil = quality.clamp(1, 100);
    let bytes = match max_bytes {
        None => encode_jpeg_bytes(img, ceil)?,
        Some(cap) => {
            let mut lo: u8 = 1;
            let mut hi: u8 = ceil;
            let mut best = encode_jpeg_bytes(img, 1)?; // q=1 fallback if nothing fits
            while lo <= hi {
                let mid = lo + (hi - lo) / 2;
                let candidate = encode_jpeg_bytes(img, mid)?;
                if (candidate.len() as u64) <= cap {
                    best = candidate;
                    if mid == 100 { break; }
                    lo = mid + 1;
                } else {
                    if mid == 1 { break; }
                    hi = mid - 1;
                }
            }
            best
        }
    };
    std::fs::write(path, &bytes).map_err(|e| format!("jpeg write: {e}"))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p app --lib encode 2>&1 | tail -20`
Expected: all encode tests PASS (existing 2 + new 5).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/encode.rs
git commit -m "feat(export): add PNG/JPEG/8-bit-TIFF file encoders with JPEG size cap"
```

---

## Task 2: `ExportFormat` + generalized `export_image` dispatch

**Files:**
- Modify: `app/src-tauri/src/commands.rs:306-344`

- [ ] **Step 1: Add the `ExportFormat` struct**

Near the top of `app/src-tauri/src/commands.rs`, after the existing `use` lines, change the encode import and add the struct. Replace:

```rust
use crate::encode::{to_jpeg_b64, to_png_b64};
```

with:

```rust
use crate::encode::{to_jpeg_b64, to_png_b64, write_jpeg, write_png, write_tiff8};

fn default_bits() -> u8 { 16 }

/// Output format chosen in the Export modal. Mirrors the JS `ExportFormat` object.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFormat {
    pub kind: String, // "jpeg" | "tiff" | "png"
    #[serde(default = "default_bits")]
    pub bit_depth: u8, // 8 | 16 (tiff/png)
    #[serde(default)]
    pub quality: u8, // jpeg, 1–100
    #[serde(default)]
    pub max_bytes: Option<u64>, // jpeg
}
```

- [ ] **Step 2: Change `export_image` to accept and dispatch on `format`**

Replace the whole `export_image` function (lines ~306-344) with:

```rust
/// Re-decode the file at full resolution and export it in the chosen format.
#[allow(clippy::too_many_arguments)] // Tauri command: flat args mirror the JS invoke contract
#[tauri::command]
pub fn export_image(
    id: String, params: InvertParams, out_path: String,
    image_crop: Option<[f64; 4]>,
    rot90: u8, flip_h: bool, flip_v: bool, angle: f32,
    dust: Vec<DustStroke>,
    ir_removal: IrRemoval,
    format: ExportFormat,
    session: State<Session>,
) -> Result<(), String> {
    let (path, base, thumb) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (img.path.clone(), dev.base, dev.thumb.clone())
    };
    let full = decode_any(Path::new(&path))?;
    let full = orient(&full, rot90, flip_h, flip_v);
    let full = rotate(&full, angle);
    let full = match image_crop {
        Some(nc) => {
            let (x, y, w, h) = crop_px(nc, full.width, full.height);
            crop(&full, x, y, w, h)
        }
        None => full,
    };
    let ip = resolve_params(&params, &thumb, base);
    let mut inv = invert_image(&full, &ip, mode_from(&params.mode));
    let stamps = export_stamps(&dust, inv.width, inv.height);
    dust::apply(&mut inv, &stamps);
    if ir_removal.enabled {
        if let Some(ir) = full.ir.as_ref() {
            dust::apply_ir(&mut inv, ir, ir_removal.sensitivity);
        }
    }
    let fin = finish_image(&inv, &finish_from(&params));
    let out = Path::new(&out_path);
    match format.kind.as_str() {
        "tiff" => {
            if format.bit_depth == 16 {
                film_core::export::write_tiff16(&fin, out).map_err(|e| format!("{e}"))
            } else {
                write_tiff8(&fin, out)
            }
        }
        "png" => write_png(&fin, out, format.bit_depth),
        "jpeg" => write_jpeg(&fin, out, format.quality, format.max_bytes),
        other => Err(format!("unknown export format: {other}")),
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `source "$HOME/.cargo/env" && cargo build -p app 2>&1 | tail -20`
Expected: builds clean (no errors). If a stale-incremental ThinLTO `.llvm.`-symbol link error appears, run `cargo clean -p app` then rebuild (known environment quirk, not a code defect).

- [ ] **Step 4: Run the backend test suite**

Run: `source "$HOME/.cargo/env" && cargo test -p app 2>&1 | tail -20`
Expected: all existing src-tauri tests still PASS plus the new encode tests.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "feat(export): dispatch export_image on ExportFormat (jpeg/tiff/png, 8/16-bit)"
```

---

## Task 3: `ExportFormat` type + `exportImage` API extension

**Files:**
- Modify: `app/src/lib/api.ts:9-67`

- [ ] **Step 1: Add the `ExportFormat` type**

In `app/src/lib/api.ts`, add this interface near the other exported types (e.g. just above `export const api = {`):

```typescript
export interface ExportFormat {
  kind: "jpeg" | "tiff" | "png";
  bitDepth?: 8 | 16;     // tiff/png only
  quality?: number;      // jpeg only, 1–100
  maxBytes?: number | null; // jpeg only
}
```

- [ ] **Step 2: Extend `exportImage` to pass `format`**

Replace the existing `exportImage` entry in the `api` object with:

```typescript
  exportImage: (
    id: string, params: InvertParams, outPath: string,
    imageCrop: [number, number, number, number] | null = null,
    geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {},
    dust: DustStroke[] = [],
    irRemoval: IrRemoval = { enabled: false, sensitivity: 50 },
    format: ExportFormat = { kind: "tiff", bitDepth: 16 },
  ) =>
    invoke<void>("export_image", {
      id, params, outPath, imageCrop,
      rot90: geom.rot90 ?? 0, flipH: geom.flip_h ?? false,
      flipV: geom.flip_v ?? false, angle: geom.angle ?? 0,
      dust: wireDust(dust), irRemoval, format,
    }),
```

- [ ] **Step 3: Verify types compile**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: 0 errors (Develop.svelte still calls the old 7-arg form, which is valid since `format` has a default).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/api.ts
git commit -m "feat(export): add ExportFormat type and pass format to export_image"
```

---

## Task 4: Selection model (`selection.ts`)

**Files:**
- Create: `app/src/lib/export/selection.ts`
- Test: `app/src/lib/export/selection.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/export/selection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { allSelected, noneSelected, click, isAllSelected, toggleAll } from "./selection";

const ids = ["a", "b", "c", "d"];

describe("selection model", () => {
  it("allSelected selects everything with last as anchor", () => {
    const s = allSelected(ids);
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "d"]);
    expect(s.anchor).toBe("d");
  });

  it("plain click selects only that item", () => {
    const s = click(allSelected(ids), ids, "b", { meta: false, shift: false });
    expect([...s.selected]).toEqual(["b"]);
    expect(s.anchor).toBe("b");
  });

  it("meta-click toggles a single item and moves anchor", () => {
    let s = click(noneSelected(), ids, "a", { meta: true, shift: false });
    expect([...s.selected]).toEqual(["a"]);
    s = click(s, ids, "c", { meta: true, shift: false });
    expect([...s.selected].sort()).toEqual(["a", "c"]);
    expect(s.anchor).toBe("c");
    s = click(s, ids, "a", { meta: true, shift: false });
    expect([...s.selected]).toEqual(["c"]);
  });

  it("shift-click selects the inclusive range from the anchor", () => {
    const base = click(noneSelected(), ids, "b", { meta: false, shift: false });
    const s = click(base, ids, "d", { meta: false, shift: true });
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
  });

  it("shift-click works backwards too", () => {
    const base = click(noneSelected(), ids, "c", { meta: false, shift: false });
    const s = click(base, ids, "a", { meta: false, shift: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
  });

  it("toggleAll flips between all and none", () => {
    const all = allSelected(ids);
    expect(isAllSelected(all, ids)).toBe(true);
    const cleared = toggleAll(all, ids);
    expect(cleared.selected.size).toBe(0);
    const refilled = toggleAll(cleared, ids);
    expect(isAllSelected(refilled, ids)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/export/selection.test.ts 2>&1 | tail -15`
Expected: FAIL — cannot resolve `./selection`.

- [ ] **Step 3: Implement `selection.ts`**

Create `app/src/lib/export/selection.ts`:

```typescript
export interface SelState {
  selected: Set<string>;
  anchor: string | null;
}

export interface Mods {
  meta: boolean;  // Ctrl or Cmd
  shift: boolean;
}

export const allSelected = (ids: string[]): SelState => ({
  selected: new Set(ids),
  anchor: ids[ids.length - 1] ?? null,
});

export const noneSelected = (): SelState => ({ selected: new Set(), anchor: null });

export function click(state: SelState, ids: string[], id: string, mods: Mods): SelState {
  if (mods.shift && state.anchor !== null && ids.includes(state.anchor)) {
    const a = ids.indexOf(state.anchor);
    const b = ids.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return { selected: new Set(ids.slice(lo, hi + 1)), anchor: state.anchor };
  }
  if (mods.meta) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

export const isAllSelected = (state: SelState, ids: string[]): boolean =>
  ids.length > 0 && ids.every((i) => state.selected.has(i));

export const toggleAll = (state: SelState, ids: string[]): SelState =>
  isAllSelected(state, ids) ? noneSelected() : allSelected(ids);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/export/selection.test.ts 2>&1 | tail -15`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/export/selection.ts app/src/lib/export/selection.test.ts
git commit -m "feat(export): pure multi-select model (single/ctrl/shift/all)"
```

---

## Task 5: Output filename mapping (`naming.ts`)

**Files:**
- Create: `app/src/lib/export/naming.ts`
- Test: `app/src/lib/export/naming.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/export/naming.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extFor, outName } from "./naming";

describe("export naming", () => {
  it("maps format kind to extension", () => {
    expect(extFor("jpeg")).toBe("jpg");
    expect(extFor("tiff")).toBe("tiff");
    expect(extFor("png")).toBe("png");
  });

  it("replaces the original extension with the format extension", () => {
    expect(outName("photo.dng", "jpeg")).toBe("photo.jpg");
    expect(outName("photo.RAF", "tiff")).toBe("photo.tiff");
    expect(outName("scan.tif", "png")).toBe("scan.png");
  });

  it("preserves dotted stems and handles no extension", () => {
    expect(outName("a.b.dng", "jpeg")).toBe("a.b.jpg");
    expect(outName("noext", "png")).toBe("noext.png");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/export/naming.test.ts 2>&1 | tail -15`
Expected: FAIL — cannot resolve `./naming`.

- [ ] **Step 3: Implement `naming.ts`**

Create `app/src/lib/export/naming.ts`:

```typescript
import type { ExportFormat } from "../api";

export function extFor(kind: ExportFormat["kind"]): string {
  switch (kind) {
    case "jpeg": return "jpg";
    case "tiff": return "tiff";
    case "png": return "png";
  }
}

/** Map an original filename to `<stem>.<ext>` for the chosen format. */
export function outName(fileName: string, kind: ExportFormat["kind"]): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${extFor(kind)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/export/naming.test.ts 2>&1 | tail -15`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/export/naming.ts app/src/lib/export/naming.test.ts
git commit -m "feat(export): output filename mapping (stem + format ext)"
```

---

## Task 6: `developedImages` / `hasDeveloped` derived stores

**Files:**
- Modify: `app/src/lib/store.ts`

- [ ] **Step 1: Add the derived stores**

In `app/src/lib/store.ts`, just after the existing `allDeveloped` derived store, add:

```typescript
/** Images that have been developed (the only ones eligible for export). */
export const developedImages = derived(images, ($i) => $i.filter((x) => x.developed));
/** True when at least one image is developed. */
export const hasDeveloped = derived(images, ($i) => $i.some((x) => x.developed));
```

- [ ] **Step 2: Verify it compiles**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/store.ts
git commit -m "feat(export): add developedImages/hasDeveloped derived stores"
```

---

## Task 7: `ExportModal.svelte`

**Files:**
- Create: `app/src/lib/export/ExportModal.svelte`

This component depends on Tasks 3–6 (api `exportImage`+`ExportFormat`, `selection.ts`, `naming.ts`, `developedImages`). It uses the existing per-image stores `editsById`, `cropById`, `dustById`, and `defaultParams`/`emptyDust` helpers.

- [ ] **Step 1: Create the component**

Create `app/src/lib/export/ExportModal.svelte`:

```svelte
<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { join } from "@tauri-apps/api/path";
  import { developedImages, editsById, cropById, dustById } from "../store";
  import { defaultParams, type ExportFormat } from "../api";
  import { api } from "../api";
  import { emptyDust } from "../develop/dust";
  import { allSelected, click, isAllSelected, toggleAll, type SelState } from "./selection";
  import { outName } from "./naming";

  const dispatch = createEventDispatcher<{ close: void }>();

  $: imgs = $developedImages;
  $: ids = imgs.map((i) => i.id);

  let sel: SelState = allSelected(ids);
  let initialized = false;
  // Initialize selection once images are known (all selected by default).
  $: if (!initialized && ids.length > 0) { sel = allSelected(ids); initialized = true; }

  function onItemClick(e: MouseEvent, id: string) {
    sel = click(sel, ids, id, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
  }
  $: allOn = isAllSelected(sel, ids);

  // ---- Format panel state ----
  let kind: ExportFormat["kind"] = "jpeg";
  let bitDepth: 8 | 16 = 16;
  let quality = 90;
  let maxMb = 0; // 0 = unlimited

  $: format = {
    kind,
    bitDepth: kind === "jpeg" ? undefined : bitDepth,
    quality: kind === "jpeg" ? quality : undefined,
    maxBytes: kind === "jpeg" && maxMb > 0 ? Math.round(maxMb * 1024 * 1024) : null,
  } as ExportFormat;

  // ---- Export run state ----
  let running = false;
  let done = 0;
  let total = 0;
  let summary = "";

  async function runExport() {
    const chosen = imgs.filter((i) => sel.selected.has(i.id));
    if (chosen.length === 0) return;
    const folder = await open({ directory: true });
    if (!folder || typeof folder !== "string") return;

    running = true; done = 0; total = chosen.length; summary = "";
    const failures: string[] = [];
    for (const img of chosen) {
      try {
        const p = $editsById[img.id] ?? defaultParams();
        const crop = $cropById[img.id] ?? null;
        const imageCrop = crop
          ? ([crop.rect.x, crop.rect.y, crop.rect.w, crop.rect.h] as [number, number, number, number])
          : null;
        const geom = crop
          ? { rot90: crop.rot90, flip_h: crop.flipH, flip_v: crop.flipV, angle: crop.angle }
          : {};
        const d = $dustById[img.id] ?? emptyDust();
        const outPath = await join(folder, outName(img.file_name, kind));
        await api.exportImage(img.id, p, outPath, imageCrop, geom, d.strokes, d.irRemoval, format);
        done++;
      } catch (e) {
        failures.push(`${img.file_name}: ${e}`);
      }
    }
    running = false;
    summary = failures.length
      ? `Exported ${done}/${total}. Failed: ${failures.join("; ")}`
      : `Exported ${done}/${total} ✓`;
  }
</script>

<div class="backdrop" on:click|self={() => dispatch("close")}>
  <div class="modal">
    <header>
      <h2>Export</h2>
      <button class="x" on:click={() => dispatch("close")}>✕</button>
    </header>

    <div class="bar">
      <button class="link" on:click={() => (sel = toggleAll(sel, ids))}>
        {allOn ? "Deselect all" : "Select all"}
      </button>
      <span class="count">{sel.selected.size} / {ids.length} selected</span>
    </div>

    <div class="grid">
      {#each imgs as img (img.id)}
        <button
          class="cell"
          class:on={sel.selected.has(img.id)}
          on:click={(e) => onItemClick(e, img.id)}
        >
          <img src={img.thumbnail} alt={img.file_name} draggable="false" />
          <span class="name">{img.file_name}</span>
          {#if sel.selected.has(img.id)}<span class="check">✓</span>{/if}
        </button>
      {/each}
      {#if imgs.length === 0}<div class="empty">No developed images to export.</div>{/if}
    </div>

    <div class="format">
      <label>Format
        <select bind:value={kind}>
          <option value="jpeg">JPEG</option>
          <option value="tiff">TIFF</option>
          <option value="png">PNG</option>
        </select>
      </label>

      {#if kind === "jpeg"}
        <label>Quality {quality}
          <input type="range" min="1" max="100" bind:value={quality} />
        </label>
        <label>Max size {maxMb === 0 ? "Unlimited" : `${maxMb} MB`}
          <input type="range" min="0" max="20" step="0.5" bind:value={maxMb} />
        </label>
      {:else}
        <label>Bit depth
          <select bind:value={bitDepth}>
            <option value={8}>8-bit</option>
            <option value={16}>16-bit</option>
          </select>
        </label>
      {/if}
    </div>

    <footer>
      {#if running}<span class="msg">Exporting {done}/{total}…</span>
      {:else if summary}<span class="msg">{summary}</span>{/if}
      <button class="primary" on:click={runExport} disabled={running || sel.selected.size === 0}>
        {running ? "Exporting…" : `Export ${sel.selected.size}`}
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    display: grid; place-items: center; z-index: 50; }
  .modal { width: min(880px, 92vw); max-height: 88vh; display: flex; flex-direction: column;
    background: var(--glass-bg, #1b1b1e); border: 1px solid var(--glass-brd, #333);
    border-radius: 14px; padding: 16px; gap: 12px; }
  header { display: flex; align-items: center; justify-content: space-between; }
  header h2 { margin: 0; font-size: 16px; }
  .x { background: transparent; border: 0; color: var(--text-dim); cursor: pointer; font-size: 14px; }
  .bar { display: flex; align-items: center; gap: 14px; }
  .link { background: transparent; border: 0; color: var(--accent); cursor: pointer; padding: 0; }
  .count { color: var(--text-dim); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px; overflow-y: auto; padding: 4px; min-height: 120px; }
  .cell { position: relative; border: 2px solid transparent; border-radius: 10px;
    background: #0000; padding: 4px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .cell.on { border-color: var(--accent); background: rgba(224,52,52,0.12); }
  .cell img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 6px; background: #000; }
  .name { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .check { position: absolute; top: 6px; right: 6px; background: var(--accent); color: #fff;
    width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; }
  .empty { grid-column: 1 / -1; color: var(--text-dim); place-self: center; padding: 24px; }
  .format { display: flex; flex-wrap: wrap; gap: 16px; align-items: center;
    border-top: 1px solid var(--glass-brd, #333); padding-top: 12px; }
  .format label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); }
  footer { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
  .msg { color: var(--text-dim); font-size: 12px; margin-right: auto; }
  .primary { padding: 9px 16px; border: 0; border-radius: 10px; background: var(--accent);
    color: #fff; font-weight: 600; cursor: pointer; }
  .primary:disabled { opacity: 0.5; cursor: default; }
</style>
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: 0 errors. (If `CropRect` field names differ, confirm against `app/src/lib/crop/types.ts` — they are `rect`, `rot90`, `flipH`, `flipV`, `angle`.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/export/ExportModal.svelte
git commit -m "feat(export): ExportModal — picker, format panel, batch export loop"
```

---

## Task 8: Export nav button + mount modal in `+page.svelte`

**Files:**
- Modify: `app/src/routes/+page.svelte`

- [ ] **Step 1: Wire the nav button and modal**

In `app/src/routes/+page.svelte`, update the script imports. Change:

```svelte
  import { module, hasImages, allDeveloped, images, undevelopedCount } from "$lib/store";
  import { developAll, undevelopedIds } from "$lib/workflow";
  import Library from "$lib/tabs/Library.svelte";
  import Develop from "$lib/tabs/Develop.svelte";
  import ProgressOverlay from "$lib/overlay/ProgressOverlay.svelte";
  import ConfirmDevelop from "$lib/overlay/ConfirmDevelop.svelte";

  let confirmCount = 0;
  let confirming = false;
```

to:

```svelte
  import { module, hasImages, allDeveloped, images, undevelopedCount, hasDeveloped } from "$lib/store";
  import { developAll, undevelopedIds } from "$lib/workflow";
  import Library from "$lib/tabs/Library.svelte";
  import Develop from "$lib/tabs/Develop.svelte";
  import ProgressOverlay from "$lib/overlay/ProgressOverlay.svelte";
  import ConfirmDevelop from "$lib/overlay/ConfirmDevelop.svelte";
  import ExportModal from "$lib/export/ExportModal.svelte";

  let confirmCount = 0;
  let confirming = false;
  let exporting = false;
```

- [ ] **Step 2: Add the Export button to the nav**

In the `<nav class="tabs">` block, add an Export button right after the Develop button (after its closing `</button>`):

```svelte
      <button class="export-tab" disabled={!$hasDeveloped} on:click={() => (exporting = true)}>
        Export
      </button>
```

- [ ] **Step 3: Mount the modal**

After the `{#if confirming}…{/if}` block near the bottom, add:

```svelte
{#if exporting}
  <ExportModal on:close={() => (exporting = false)} />
{/if}
```

- [ ] **Step 4: Add a style for the export tab**

In the `<style>` block, after the `.tabs button:disabled` rule, add:

```css
  .export-tab { background: transparent; border: 0; padding: 6px 14px; border-radius: 8px; color: var(--text-dim); }
  .export-tab:not(:disabled) { color: var(--text); }
```

- [ ] **Step 5: Verify it type-checks and builds**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/+page.svelte
git commit -m "feat(export): Export nav button (right of Develop) opens the export modal"
```

---

## Task 9: Remove the old export button from `Develop.svelte`

**Files:**
- Modify: `app/src/lib/tabs/Develop.svelte`

- [ ] **Step 1: Remove the `save` import**

Delete this line (line 2):

```svelte
  import { save } from "@tauri-apps/plugin-dialog";
```

- [ ] **Step 2: Remove the export state and `exportTiff()`**

Delete the block (lines ~147-161):

```svelte
  let exporting = false, msg = "";
  async function exportTiff() {
    if (!$activeId) return;
    const out = await save({ defaultPath: "redroom-export.tiff", filters: [{ name: "TIFF", extensions: ["tiff"] }] });
    if (!out) return;
    exporting = true; msg = "";
    try {
      await api.exportImage($activeId, $params, out, imageCrop, {
        rot90: committed?.rot90 ?? 0, flip_h: committed?.flipH ?? false,
        flip_v: committed?.flipV ?? false, angle: committed?.angle ?? 0,
      }, dust.strokes, dust.irRemoval);
      msg = "Exported ✓";
    } catch (e) { msg = "Error: " + e; }
    exporting = false;
  }
```

- [ ] **Step 3: Remove the export button markup**

Delete this block from the template (lines ~199-202):

```svelte
      <button class="export" on:click={exportTiff} disabled={exporting || !$activeId}>
        {exporting ? "Exporting…" : "Export 16-bit TIFF"}
      </button>
      {#if msg}<div class="msg">{msg}</div>{/if}
```

- [ ] **Step 4: Remove the now-unused styles**

Delete these style rules (lines ~218-221):

```svelte
  .export { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 10px;
    background: var(--accent); color: white; font-weight: 600; cursor: pointer; }
  .export:disabled { opacity: 0.5; }
  .msg { margin-top: 8px; color: var(--text-dim); font-size: 12px; }
```

- [ ] **Step 5: Verify no unused-symbol errors**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -20`
Expected: 0 errors. (`api` is still used by `refreshThumb`; `$params`/`imageCrop`/`dust` remain used elsewhere in the component. If svelte-check flags an unused `api` or `save`, remove only the genuinely-unused import.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/tabs/Develop.svelte
git commit -m "refactor(develop): remove single-image TIFF export button (moved to Export modal)"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust suite**

Run: `source "$HOME/.cargo/env" && cargo test 2>&1 | tail -25`
Expected: film-core, src-tauri all PASS.

- [ ] **Step 2: Run clippy**

Run: `source "$HOME/.cargo/env" && cargo clippy 2>&1 | tail -15`
Expected: no warnings.

- [ ] **Step 3: Run the frontend tests + type check**

Run: `cd app && npx vitest run 2>&1 | tail -15 && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -10`
Expected: all vitest tests PASS (including new selection/naming suites); svelte-check 0 errors.

- [ ] **Step 4: Manual GUI smoke test (user)**

Launch the app (`/run` or the project's dev command). Verify:
- An **Export** button sits right of Develop in the top nav, disabled until ≥1 image is developed.
- Clicking it opens the modal with all developed images selected.
- Select/Deselect-all, single-click, Ctrl/⌘-click, and Shift-range selection all behave.
- Switching format to JPEG shows quality + max-size sliders; TIFF/PNG show the 8/16-bit dropdown.
- Export prompts for a folder and writes `<original-stem>.<ext>` files; spot-check a JPEG (with a small max-size cap), a 16-bit PNG, and a 16-bit TIFF open correctly and reflect each image's own edits.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(export): verification pass for batch export"
```

---

## Self-Review Notes

- **Spec coverage:** nav button right of Develop (T8), modal with all-selected-by-default (T7), select/deselect-all (T7 via `toggleAll`), single/ctrl/shift select (T4/T7), JPEG quality + independent max-size (T1 `write_jpeg`, T7 sliders), PNG/TIFF 8/16-bit dropdown (T1/T2/T7), only-developed images listed (T6 `developedImages`), folder picker + per-image edits applied (T7 loop), old button removed (T9). All covered.
- **Type consistency:** `ExportFormat` fields (`kind`/`bitDepth`/`quality`/`maxBytes`) match between `api.ts` (T3) and the Rust `ExportFormat` (`camelCase` rename, T2). `CropRect` fields used in T7 (`rect`/`rot90`/`flipH`/`flipV`/`angle`) match `crop/types.ts`. `outName`/`extFor` signatures match between T5 and T7. `selection.ts` exports match T4 tests and T7 usage.
- **Gamma:** all file encoders use `apply_gamma=false`, matching the existing TIFF/preview path so exports look identical to the develop preview.
