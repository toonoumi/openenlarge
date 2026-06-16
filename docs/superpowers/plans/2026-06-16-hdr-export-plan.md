# HDR Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Export emit a gain-map HDR JPEG for any image whose per-image HDR toggle is on (JPEG format only); everything else exports unchanged SDR.

**Architecture:** Reuse the proven `encode_hdr` dual-render pattern. Extract a shared `render_and_encode_hdr` helper (invert→dust→IR→finish twice, SDR + HDR, then `encode_gain_map_jpeg`), used by both the existing preview command and a new `export_image_hdr` command. `export_image_hdr` mirrors `export_image`'s full-res decode/geometry path. The frontend export loop calls the HDR command when an image is JPEG + HDR-on; all other paths are untouched.

**Tech Stack:** Rust (Tauri commands, `film-core`, `ultrahdr` crate via `app/src-tauri/src/hdr.rs`, `little_exif` via `exif_write.rs`), TypeScript/Svelte (`api.ts`, `ExportModal.svelte`), `cargo test`, `vitest`.

**Process constraints (read before committing):**
- A second Claude session commits to `main` in parallel. **Always `git add <explicit paths>` then `git commit -m "..." -- <explicit paths>`. NEVER `git add -A`.** Note: `-m` must come *before* `--` in `git commit`.
- No new user-facing strings → no `i18n-strings.csv` changes.

---

### Task 1: De-risk — confirm EXIF embedding survives the gain map

The new risk is whether `little_exif`'s `write_to_file` (used by `write_exif`) preserves the gain-map structure (APP2/MPF + the appended secondary image). Settle this with a test **before** building the command, because the outcome decides whether Task 4 writes EXIF the simple way (after encode) or needs the Task 1b fallback.

