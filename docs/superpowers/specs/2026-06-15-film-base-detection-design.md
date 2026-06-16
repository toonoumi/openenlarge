# Film-Base Auto-Detection — Design Spec

**Date:** 2026-06-15
**Status:** agreed design, ready for implementation plan
**Roadmap position:** #2 of the user's order — WB → **film base** → performance → UX. (WB / two-layer rebuild is deferred to after this; see `2026-06-15-golden-path-inversion-spec.md` Plan 3.)

---

## 1. Problem

The Cineon inversion needs a film-base (orange-mask Dmin) per image. Today `develop_heavy` samples it with `sample_base_coherent(&working, None, BASE_BAND_AUTO)` — the **brightest luminance cluster anywhere in the frame**. That is a naive per-image guess:

- On most frames the brightest cluster happens to be the clear-film rebate, so the base is a plausible orange (e.g. Image 4 → `[0.42, 0.19, 0.10]`). Good.
- On scenes with large bright non-orange areas it grabs the wrong thing: the "Phoenix" frame (`Image 1 (2)`) returns `[0.30, 0.21, 0.36]` (blue-dominant), because the bright cream ceiling outscored the rebate. The image then inverts super-orange and the user manually re-points the film-base edge.

The folders mix two rolls, so a single per-roll base is wrong; NLP "just works" because it effectively determines the base per strip. **Goal: a smarter per-image base that keys on the actual rebate, so mixed rolls self-resolve, with a graceful fallback when a frame has no usable rebate.**

