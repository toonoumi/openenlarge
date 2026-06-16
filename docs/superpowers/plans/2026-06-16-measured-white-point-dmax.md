# Measured White-Point D_max Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional measured white-point (exposed-leader) anchor that pins the roll's Cineon `D_max` via the existing `d_max_override`, instead of the per-frame scene-percentile estimate.

**Architecture:** One new engine function (`calibrate::dmax_from_white_point`) computes a scalar `D_max = max_c log10(base[c]/white[c])` from a sampled rect. A CLI flag and a Tauri command expose it; a minimal develop-panel tool (mirroring the existing base-recalibrate picker) lets the user click the leader. The result flows through the already-built `d_max_override` path — persistence, copy-settings, GPU live preview, and export all work unchanged.

**Tech Stack:** Rust (`film-core`, `film-cli`), Tauri 2 commands, SvelteKit/TypeScript UI, Vitest + `cargo test`.

## Global Constraints

- **Anchor logic:** Override (measured white-point replaces auto `D_max`), scalar via max-across-channels, clamped `[1.0, 4.0]`. Never per-channel (would bake WB into the inversion).
- **White-point value:** per-channel **5th-percentile** of the sampled rect (leader is densest → darkest scan; reject dust specks).
- **i18n:** add strings to `/i18n-strings.csv` then run `python3 scripts/gen-i18n.py`. NEVER edit `app/src/lib/i18n/dict.ts` directly (regen wipes hand edits).
- **Branch:** commit directly on `main` (project convention).
- **Reuse `d_max_override`** end-to-end; do not add new wire-contract fields.
- **Commit message footer:** end every commit with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Engine — `dmax_from_white_point`