**Files:**
- Test: `app/src-tauri/src/hdr.rs` (the existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Add the failing test**

In `app/src-tauri/src/hdr.rs`, inside `mod tests`, after `encode_gain_map_jpeg_emits_a_gain_map`, add:

```rust
    #[test]
    fn exif_embedding_preserves_gain_map() {
        use crate::metadata::Metadata;
        let sdr = solid(64, 64, [0.9, 0.9, 0.9]);
        let hdr = solid(64, 64, [1.8, 1.8, 1.8]);
        let bytes = encode_gain_map_jpeg(&sdr, &hdr, 90).expect("encode");

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hdr.jpg");
        std::fs::write(&path, &bytes).expect("write jpeg");

        let meta = Metadata {
            camera: Some("TestCam".into()),
            note: Some("hello hdr".into()),
            ..Default::default()
        };
        crate::exif_write::write_exif(&path, &meta).expect("exif embed");

        let after = std::fs::read(&path).expect("read back");
        assert!(
            after.windows(4).any(|w| w == b"Exif"),
            "EXIF marker missing after embed"
        );
        let iso = b"urn:iso";
        let apple = b"hdrgainmap";
        let has_gm = after.windows(iso.len()).any(|w| w == iso)
            || after.windows(apple.len()).any(|w| w == apple);
        assert!(has_gm, "gain-map metadata lost after EXIF embed");
    }
```

- [ ] **Step 2: Run the test**

Run: `cd app/src-tauri && cargo test --lib hdr::tests::exif_embedding_preserves_gain_map -- --nocapture`

- [ ] **Step 3: Branch on the result**

- **If it PASSES:** EXIF-after-encode is safe. Task 4 calls `write_exif` after writing the gain-map bytes (already specified there). **Skip Task 1b.** Commit this test.
- **If it FAILS** (gain map lost): keep the test (it documents the requirement) but mark it `#[ignore]` with a comment pointing at Task 1b, then do **Task 1b**, which makes the test pass via the compressed-base path. Do not commit a red test — either it passes, or it is `#[ignore]`d pending Task 1b which then un-ignores it.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/hdr.rs
git commit -m "test(hdr): assert EXIF embedding preserves the gain map" -- app/src-tauri/src/hdr.rs
```

---

### Task 1b: (CONDITIONAL — only if Task 1's test failed) EXIF via compressed SDR base

If `write_exif` strips the gain map, embed EXIF into the SDR base *before* muxing, by handing libultrahdr a pre-compressed SDR JPEG (which already carries EXIF) via `set_compressed_image`, instead of the raw SDR.

**Files:**
- Modify: `app/src-tauri/src/hdr.rs`

- [ ] **Step 1: Add an EXIF-aware encoder variant**

In `app/src-tauri/src/hdr.rs`, add a public function that takes the SDR base as already-encoded JPEG bytes (EXIF already embedded by the caller) plus the raw HDR rendition:

```rust
use ultrahdr::CompressedImage;

/// Like [`encode_gain_map_jpeg`], but the SDR base is supplied as a finished JPEG
/// (`sdr_jpeg`, which already carries any EXIF). Used when post-hoc EXIF writing
/// would corrupt the muxed gain-map structure: the EXIF rides in the base JPEG,
/// which libultrahdr keeps as the primary image.
pub fn encode_gain_map_jpeg_from_base(
    sdr_jpeg: &[u8],
    hdr: &film_core::Image,
    quality: u8,
) -> Result<Vec<u8>, String> {
    if hdr.width == 0 || hdr.height == 0 {
        return Err("hdr image has zero dimension".into());
    }
    let mut enc = Encoder::new().map_err(|e| format!("encoder: {e:?}"))?;

    let mut base = sdr_jpeg.to_vec();
    let mut comp = CompressedImage::from_bytes(
        &mut base,
        ColorGamut::UHDR_CG_BT_709,
        ColorTransfer::UHDR_CT_SRGB,
        ColorRange::UHDR_CR_FULL_RANGE,
    );
    enc.set_compressed_image(&mut comp, ImgLabel::UHDR_SDR_IMG)
        .map_err(|e| format!("set sdr base: {e:?}"))?;

    // HDR rendition: linearized half-float, exactly as encode_gain_map_jpeg does.
    // (Factor the existing HDR-plane construction in encode_gain_map_jpeg into a
    //  helper `hdr_owned_image(hdr) -> Result<OwnedPackedImage>` and call it here
    //  AND there, to stay DRY.)
    let mut hdr_img = hdr_owned_image(hdr)?;
    enc.set_raw_owned_image(&mut hdr_img, ImgLabel::UHDR_HDR_IMG)
        .map_err(|e| format!("set hdr image: {e:?}"))?;
    enc.set_quality(quality as i32, ImgLabel::UHDR_SDR_IMG)
        .map_err(|e| format!("set quality: {e:?}"))?;

    enc.encode().map_err(|e| format!("encode: {e:?}"))?;
    let stream = enc.encoded_stream().ok_or("no encoded stream")?;
    Ok(stream.bytes().to_vec())
}
```

Extract the HDR-plane build already present in `encode_gain_map_jpeg` into `fn hdr_owned_image(hdr: &film_core::Image) -> Result<OwnedPackedImage, String>` and call it from both functions (DRY). Verify the exact method names (`set_raw_owned_image`, `set_quality`, `encoded_stream().bytes()`) against the current `encode_gain_map_jpeg` body and match them.

- [ ] **Step 2: Point the survival test at the new path**

Replace the body of `exif_embedding_preserves_gain_map` so it (a) renders SDR to a JPEG, (b) embeds EXIF on that JPEG via a temp file + `write_exif`, (c) calls `encode_gain_map_jpeg_from_base`, (d) asserts both `b"Exif"` and a gain-map marker are present in the returned bytes. Remove the `#[ignore]`.

```rust
    #[test]
    fn exif_embedding_preserves_gain_map() {
        use crate::metadata::Metadata;
        // SDR base as a JPEG carrying EXIF.
        let sdr = solid(64, 64, [0.9, 0.9, 0.9]);
        let dir = tempfile::tempdir().expect("tempdir");
        let base_path = dir.path().join("base.jpg");
        film_core::export::write_jpeg_file(&sdr, &base_path, 90).expect("sdr jpeg");
        let meta = Metadata { camera: Some("TestCam".into()), note: Some("hi".into()), ..Default::default() };
        crate::exif_write::write_exif(&base_path, &meta).expect("exif");
        let base = std::fs::read(&base_path).expect("read base");

        let hdr = solid(64, 64, [1.8, 1.8, 1.8]);
        let out = encode_gain_map_jpeg_from_base(&base, &hdr, 90).expect("encode");

        assert!(out.windows(4).any(|w| w == b"Exif"), "EXIF lost");
        let iso = b"urn:iso"; let apple = b"hdrgainmap";
        assert!(
            out.windows(iso.len()).any(|w| w == iso) || out.windows(apple.len()).any(|w| w == apple),
            "no gain map"
        );
    }
```

Note: confirm the exact in-crate JPEG-to-file helper name (`film_core::export::write_jpeg_file` or the app's `write_jpeg` in `encode.rs`); use whichever exists and writes a `.jpg` to a path at a given quality. If only an app-level `write_jpeg(&Image, &Path, quality, max_bytes)` exists, call that with `max_bytes = None`.

- [ ] **Step 3: Run the test**

Run: `cd app/src-tauri && cargo test --lib hdr::tests::exif_embedding_preserves_gain_map`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/hdr.rs
git commit -m "feat(hdr): EXIF-preserving gain-map encode via compressed base" -- app/src-tauri/src/hdr.rs
```

---

### Task 2: Shared `render_and_encode_hdr` helper (+ test, + DRY refactor of encode_hdr)

Extract the dual-render-and-encode core so both the preview command and the export command share one tested unit.

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add helper near `encode_hdr`; refactor `encode_hdr` to call it; add a unit test in `mod tests`)

- [ ] **Step 1: Write the failing test**

In `app/src-tauri/src/commands.rs`, inside `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn render_and_encode_hdr_emits_gain_map() {
        use crate::commands_test_support::sample_invert_params;
        // Tiny synthetic negative-ish source.
        let src = film_core::Image {
            width: 8,
            height: 8,
            pixels: vec![[0.6, 0.4, 0.25]; 64],
            ir: None,
        };
        let params = sample_invert_params();
        let ip = resolve_params(&params, &src, effective_base(&params, [0.6, 0.4, 0.25]));
        let finish = finish_from(&params);
        let bytes = render_and_encode_hdr(
            &src,
            &ip,
            mode_from(&params.mode),
            &finish,
            &[],
            &IrRemoval { enabled: false, sensitivity: 50 },
            90,
        )
        .expect("encode");
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "not a JPEG");
        let iso = b"urn:iso";
        let apple = b"hdrgainmap";
        assert!(
            bytes.windows(iso.len()).any(|w| w == iso)
                || bytes.windows(apple.len()).any(|w| w == apple),
            "no gain map"
        );
    }
```

Verify against the real signatures while writing: `resolve_params(&InvertParams, &Image, [f32;3]) -> InversionParams`, `effective_base(&InvertParams, [f32;3]) -> [f32;3]`, `finish_from(&InvertParams) -> FinishParams`, `mode_from(&str) -> Mode`, and `IrRemoval { enabled, sensitivity }`. Adjust the `effective_base`/`resolve_params` argument shapes if they differ (grep their definitions first).

- [ ] **Step 2: Run to confirm it fails**

Run: `cd app/src-tauri && cargo test --lib render_and_encode_hdr_emits_gain_map`
Expected: FAIL — `render_and_encode_hdr` not found.

- [ ] **Step 3: Add the helper**

In `app/src-tauri/src/commands.rs`, just above `pub fn encode_hdr(`, add:

```rust
/// Dual-render one prepared image (invert → dust → IR → finish) as SDR and HDR,
/// then mux into a gain-map JPEG. Shared by the HDR preview command and HDR export.
/// `src` carries the optional IR plane used when `ir_removal.enabled`.
fn render_and_encode_hdr(
    src: &film_core::Image,
    ip: &InversionParams,
    mode: Mode,
    finish: &FinishParams,
    stamps: &[Stamp],
    ir_removal: &IrRemoval,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let render = |ip: &InversionParams| -> film_core::Image {
        let mut inv = invert_image(src, ip, mode);
        dust::apply(&mut inv, stamps);
        if ir_removal.enabled {
            if let Some(ir) = src.ir.as_ref() {
                dust::apply_ir(&mut inv, ir, ir_removal.sensitivity);
            }
        }
        finish_image(&inv, finish)
    };
    let sdr = render(ip);
    let mut ip_hdr = ip.clone();
    ip_hdr.hdr = true;
    let hdr = render(&ip_hdr);
    crate::hdr::encode_gain_map_jpeg(&sdr, &hdr, quality)
}
```

Ensure `Mode`, `FinishParams`, `Stamp`, `IrRemoval`, `invert_image`, `finish_image`, `dust` are already in scope in this file (they are used by `encode_hdr`/`export_image`); add `use` only if the compiler complains.

- [ ] **Step 4: Refactor `encode_hdr` to use the helper**

In `encode_hdr`, replace the inline `let render = …; let sdr = render(&ip); let mut ip_hdr = …; let hdr = render(&ip_hdr); let jpeg = crate::hdr::encode_gain_map_jpeg(&sdr, &hdr, PREVIEW_JPEG_QUALITY)?;` block with:

```rust
    let jpeg = render_and_encode_hdr(&scaled, &ip, mode, &finish, &stamps, &view.ir_removal, PREVIEW_JPEG_QUALITY)?;
```

Keep the existing `ip`, `mode`, `finish`, `stamps` bindings above it; delete the now-unused inline closure. The base64 wrap below stays.

- [ ] **Step 5: Run tests**

Run: `cd app/src-tauri && cargo test --lib render_and_encode_hdr_emits_gain_map && cargo build`
Expected: test PASS; build OK (no new warnings beyond the known set).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs
git commit -m "refactor(hdr): shared render_and_encode_hdr helper for preview+export" -- app/src-tauri/src/commands.rs
```

---

### Task 3: `export_image_hdr` backend command

Full-res CPU dual-render export that writes a gain-map JPEG, mirroring `export_image`'s decode/geometry path.

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add command after `export_image`)
- Modify: `app/src-tauri/src/lib.rs` (register in the `tauri::generate_handler!` list)

- [ ] **Step 1: Add the command**

In `app/src-tauri/src/commands.rs`, immediately after `export_image`'s closing brace, add:

```rust
/// Export a single developed image as a gain-map HDR JPEG. Mirrors `export_image`
/// (decode full-res → orient/rotate/crop → invert+dust+IR+finish) but renders the
/// SDR base and the HDR rendition and muxes them. JPEG-only by construction; the
/// frontend only calls this when the chosen format is JPEG and the image's HDR
/// toggle is on. `format.quality` drives JPEG quality; `format.max_bytes` is not
/// applied (the gain-map encoder has no size target).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn export_image_hdr(
    id: String,
    params: InvertParams,
    out_path: String,
    image_crop: Option<[f64; 4]>,
    rot90: u8,
    flip_h: bool,
    flip_v: bool,
    angle: f32,
    dust: Vec<DustStroke>,
    ir_removal: IrRemoval,
    format: ExportFormat,
    meta_override: Option<MetaOverride>,
    session: State<Session>,
) -> Result<(), String> {
    ensure_resident(&session, &id)?;
    let (path, base, thumb, metadata, dev_dmax) = {
        let images = session.images.lock().unwrap();
        let img = images.get(&id).ok_or("unknown image id")?;
        let dev = img.developed.as_ref().ok_or("not developed")?;
        (
            img.path.clone(),
            dev.base,
            dev.thumb.clone(),
            img.metadata.clone(),
            dev.d_max,
        )
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

    let mut ip = resolve_params(&params, &thumb, effective_base(&params, base));
    ip.d_max = effective_dmax(&params, dev_dmax);
    // export_stamps maps normalized strokes onto full-res pixels (same as export_image).
    let stamps = export_stamps(&dust, full.width, full.height);
    let finish = finish_from(&params);

    let bytes = render_and_encode_hdr(
        &full,
        &ip,
        mode_from(&params.mode),
        &finish,
        &stamps,
        &ir_removal,
        format.quality,
    )?;

    std::fs::write(&out_path, &bytes).map_err(|e| format!("write {out_path}: {e}"))?;

    // Best-effort EXIF embed, identical policy to export_image (never fails export).
    let eff = effective_metadata(&metadata, meta_override.as_ref());
    if let Err(e) = crate::exif_write::write_exif(Path::new(&out_path), &eff) {
        eprintln!("[exif] embed failed for {out_path}: {e}");
    }
    Ok(())
}
```

Notes:
- `export_stamps(&dust, w, h)` returns `Vec<Stamp>` and is already used by `export_image` — confirm its argument order (`dust, width, height`) and that it operates on the *post-crop* dims (match exactly what `export_image` passes; `export_image` builds stamps from `inv.width/inv.height` after invert, but invert preserves dims, so `full.width/full.height` here are equivalent — verify by reading `export_image` lines ~990-991 and mirror its exact source dims).
- **If Task 1b was needed** (EXIF strips the gain map): replace the `render_and_encode_hdr(...)` + `std::fs::write` + `write_exif` tail with: render SDR+HDR via a variant that returns the two Images, write the SDR to a temp `.jpg`, `write_exif` it, read bytes, call `crate::hdr::encode_gain_map_jpeg_from_base(&sdr_jpeg, &hdr, format.quality)`, then write the result — i.e. EXIF goes into the base before muxing, and the post-write `write_exif` is dropped. (Add a sibling helper `render_hdr_pair(...) -> (Image, Image)` if you go this route, and have `render_and_encode_hdr` call it to stay DRY.)

- [ ] **Step 2: Register the command**

In `app/src-tauri/src/lib.rs`, in the `tauri::generate_handler!` list, add `commands::export_image_hdr,` adjacent to `commands::export_image,` (line ~63).

- [ ] **Step 3: Build**

Run: `cd app/src-tauri && cargo build`
Expected: 0 errors; only the known pre-existing warnings.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(hdr): export_image_hdr command (gain-map JPEG export)" -- app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
```

---

### Task 4: `exportImageHdr` API binding

**Files:**
- Modify: `app/src/lib/api.ts` (add binding mirroring `exportImage`)

- [ ] **Step 1: Add the binding**

In `app/src/lib/api.ts`, immediately after the `exportImage` entry (ends ~line 167), add:

```typescript
  exportImageHdr: (
    id: string, params: InvertParams, outPath: string,
    imageCrop: [number, number, number, number] | null = null,
    geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {},
    dust: DustStroke[] = [],
    irRemoval: IrRemoval = { enabled: false, sensitivity: 50 },
    format: ExportFormat = { kind: "jpeg", quality: 90 },
    metaOverride: MetaOverride | null = null,
  ) =>
    invoke<void>("export_image_hdr", {
      id, params, outPath, imageCrop,
      rot90: geom.rot90 ?? 0, flipH: geom.flip_h ?? false,
      flipV: geom.flip_v ?? false, angle: geom.angle ?? 0,
      dust: wireDust(dust), irRemoval, format, metaOverride,
    }),
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5`
Expected: 0 errors (warnings unchanged).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/api.ts
git commit -m "feat(hdr): exportImageHdr API binding" -- app/src/lib/api.ts
```

---

### Task 5: Wire HDR export into the Export modal

A pure `wantsHdrExport(kind, params)` helper (testable), then branch the export loop on it.

**Files:**
- Create: `app/src/lib/export/hdrExport.ts`
- Test: `app/src/lib/export/hdrExport.test.ts`
- Modify: `app/src/lib/export/ExportModal.svelte` (the per-image loop in `runExport`)

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/export/hdrExport.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { wantsHdrExport } from "./hdrExport";

describe("wantsHdrExport", () => {
  it("true only for jpeg + hdr-on", () => {
    expect(wantsHdrExport("jpeg", { hdr: true } as any)).toBe(true);
  });
  it("false for jpeg + hdr-off", () => {
    expect(wantsHdrExport("jpeg", { hdr: false } as any)).toBe(false);
  });
  it("false for tiff/png even with hdr on", () => {
    expect(wantsHdrExport("tiff", { hdr: true } as any)).toBe(false);
    expect(wantsHdrExport("png", { hdr: true } as any)).toBe(false);
  });
  it("false when hdr is undefined (old params)", () => {
    expect(wantsHdrExport("jpeg", {} as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd app && npx vitest run src/lib/export/hdrExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `app/src/lib/export/hdrExport.ts`:

```typescript
import type { ExportFormat, InvertParams } from "../api";

/** Gain-map HDR export applies only to JPEG output for HDR-toggled images. */
export function wantsHdrExport(kind: ExportFormat["kind"], params: InvertParams): boolean {
  return kind === "jpeg" && params.hdr === true;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd app && npx vitest run src/lib/export/hdrExport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Branch the export loop**

In `app/src/lib/export/ExportModal.svelte`:

5a. Add the import near the other export-helper imports (after line 24's `batchCrop` import):

```typescript
  import { wantsHdrExport } from "./hdrExport";
```

5b. In `runExport`, inside the `for (const img of chosen)` loop, after `p` is computed (`const p = withEffectiveBase(...)`, ~line 187) and before the `let exported = false;` GPU block, add an early HDR branch:

```typescript
        if (wantsHdrExport(kind, p)) {
          // HDR gain-map JPEG: backend CPU dual-render. Skips the GPU/SDR path.
          await api.exportImageHdr(img.id, p, outPath, imageCrop, geom, d.strokes, d.irRemoval, format, metaOverride);
          written.push(outPath);
          done++;
          continue;
        }
```

`geom`, `imageCrop`, `outPath`, `d`, `metaOverride` are all already defined above this point in the loop — confirm by reading lines 185-200; do not recompute them.

- [ ] **Step 6: Typecheck + run the new test**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5 && npx vitest run src/lib/export/hdrExport.test.ts`
Expected: svelte-check 0 errors; vitest 4 passed.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/export/hdrExport.ts app/src/lib/export/hdrExport.test.ts app/src/lib/export/ExportModal.svelte
git commit -m "feat(hdr): route JPEG+HDR images to gain-map export in ExportModal" -- app/src/lib/export/hdrExport.ts app/src/lib/export/hdrExport.test.ts app/src/lib/export/ExportModal.svelte
```

---

### Task 6: Full verification sweep + manual smoke handoff

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `cargo test -p film-core && cd app/src-tauri && cargo test --lib`
Expected: film-core green; app lib green (includes the new `exif_embedding_preserves_gain_map` and `render_and_encode_hdr_emits_gain_map`).

- [ ] **Step 2: Backend build (warning check)**

Run: `cd app/src-tauri && cargo build 2>&1 | rg "warning|error" || echo "clean"`
Expected: only the known pre-existing warnings; no new ones.

- [ ] **Step 3: Frontend checks**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3 && npx vitest run`
Expected: 0 svelte-check errors; all vitest suites pass (incl. `hdrExport`).

- [ ] **Step 4: Manual smoke (real app — requires the user)**

Hand off to the user: `npm run tauri dev`, toggle HDR on an image, open Export, choose JPEG, export. Confirm: the exported `.jpg` shows HDR on an XDR display (e.g. Finder/Preview/Photos quick look glows brighter than white), and an HDR-off image in the same batch exports a normal SDR `.jpg`. Spot-check EXIF (e.g. `exiftool` or Get Info) shows the metadata if a meta-override was set.

- [ ] **Step 5: Final whole-feature review**

Dispatch a code reviewer over the Task 1–5 commits for end-to-end coherence (the gain-map color chain is already reviewed in sub-project 1; focus here on the export wiring, EXIF handling, and the SDR/HDR-branch correctness in the modal).

---

## Self-Review (completed by plan author)

- **Spec coverage:** §2 trigger/scope → Task 5 (`wantsHdrExport`); §3 architecture (CPU dual-render, shared helper, command, frontend branch, API) → Tasks 2,3,4,5; §4 EXIF + survival test + fallback → Tasks 1,1b,3; §5 edge cases (TIFF/PNG silently SDR via the helper; encoder failure caught by existing try/catch; max_bytes unused, documented in the command doc-comment) → Tasks 3,5; §6 testing → Tasks 1,2,5,6. All sections mapped.
- **Placeholder scan:** none — every code step has complete code; conditional Task 1b is fully specified, not deferred.
- **Type consistency:** `render_and_encode_hdr(src, ip, mode, finish, stamps, ir_removal, quality)` used identically in Tasks 2 and 3; `wantsHdrExport(kind, params)` identical in Tasks 5's test and impl; `exportImageHdr` argument shape matches `export_image_hdr`'s command params and mirrors `exportImage`. Engineer is instructed to verify `export_stamps`/`resolve_params`/`effective_base` arg shapes against the source before relying on the sample test code.
