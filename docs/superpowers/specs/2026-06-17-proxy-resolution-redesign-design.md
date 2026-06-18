# Proxy resolution + zoom-to-high-res — design (Spec 1)

Status: approved design, ready for implementation plan.
Date: 2026-06-17.

## Problem

Develop/load is slow because the resident "working" buffer is decoded and uploaded
at up to 4096px (Performance) or full-res (Quality). For the common case — viewing an
image fit-to-window — that is far more resolution than the display needs, so we pay
decode + GPU-upload cost we don't use. Editing decisions don't need full resolution;
only pixel-peeping (deep zoom) and export do.

A two-tier Quality toggle (Performance 4096 / Quality full-res) tries to manage this
but is a blunt global switch the user shouldn't have to think about.

## Goals

- Fit-view interaction (develop, navigate, edit) operates on a small **display-sized
  proxy** so decode + upload are fast.
- **Pixel-peeping stays sharp**: zooming past the proxy's native resolution loads a
  higher-res source on demand and swaps it in seamlessly.
- **Remove the Quality setting** entirely — it becomes obsolete.
- Export is unchanged (already full-res, independent of the working buffer).

## Non-goals (explicitly out of scope — separate specs)

- **Memory LRU / eviction** of resident buffers (Spec 2). This spec keeps interim
  memory bounded by construction (small proxies + a single-slot high-res cache), but
  does not add a general LRU over `Session.images`.
- A high-quality CPU (no-WebGL2) zoom path. v1 accepts soft zoom on that fallback.
- Tile-based partial-resolution loading. v1 loads a whole (capped) high-res image.

## Background — current state (for reference)

- `Quality` enum + `cap()`: `app/src-tauri/src/session.rs:11-26`. Performance = 4096,
  Quality = `u32::MAX`. Default Performance.
- `CACHE_WORKING_CAP = 4096`: `commands.rs:86`. `THUMB_EDGE=320` (:83),
  `AUTOWB_EDGE=256` (:84).
- `develop_compute` builds `working = proxy(&full, cap)`: `commands.rs:548-593`
  (proxy at :550). `develop_heavy` reads `session.quality...cap()` at :603.
- `ensure_developed` adequacy check `working_satisfies`: `commands.rs:88-94`, used at
  :671-711 (:676 reads cap).
- `set_quality`: `commands.rs:661-664`. Frontend store `quality`: `store.ts:21`.
  `QualityMenu.svelte` (quality rows + Flip/Reveal/Delete).
- `MAX_GPU_EDGE = 8192`: `gpu_upload.rs:65`. `capped_dims` (:69-78), `pack_rgba16f`
  (:83-94, downscales to the cap).
- Fit-view upload: `working_info` (`commands.rs:1639-1646`) +
  `working_pixels` (:1651-1670, packs at `MAX_GPU_EDGE`). Bake mode:
  `working_baked_info` (:1674-1692) + `working_baked_pixels` (:1833-1885).
- Frontend upload: `Viewport.svelte` `uploadWorking` (:250-280) →
  `renderer.setSourceFloat` (`renderer.ts:241-251`); geometry/draw `applyGeometryAndDraw`
  (:291-318). CPU fallback `render()` (:132-157) capped at `CAP=5000` (:49).
- Zoom state: `fit` (:78), `eff` (:79), `zoomed` (:80), `scale`, `cx/cy`; `onWheel`
  (:404-420), marquee (:428-533, `marquee.ts`).
- Export decodes full-res independently: `export_begin` (`commands.rs:1309`),
  `export_image` (:1183). **Unchanged by this spec.**

Key insight: **edits are GPU shader uniforms applied to whatever texture is bound**
(invert pass + finish pass in `renderer.ts`). Swapping the bound texture for a
higher-res one re-applies all edits automatically — no re-processing needed.

## Constants

- `PROXY_EDGE = 2560` (new). Fixed cap, window-size independent. Chosen so fit view is
  crisp on Retina/4K/5K while staying small (~7–17 MB/image).
- Zoom tier reuses `MAX_GPU_EDGE = 8192` (the GPU texture cap), referenced as the
  "zoom cap". No new constant.

## Design

### Tier 1 — proxy (resident, fit view)

- `develop_compute`: `working = proxy(&full, PROXY_EDGE)` instead of the Quality cap.
  Everything else (thumb 256, base/d_max sampling, classify) is unchanged and remains
  accurate at 2560.
- `.oecache` now stores the 2560 proxy (smaller sidecars).
- `ensure_resident` (cache load): if a loaded cache's `working` long-edge `> PROXY_EDGE`
  (an old 4096 cache), re-proxy to `PROXY_EDGE` so resident memory is consistent. No
  schema migration.
- Fit-view GPU upload (`working_pixels` / `working_baked_pixels`) packs at `PROXY_EDGE`
  (was `MAX_GPU_EDGE`). Since the resident buffer is already ≤ `PROXY_EDGE`, this is a
  no-op cap in practice but makes the intent explicit.

### Quality removal (blast radius)

Delete, in one change:
- `session.rs`: `Quality` enum, `cap()`, `Session.quality` field.
- `commands.rs`: `set_quality`; `working_satisfies`; the `session.quality...cap()` reads
  in `develop_heavy` and `ensure_developed` (replace with `PROXY_EDGE`). `ensure_developed`
  keeps its idempotent "already resident & adequate" early-return, now testing
  `working_edge >= min(native, PROXY_EDGE)`.
- `lib.rs`: drop `set_quality` from the invoke handler.
- `store.ts`: remove `quality` store and its persistence; `api.ts`: remove `setQuality`,
  `Quality` type.