**Files:**
- Modify: `crates/film-core/src/calibrate.rs` (add public fn near `sample_dmax`, ~line 234)
- Test: `crates/film-core/src/calibrate.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `crate::Image`, `Rect`, private helpers `downscale_for_detect`, `scaled_rect`, const `SAMPLE_CAP` (all already in `calibrate.rs`).
- Produces: `pub fn dmax_from_white_point(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/film-core/src/calibrate.rs`:

```rust
#[test]
fn dmax_from_white_point_uses_channel_max_density() {
    // 4x4 uniform "leader" patch: dense (dark) scan values.
    // base/white per channel: R 0.8/0.08 → 1.0, G 0.8/0.008 → 2.0, B 0.8/0.08 → 1.0.
    // max across channels → 2.0.
    let white = [0.08f32, 0.008, 0.08];
    let pixels = vec![white; 16];
    let img = Image { width: 4, height: 4, pixels, ir: None };
    let d = dmax_from_white_point(&img, [0.8, 0.8, 0.8], None);
    assert!((d - 2.0).abs() < 1e-3, "expected ~2.0, got {d}");
}

#[test]
fn dmax_from_white_point_clamps_to_range() {
    // Extremely dense leader would exceed 4.0 → clamp; near-clear would underflow → 1.0.
    let dense = vec![[1e-4f32, 1e-4, 1e-4]; 16];
    let img = Image { width: 4, height: 4, pixels: dense, ir: None };
    assert_eq!(dmax_from_white_point(&img, [0.8, 0.8, 0.8], None), 4.0);

    let clearish = vec![[0.79f32, 0.79, 0.79]; 16];
    let img2 = Image { width: 4, height: 4, pixels: clearish, ir: None };
    assert_eq!(dmax_from_white_point(&img2, [0.8, 0.8, 0.8], None), 1.0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p film-core dmax_from_white_point`
Expected: FAIL — `cannot find function dmax_from_white_point in this scope`.

- [ ] **Step 3: Write minimal implementation**

Add immediately after `sample_dmax` (after its closing brace, ~line 234) in `crates/film-core/src/calibrate.rs`:

```rust
/// Cineon `D_max` from a **measured white-point**: the fully-exposed leader,
/// sampled in `rect`. The leader is the densest film (max light recorded), hence
/// the darkest region of the scan, so per channel we take a robust low value (5th
/// percentile, rejecting dust specks) as the white-point and convert to density
/// `log10(base_c / white_c)`, then take the max across channels (keeps `D_max`
/// scalar so white balance stays a separate print-side gain, not baked into the
/// inversion). Clamped to `[1.0, 4.0]`, mirroring `sample_dmax`. Unlike
/// `sample_dmax`, the anchor comes from the user's leader rect, not scene content —
/// giving a roll-constant highlight anchor instead of a per-frame estimate.
pub fn dmax_from_white_point(img: &Image, base: [f32; 3], rect: Option<Rect>) -> f32 {
    const WHITE_PCT: f32 = 0.05; // 5th percentile of the leader patch
    let small = downscale_for_detect(img, SAMPLE_CAP);
    let r = scaled_rect(rect, img, &small);
    let mut chans: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for yy in r.y..(r.y + r.h).min(small.height) {
        for xx in r.x..(r.x + r.w).min(small.width) {
            let px = small.pixels[yy * small.width + xx];
            for c in 0..3 {
                chans[c].push(px[c]);
            }
        }
    }
    let mut d_max = 1.0f32;
    for c in 0..3 {
        if chans[c].is_empty() || base[c] <= 1e-6 {
            continue;
        }
        chans[c].sort_by(|a, b| a.partial_cmp(b).unwrap());
        let idx = ((chans[c].len() as f32) * WHITE_PCT) as usize;
        let white = chans[c][idx.min(chans[c].len() - 1)].max(1e-5);
        let density = (base[c] / white).log10();
        d_max = d_max.max(density);
    }
    d_max.clamp(1.0, 4.0)
}
```

> Note: standalone (copies `sample_dmax`'s ~20 lines with a different percentile) to keep the inversion hot-path function untouched in this prototype. DRY follow-up: extract a private `dmax_from_region(img, base, rect, low_pct)` shared by both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p film-core dmax_from_white_point`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify no regressions + lint**

Run: `cargo test -p film-core && cargo clippy -p film-core --all-targets`
Expected: all tests pass, no new clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/calibrate.rs
git commit -m "feat(engine): dmax_from_white_point — measured-leader D_max anchor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: CLI — `--white-rect` flag

**Files:**
- Modify: `crates/film-cli/src/main.rs` (add arg ~line 19; use it where `d_max` is set ~line 73-80)

**Interfaces:**
- Consumes: `film_core::calibrate::{Rect, sample_base, sample_dmax, dmax_from_white_point}`
- Produces: CLI behavior — when `--white-rect x,y,w,h` is present, `d_max` is computed from the white-point; otherwise unchanged.

- [ ] **Step 1: Add the arg to the clap struct**

In `crates/film-cli/src/main.rs`, immediately after the `base_rect` field (~line 19), add:

```rust
    /// Optional measured white-point rect (exposed leader): x,y,w,h. When set,
    /// D_max is anchored to this leader instead of the scene-percentile estimate.
    #[arg(long, value_delimiter = ',')]
    white_rect: Option<Vec<usize>>,
```

- [ ] **Step 2: Update the import**

Change the calibrate import line (~line 3) to include the new function and `sample_dmax`:

```rust
use film_core::calibrate::{dmax_from_white_point, sample_base, sample_dmax, Rect};
```

- [ ] **Step 3: Compute D_max from the white-point when present**

After `let base = sample_base(&img, rect);` (~line 73) and before building `InversionParams`, add:

```rust
    // Parse an optional white-rect the same way as base_rect.
    let white_rect = cli.white_rect.as_ref().and_then(|v| {
        if v.len() == 4 {
            Some(Rect { x: v[0], y: v[1], w: v[2], h: v[3] })
        } else {
            None
        }
    });
    let d_max = match white_rect {
        Some(_) => dmax_from_white_point(&img, base, white_rect),
        None => sample_dmax(&img, base, None),
    };
```

Then in the `InversionParams { ... }` literal (~line 78-81), add `d_max,` alongside the existing fields:

```rust
        print_exposure: 2f32.powf(cli.exposure),
        d_max,
```

- [ ] **Step 4: Build and smoke-test**

Run: `cargo build -p film-cli`
Expected: compiles clean.

Run (uses any TIFF/RAW fixture you have; substitute a real path):
```bash
cargo run -p film-cli -- <input.tiff> -o /tmp/wp_off.tiff
cargo run -p film-cli -- <input.tiff> -o /tmp/wp_on.tiff --white-rect 0,0,64,64
```
Expected: both succeed; outputs differ (the `--white-rect` run anchors D_max to the top-left 64×64 patch).

- [ ] **Step 5: Commit**

```bash
git add crates/film-cli/src/main.rs
git commit -m "feat(cli): --white-rect anchors D_max to a measured leader patch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Tauri command — `analyze_white_point` + bindings

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (add command after `analyze`, ~line 1652; reuse `Analysis` struct at line 1624)
- Modify: `app/src-tauri/src/lib.rs` (register in `generate_handler!`, after `commands::analyze,` line 115)
- Modify: `app/src/lib/api.ts` (add binding after `analyze`, ~line 203)

**Interfaces:**
- Consumes: `film_core::calibrate::{dmax_from_white_point, Rect}`, existing `effective_base`, `crop_px`, `ensure_resident`, `Analysis { d_max: f32 }`.
- Produces:
  - Rust: `analyze_white_point(id: String, params: InvertParams, rect: [f64; 4], session) -> Result<Analysis, String>`
  - TS: `api.analyzeWhitePoint(id: string, params: InvertParams, rect: [number, number, number, number]) => Promise<{ d_max: number }>`

- [ ] **Step 1: Write the failing Rust test**

`analyze_white_point` needs a resident developed image (hard to unit-test in isolation), so test the **math wiring** at the engine boundary instead. Add to the `#[cfg(test)] mod tests` block in `commands.rs`:

```rust
#[test]
fn white_point_dmax_matches_engine() {
    use film_core::calibrate::dmax_from_white_point;
    let white = [0.08f32, 0.008, 0.08];
    let img = film_core::Image { width: 4, height: 4, pixels: vec![white; 16], ir: None };
    let d = dmax_from_white_point(&img, [0.8, 0.8, 0.8], None);
    assert!((d - 2.0).abs() < 1e-3);
}
```

- [ ] **Step 2: Run to verify it fails or passes-as-smoke**

Run: `cargo test -p app white_point_dmax_matches_engine` (or the crate name from `app/src-tauri/Cargo.toml`; check with `grep '^name' app/src-tauri/Cargo.toml`).
Expected: PASS once `film-core` Task 1 is merged (this guards the contract the command relies on). If it fails to compile, the import path is wrong — fix before proceeding.

- [ ] **Step 3: Add the command**

In `app/src-tauri/src/commands.rs`, immediately after the `analyze` command's closing brace (~line 1652, before `#[cfg(test)] mod tests`), add:

```rust
/// Anchor D_max to a measured white-point: sample the exposed leader from a
/// normalized rect [x,y,w,h] (0..1) over the resident working image and return the
/// scalar D_max. The frontend stores this in `d_max_override` (same as `analyze`),
/// so it overrides the per-frame scene estimate for this image.
#[tauri::command]
pub fn analyze_white_point(
    id: String,
    params: InvertParams,
    rect: [f64; 4],
    session: State<Session>,
) -> Result<Analysis, String> {
    use film_core::calibrate::{dmax_from_white_point, Rect};
    ensure_resident(&session, &id)?;
    let images = session.images.lock().unwrap();
    let img = images.get(&id).ok_or("unknown image id")?;
    let dev = img.developed.as_ref().ok_or("not developed")?;
    let base = effective_base(&params, dev.base);
    let (x, y, w, h) = crop_px(rect, dev.working.width, dev.working.height);
    Ok(Analysis {
        d_max: dmax_from_white_point(&dev.working, base, Some(Rect { x, y, w, h })),
    })
}
```

- [ ] **Step 4: Register the command**

In `app/src-tauri/src/lib.rs`, in the `tauri::generate_handler![ ... ]` list, add a line right after `commands::analyze,` (line 115):

```rust
            commands::analyze_white_point,
```

- [ ] **Step 5: Add the TS binding**

In `app/src/lib/api.ts`, immediately after the `analyze` binding (line 202-203), add:

```ts
  analyzeWhitePoint: (id: string, params: InvertParams, rect: [number, number, number, number]) =>
    invoke<{ d_max: number }>("analyze_white_point", { id, params, rect }),
```

- [ ] **Step 6: Build the backend**

Run: `cd app && npm run tauri build -- --debug` *(or, faster:)* `cargo build --manifest-path app/src-tauri/Cargo.toml`
Expected: compiles clean; command registered (no "command not found" at runtime).

- [ ] **Step 7: Typecheck the frontend**

Run: `cd app && npm run check`
Expected: no new type errors.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/lib/api.ts
git commit -m "feat(develop): analyze_white_point command + api binding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: UI — white-point picker tool

**Files:**
- Modify: `app/src/lib/store.ts` (add `whitePointSampling`, `sampledDmax`, `whitePointPinned` stores after `baseSampling`, line 151)
- Modify: `app/src/lib/develop/BaseView.svelte` (add `mode` prop + `dmax` dispatch branch in `sampleAt`)
- Modify: `app/src/lib/tabs/Develop.svelte` (import new stores; add `{:else if $whitePointSampling}` render block after line 321)
- Modify: `app/src/lib/develop/Basic.svelte` (import new stores; add tool button, `sampledDmax` reactor, pin logic; gate the crop auto-reanalyze on the pin)
- Modify: `i18n-strings.csv` (add `base.whitepoint` string) → regenerate `dict.ts`

**Interfaces:**
- Consumes: `api.analyzeWhitePoint`, stores from `store.ts`.
- Produces: stores `whitePointSampling: Writable<boolean>`, `sampledDmax: Writable<number | null>`, `whitePointPinned: Writable<Set<string>>`; BaseView `mode: "base" | "whitepoint"` prop dispatching `dmax: number`.

- [ ] **Step 1: Add the stores**

In `app/src/lib/store.ts`, immediately after `export const baseSampling = writable<boolean>(false);` (line 151), add:

```ts
// White-point (exposed-leader) D_max anchor tool. `sampledDmax` carries a freshly
// measured D_max from BaseView (whitepoint mode) to Basic.svelte. `whitePointPinned`
// marks images whose D_max is user-pinned so the crop-change auto-reanalyze won't
// clobber it (frontend-only, non-persistent — prototype scope).
export const whitePointSampling = writable<boolean>(false);
export const sampledDmax = writable<number | null>(null);
export const whitePointPinned = writable<Set<string>>(new Set());
```

- [ ] **Step 2: Extend BaseView with a `mode` prop and `dmax` dispatch**

In `app/src/lib/develop/BaseView.svelte`:

(a) After `export let imgH = 0;` (line 9) add:
```ts
  export let mode: "base" | "whitepoint" = "base";
```

(b) Change the dispatcher type (line 11) to also carry `dmax`:
```ts
  const dispatch = createEventDispatcher<{ sampled: [number, number, number]; dmax: number }>();
```

(c) In `sampleAt` (the `try` block around line 56), branch on `mode`. Replace:
```ts
    try {
      const b = await api.sampleBaseAt(id, [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)]);
      dispatch("sampled", b);
    } catch { /* ignore */ }
```
with:
```ts
    const rect: [number, number, number, number] = [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
    try {
      if (mode === "whitepoint") {
        const { d_max } = await api.analyzeWhitePoint(id, params, rect);
        dispatch("dmax", d_max);
      } else {
        const b = await api.sampleBaseAt(id, rect);
        dispatch("sampled", b);
      }
    } catch { /* ignore */ }
```

- [ ] **Step 3: Add the whitepoint render block in Develop.svelte**

In `app/src/lib/tabs/Develop.svelte`:

(a) Add the new stores to the import on line 5 (append to the destructured list): `whitePointSampling, sampledDmax`.

(b) After the existing BaseView block (lines 319-321), insert a parallel branch:
```svelte
      {:else if $whitePointSampling}
        <BaseView id={$activeId} params={effParams} imgW={origW} imgH={origH}
                  mode="whitepoint"
                  on:dmax={(e) => sampledDmax.set(e.detail)} />
```

(c) Mirror the tool-exit guard at line 72 (which clears `baseSampling` when leaving edit): right after it add:
```ts
  $: if ($tool !== "edit" && $whitePointSampling) whitePointSampling.set(false);
```

- [ ] **Step 4: Wire the tool button + pin logic in Basic.svelte**

In `app/src/lib/develop/Basic.svelte`:

(a) Add stores to the import on line 4: append `whitePointSampling, sampledDmax, whitePointPinned`.

(b) After `function toggleRecalibrate() { baseSampling.update((v) => !v); }` (line 58) add:
```ts
  function toggleWhitePoint() { whitePointSampling.update((v) => !v); }

  function isPinned(id: string | null): boolean {
    return !!id && get(whitePointPinned).has(id);
  }
  function setPinned(id: string, on: boolean) {
    whitePointPinned.update((s) => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });
  }

  // Apply a freshly measured white-point D_max: pin it, override, reseed WB, close tool.
  function applyWhitePointDmax(d: number) {
    const id = get(activeId); if (!id) { sampledDmax.set(null); return; }
    setPinned(id, true);
    params.update((p) => ({ ...p, d_max_override: d }));
    commitActive();
    autoWb();
    sampledDmax.set(null);
    whitePointSampling.set(false);
  }
  $: if ($sampledDmax != null) applyWhitePointDmax($sampledDmax);
```

(c) Gate the crop-change auto-reanalyze (lines 111-117) on the pin. Change the `if` condition:
```ts
    if (id && id === lastCrop.id && key !== lastCrop.key && !isPinned(id)) {
      reanalyze();
    }
```

(d) Make the **manual** "Re-Analysis for crop" button clear the pin (explicit return to auto). The button calls `reanalyze` (see the `base.reanalyze` markup). Add a wrapper and point the button at it. After `reanalyze()` (ends line 105) add:
```ts
  function manualReanalyze() {
    const id = get(activeId); if (id) setPinned(id, false);
    reanalyze();
  }
```
Then in the markup, change the Re-Analysis button's handler from `on:click={reanalyze}` to `on:click={manualReanalyze}`.

(e) Reset the tool on image switch — extend the existing reset at line 47:
```ts
  $: { $activeId; sampledBase.set(null); baseSampling.set(false); whitePointSampling.set(false); sampledDmax.set(null); }
```

(f) Add the tool button next to the base swatch (after the `baseswatch` button block ~line 181-182). Insert:
```svelte
        <button class="baseswatch wp" class:on={$whitePointSampling} on:click={toggleWhitePoint}
                title={$t('base.whitepoint')} aria-label={$t('base.whitepoint')}>WP</button>
```

- [ ] **Step 5: Add the i18n string and regenerate**

Append a row to `i18n-strings.csv` (after the `base.reanalyze` row, line 168). Match the existing column format `key,en,zh,file,note`:
```csv
base.whitepoint,"Pick the exposed-leader white-point (anchors D_max)","拾取曝光片头白点（锚定D_max）","src/lib/develop/Basic.svelte","button tooltip"
```

Then regenerate the dictionary (NEVER edit `dict.ts` by hand):
```bash
python3 scripts/gen-i18n.py
```
Expected: `app/src/lib/i18n/dict.ts` regenerated with the new `base.whitepoint` key.

- [ ] **Step 6: Typecheck + unit tests**

Run: `cd app && npm run check && npm run test:unit`
Expected: no type errors; existing unit tests pass.

- [ ] **Step 7: Manual smoke test (the real verification)**

Run: `cd app && npm run tauri dev`
1. Import/develop a negative.
2. Click the **WP** button → viewport enters leader-pick mode → click the exposed leader / clear-dense edge.
3. Confirm the image re-renders and the develop `d_max_override` updates (highlights shift).
4. Change the crop → confirm D_max is **not** auto-recomputed (pin holds).
5. Click **Re-Analysis for crop** → confirm it returns to auto D_max (pin cleared).

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/develop/BaseView.svelte app/src/lib/tabs/Develop.svelte app/src/lib/develop/Basic.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): measured white-point picker pins D_max

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Anchor logic (override, scalar, clamp, 5th-pct) → Task 1 ✓
- Engine `dmax_from_white_point` → Task 1 ✓
- CLI `--white-rect` → Task 2 ✓
- Tauri `analyze_white_point` → Task 3 ✓
- Minimal UI tool + api binding + i18n → Tasks 3-4 ✓
- Auto-reanalyze suppression (frontend-only pin) → Task 4 steps (c)(d) ✓
- Out-of-scope items (per-channel D_max, persisted pin, HDR/export changes) → none added ✓

**Placeholder scan:** No TBD/TODO; all steps have concrete code or exact commands.

**Type consistency:** `dmax_from_white_point(img, base, rect) -> f32` consistent across Tasks 1-3. `analyzeWhitePoint(id, params, rect) -> {d_max}` consistent between api.ts (Task 3) and BaseView (Task 4). Stores `whitePointSampling`/`sampledDmax`/`whitePointPinned` defined in Task 4 step 1 and consumed in steps 3-4. `Analysis { d_max }` reused from existing code.

**Known prototype limitation (documented in spec):** the pin is non-persistent; after reload a crop change can re-clobber a measured D_max. Production follow-up = persisted `d_max_pinned` flag on `InvertParams`.