Observed facts (from raw dumps of the scans): the clear-film **rebate is a strip at the frame edge** (Image 4's is mainly the top edge); it is brighter, more uniform, and more saturated-orange than scene content. Rebate is present on **most** frames but occasionally a frame is scanned/cropped tight with little/no rebate (user answer: "B").

## 2. Approach (chosen: Approach 1 — border-band scan)

Detect the rebate as the **brightest × most-uniform × most-orange patch within the outer edge bands**, sample a coherent base there, and emit a confidence. Above a threshold → use it; below → fall back to today's brightest-cluster guess (option A). Per-image only — **no automatic roll propagation** (mixed rolls).

(Rejected: whole-image patch search — drops the structural edge prior and can false-positive on uniform orange scene objects. Geometric frame segmentation — more robust but a much larger project; revisit later if border-scan proves too limited.)

## 3. Detector (film-core, `crates/film-core/src/calibrate.rs`)

```rust
/// Result of rebate detection: the sampled clear-film base and a 0..1 confidence.
pub struct RebateBase {
    pub base: [f32; 3],
    pub confidence: f32,
}

/// Detect the C-41 orange-mask film base from the frame's edge bands. Scans the
/// outer ~10% of each edge, scores tiled patches by brightness × uniformity ×
/// orange-ness, and returns the best patch's coherent mean as `base` with its
/// score as `confidence`. Built for negatives whose rebate touches an edge.
pub fn detect_rebate_base(img: &Image) -> RebateBase
```

Algorithm:
1. **Downscale** the input to ~512px long edge (cheap, stabilizes patch stats). Reuse the example harness's nearest-neighbour downscale pattern.
2. **Edge bands:** for each of the 4 edges take the outer `BAND_FRAC = 0.10` of the perpendicular dimension (top/bottom = full width × 0.10·H; left/right = 0.10·W × full height).
3. **Tile** each band into patches (~`PATCH = 16`px square, stride = PATCH). For each patch compute mean RGB and per-channel std-dev.
4. **Score** each patch (each sub-score clamped to 0..1; final = product so all three must hold):
   - `bright` = mean luma `(R+G+B)/3`.
   - `uniform` = `(1 - UNIF_K * cv).clamp(0,1)` where `cv = mean(stddev)/mean(luma)` (coefficient of variation; flat rebate → low cv → high uniform). `UNIF_K` tuned (~4).
   - `orange` = mask-likeness: `0` unless `R ≥ G ≥ B`; otherwise `((R - B) / max(R, eps)).clamp(0,1)` (clear C-41 mask is strongly R>B). Optionally gate that G sits between B and R.
   - `score = bright * uniform * orange`.
5. **Best patch** = max score across all bands. `base` = the winning patch's mean RGB (the patch is uniform by construction, so a plain mean is stable; no extra trimming needed). `confidence = best_score`.
6. Empty/degenerate input → `RebateBase { base: [0,0,0], confidence: 0.0 }`.

Constants (`BAND_FRAC`, `PATCH`, `UNIF_K`, and the develop threshold `REBATE_CONFIDENCE`) are **tuned empirically** against the 4 representative DNGs via the validation harness (§6), not guessed once.

## 4. Develop integration + fallback (backend)

`app/src-tauri/src/commands.rs` `develop_heavy` (currently samples base at ~`commands.rs:459-460`):
```rust
let det = film_core::calibrate::detect_rebate_base(&working);
let (base, base_confidence) = if det.confidence >= REBATE_CONFIDENCE {
    (det.base, det.confidence)
} else {
    // Fallback A: today's brightest-cluster guess; keep the low confidence.
    let (blo, bhi) = film_core::calibrate::BASE_BAND_AUTO;
    (film_core::calibrate::sample_base_coherent(&working, None, blo, bhi), det.confidence)
};
```
- `session.rs` `Developed { working, thumb, base }` gains `base_confidence: f32`.
- **No cache-format change:** `base_confidence` is recomputed cheaply in `ensure_resident` after cache-rehydrate by re-running `detect_rebate_base(&working)` (border-only scan). The cached `base` is unchanged.
- `effective_base` and the manual repoint (`sample_base_at`, REBATE band) are unchanged; a per-image `base_override` still wins over the detected base.

## 5. UI surfacing + cleanup (frontend)

**Surface the active auto base** (also fixes the "we don't have film base set" confusion — today the swatch is empty when nothing is manually set):
- New command `auto_base_info(id) -> AutoBaseInfo { base: [f32;3], confidence: f32 }` returning `dev.base` + `dev.base_confidence`.
- `Basic.svelte`: `effBase` becomes `base_override ?? folderBase ?? autoBase` (fetch `autoBase` for the active image). The swatch always reflects the base actually in use.
- When the shown base is the auto one **and** `confidence < REBATE_CONFIDENCE`, show a subtle "⚠ low confidence — repoint?" hint next to the swatch, pointing to the existing recalibrate tool. (i18n keys en+zh.)
- The existing recalibrate / "Apply to roll" / "This image" base flow is unchanged.

**Cleanup of the D_max-roll misfeature** (D_max is scene-dependent, not roll-constant, so a per-roll D_max is wrong):
- Remove the "Apply D_max to roll" button + `applyDmaxRoll` (`Basic.svelte`).
- Remove the folder-`D_max` mechanism: `folderDmaxByPath` (`store.ts`), `setFolderDmax`/`clearFolderDmax` and the `d_max_override` injection from folder in `withEffectiveBase` (`base.ts`), and the `folder_dmax:` load in `catalog.ts` `applySnapshot`. Keep per-image `d_max_override` + the auto-analyze-on-crop reactive (drop its `folderDmaxByPath` guard term).
- `resetBase` keeps clearing the per-image `d_max_override`; drop its folder-dmax branch.

## 6. Testing & validation

**Unit (film-core, `calibrate.rs` tests):**
- Orange uniform border around a textured/bright-but-noisy center → `detect_rebate_base` returns `base ≈ border orange`, `confidence` high.
- Phoenix-like: bright blue uniform center + a thin orange edge strip → detector returns the **orange** base (not blue), confidence high. (Guards the actual bug.)
- Borderless: a single uniform non-orange field, or scene texture to the edges → `confidence` low (below a plausible threshold).
- Patch-scoring helpers: a flat orange patch scores ≫ a flat blue patch and ≫ a textured orange patch.

**Visual harness:** extend `crates/film-core/examples/` (or add `detect_base.rs`) to print `base` + `confidence` for the 4 DNGs and dump the chosen rebate patch location; confirm Phoenix resolves orange. Tune `REBATE_CONFIDENCE`/`UNIF_K`/`BAND_FRAC` against these before locking.

**Backend:** a develop-path test (or existing develop test extended) asserting that a synthetic frame with a clear orange rebate yields the detected orange base, and a borderless frame yields the fallback path (base from `sample_base_coherent`).

**Parity:** none needed — base flows through `build_params` → `resolve_to_uniforms`, so CPU and GPU stay in sync automatically.

## 7. Out of scope (explicitly deferred)

- WB rebuild / two-layer WB (next roadmap item — but this base work removes most of the cast WB currently fights).
- Geometric frame/rebate segmentation (Approach 3) and auto-crop.
- Auto per-roll/per-strip grouping or propagation (per-image self-resolves mixed rolls).
- Non-C-41 (B&W / E-6) base models.

## 8. Key code references (current, verify before editing)

- `crates/film-core/src/calibrate.rs` — `sample_base_coherent`, `sample_dmax`, `BASE_BAND_AUTO/REBATE`, `Rect`; add `detect_rebate_base` + `RebateBase`.
- `app/src-tauri/src/commands.rs` — `develop_heavy` base sampling (~:459), `ensure_resident` (~:673), `resolved_inversion` (~:1272), `sample_base_at` (manual repoint), `effective_base`, `build_params` (d_max_override). Add `auto_base_info` command (register in `lib.rs`).
- `app/src-tauri/src/session.rs` — `Developed` struct (add `base_confidence`).
- `app/src/lib/develop/Basic.svelte` — `effBase`/base swatch/recalibrate flow; remove `applyDmaxRoll` + its button; auto-analyze reactive.
- `app/src/lib/develop/base.ts`, `app/src/lib/store.ts`, `app/src/lib/catalog.ts` — folder-D_max removal.
- `app/src/lib/api.ts` — add `autoBaseInfo`; remove `analyze`'s roll usage only if applicable (keep `analyze` itself).