- `QualityMenu.svelte`: remove the heading + two quality buttons + their divider; keep
  Flip/Reveal/Delete. (Component may keep its name for v1.)
- Remove the `quality.*` i18n strings via the CSV pipeline (`i18n-strings.csv` +
  `scripts/gen-i18n.py`; never edit `dict.ts` directly).

### Tier 2 — zoom (on demand, deep zoom)

Parameterize the existing GPU-upload commands with a source tier rather than adding a
parallel command set. `working_info` / `working_pixels` / `working_baked_info` /
`working_baked_pixels` gain a `hires: bool` argument:

- `hires = false` (fit): pack the resident proxy `working` at `PROXY_EDGE` (today's path).
- `hires = true` (zoom): obtain the decoded high-res source (single-slot cache below)
  instead of the resident proxy, run the same path (raw pack for the non-bake case;
  geometry + dust/IR heal for bake mode), and pack at `MAX_GPU_EDGE`.

This preserves the existing non-bake/bake split — geometry via GPU uniforms when no
dust/IR is active, baked into the texture when it is — so the zoom tier only changes the
pixel **source** and the **cap**. All four stay async + `spawn_blocking`.

**Single-slot high-res cache** in `Session`:
- `zoom_src: Mutex<Option<(String /*id*/, film_core::Image)>>` — the decoded, capped
  (`MAX_GPU_EDGE`) raw-negative for the currently-zoomed image, pre-bake.
- `zoom_pixels` decodes from file only when the slot is empty or holds a different id;
  otherwise reuses it (so re-zoom and inversion/dust/geometry tweaks re-bake without
  re-decoding). Replaced when a different image zooms. Bounded to ~1 high-res buffer —
  keeps memory sane before Spec 2's LRU.
- Dropped/replaced on image switch (when a new id requests zoom). A param-only change
  (exposure/temp/etc.) never touches it — those are uniforms.

### Frontend — `Viewport.svelte`

- **Threshold:** compute `wantZoomTier = eff * max(imgW, imgH) > PROXY_EDGE` (displayed
  long-edge exceeds proxy native). Add hysteresis (e.g. enter zoom tier above
  `PROXY_EDGE`, fall back to proxy only below `PROXY_EDGE * 0.9`) + a short debounce so
  boundary wheel/marquee moves don't thrash the decode.
- **Tier in the upload key:** extend `currentUploadKey()` with `proxy|zoom`. When the
  tier flips to `zoom`, `uploadWorking()` passes `hires=true` to the same `working_*`
  calls, then `setSourceFloat` swaps the texture and redraws. When it flips back to
  `proxy`, re-upload at `hires=false` (frees the larger GPU texture).
- **Seamless swap:** the proxy texture stays bound (rendering the upscaled view) until
  the high-res fetch resolves; the existing stale-guard (`currentUploadKey() !== k`)
  already discards results if the user zoomed back out or switched images mid-fetch.
- Bake mode (dust/IR active) at the zoom tier bakes on the high-res source; same code
  path, different source + cap.

### CPU / raw / no-WebGL2 (v1 behavior)

- `render_view` (CPU fallback) continues to render from the 2560 proxy, capped at
  `CAP=5000`. Zoomed pixel-peeping is soft on no-WebGL2 machines — accepted for v1.
- Base-picker raw view samples the proxy (2560 is ample for rebate/base sampling).

### Export

Unchanged. `export_begin` / `export_image` re-decode full native resolution and are
independent of the proxy and the zoom cache.

## Edge cases & risks

- **Boundary thrash:** rapid zoom across the threshold could trigger repeated decodes.
  Mitigated by hysteresis + debounce, and by the single-slot cache (a second zoom of the
  same image reuses the decode).
- **Decode latency on first zoom:** RAW decode is seconds. Mitigated by keeping the
  proxy visible (upscaled) until the sharp texture arrives — the user sees an immediate,
  if soft, zoom that sharpens shortly after.
- **Sources > 8192px:** the zoom tier caps at `MAX_GPU_EDGE`, so very large scans are
  shown at ≤8192 even at max zoom (minor softness vs native). Export still uses true
  native. Acceptable.
- **Stale fetches:** handled by the existing upload-key stale-guard.
- **Old 4096 caches:** re-proxied to 2560 on load; harmless.
- **Memory before Spec 2:** proxies are small; the zoom cache is single-slot. Interim
  footprint is bounded without a general LRU.

## Testing

- Rust unit tests: `proxy` caps at `PROXY_EDGE`; `zoom` decode/bake/pack dims cap at
  `MAX_GPU_EDGE`; single-slot `zoom_src` replaces on a new id and reuses on the same id;
  `ensure_developed` adequacy against `min(native, PROXY_EDGE)`.
- Existing tests updated for the removed `Quality` (any tests referencing it).
- Manual: develop/load is visibly faster; fit view crisp on a hi-DPI display; zoom-in
  shows a brief proxy→sharp transition; zoom-out frees the high-res texture; param edits
  while zoomed stay sharp without re-decode; export output unchanged at full res; the
  Quality menu rows are gone and Flip/Reveal/Delete still work.

## Rollout / sequencing within the plan

1. Introduce `PROXY_EDGE`, switch `develop_compute` + fit-view packing to it, re-proxy
   old caches on load. (Proxy tier works; zoom still upscales the proxy.)
2. Remove the Quality setting (backend + frontend + i18n).
3. Add the `zoom_src` single-slot cache + the `hires` arg on the four `working_*`
   commands (decode high-res into the cache, bake/pack at `MAX_GPU_EDGE`).
4. Wire the Viewport threshold + tier-aware upload (`hires`) + seamless swap.
5. Tests + manual verification.
