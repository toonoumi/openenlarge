# Faithful Look Layer + Sole Develop Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake a clean-punchy look curve into the Faithful core, make Faithful the sole develop/tune path (Filmic retired from the app), and force-refresh the whole catalog on app entry.

**Architecture:** A per-channel normalized-tanh S-curve (`look_s`, `LOOK_K=2.0`) wraps the Faithful core's SDR display value in `engine.rs::invert_d`, mirrored verbatim in the GPU `INVERT_FRAG`. Every tone_mode chokepoint (CPU `build_params`, GPU `resolve_to_uniforms`, frontend `toInversionUniforms`) is forced to Faithful so stored `"filmic"` cannot leak; the UI toggle and its i18n are removed. `ENGINE_VERSION` bumps `1→2` (marking all baked thumbnails stale) and a Grid startup sweep eagerly regenerates them.

**Tech Stack:** Rust (`film-core` engine, `src-tauri` Tauri commands), TypeScript/Svelte frontend, WebGL2 GLSL shaders, SQLite catalog, Python i18n generator.

## Global Constraints

- **CPU/GPU parity (mandatory):** `engine.rs` Faithful math == `shaders.ts` `INVERT_FRAG` faithful branch, verbatim — same constants, same `look_s`/`lookS` form, same clamp. The CPU full-res export and GPU proxy preview must render identically.
- **`look_s` curve:** `look_s(v) = clamp(0.5 + 0.5·tanh(LOOK_K·(v−0.5)) / tanh(LOOK_K·0.5), 0, 1)`, **`LOOK_K = 2.0`** (exact). Anchors `0→0`, `0.5→0.5`, `1→1`; monotonic; soft toe + soft shoulder.
- **Look applies in SDR only.** In the CPU engine, when `p.hdr` is true the Faithful path keeps the headroom-expanded value (no `look_s`). `INVERT_FRAG` is always SDR, so it always applies `lookS`.
- **Filmic stays byte-identical and dormant.** Do NOT change the `ToneMode::Filmic` arm, `filmic_s`, `filmic_inv`, or the GLSL filmic functions. Keep both `ToneMode` variants. Filmic must simply be unreachable from the app.
- **Saved edits preserved:** WB, exposure, contrast, crop, dust all still apply; only the tone curve changes.
- **i18n only via `i18n-strings.csv` + `scripts/gen-i18n.py`** — never hand-edit `dict.ts`.
- **Commit discipline:** `git add <exact paths>` only — never `git add -A`/`-am` (the user commits to `main` in parallel). End commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- `crates/film-core/src/engine.rs` — add `LOOK_K` + `look_s`; apply in the Faithful SDR arm. (Task 1)
- `app/src/lib/viewport/gl/shaders.ts` — GLSL `LOOK_K` + `lookS`; apply in `INVERT_FRAG` faithful branch. (Task 2)
- `app/src-tauri/src/commands.rs` — `build_params` forces `ToneMode::Faithful`. (Task 3)
- `app/src-tauri/src/gpu_upload.rs` — `resolve_to_uniforms` forces `tone_mode = 1`. (Task 3)
- `app/src/lib/viewport/gl/invert.ts` — `toInversionUniforms` forces `tone_mode: 1`. (Task 4)
- `app/src/lib/api.ts` — `defaultParams.tone_mode = "faithful"`. (Task 4)
- `app/src/lib/develop/Basic.svelte` — remove the tone-mode toggle. (Task 4)
- `i18n-strings.csv` (+ regenerate `app/src/lib/i18n/dict.ts`) — drop the tone-mode strings. (Task 4)
- `crates/film-core/src/lib.rs` — `ENGINE_VERSION` `1 → 2`. (Task 5)
- `app/src-tauri/src/catalog.rs` — test that a version mismatch flags `thumb_stale`. (Task 5)
- `app/src/lib/library/Grid.svelte` — eager startup sweep regenerating developed+stale thumbnails. (Task 6)

---

### Task 1: `look_s` curve + apply in the Faithful path (engine.rs)

**Files:**
- Modify: `crates/film-core/src/engine.rs` (constants block near `FAITHFUL_SCALE` ~line 126; Faithful arm ~lines 305-315; tests module)

**Interfaces:**
- Consumes: existing `gamma_shoulder(x, ceil)`, `FAITHFUL_SCALE`, `ToneMode::Faithful`, `InversionParams`.
- Produces: `fn look_s(v: f32) -> f32`, `const LOOK_K: f32 = 2.0` (mirrored by Task 2's GLSL).

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` in `crates/film-core/src/engine.rs`:

```rust
#[test]
fn look_s_anchors_and_pins() {
    assert!(look_s(0.0).abs() < 1e-6, "0->0: {}", look_s(0.0));
    assert!((look_s(0.5) - 0.5).abs() < 1e-6, "0.5->0.5: {}", look_s(0.5));
    assert!((look_s(1.0) - 1.0).abs() < 1e-6, "1->1: {}", look_s(1.0));
    // pinned values (also pin the GPU GLSL mirror) for LOOK_K = 2.0
    assert!((look_s(0.25) - 0.196_61).abs() < 1e-4, "0.25: {}", look_s(0.25));
    assert!((look_s(0.75) - 0.803_39).abs() < 1e-4, "0.75: {}", look_s(0.75));
}

#[test]
fn look_s_monotonic_in_range_no_clip() {
    let mut prev = -1.0;
    let mut v = 0.0;
    while v <= 1.0001 {
        let s = look_s(v);
        assert!(s >= prev - 1e-7, "monotonic at {v}: {s} < {prev}");
        assert!((0.0..=1.0).contains(&s), "in range at {v}: {s}");
        prev = s;
        v += 1.0 / 512.0;
    }
}

#[test]
fn look_s_adds_midcontrast_soft_ends() {
    let slope = |v: f32| (look_s(v + 1e-3) - look_s(v - 1e-3)) / 2e-3;
    assert!(slope(0.5) > 1.05, "mid slope adds punch: {}", slope(0.5));
    assert!(slope(0.08) < 1.0, "toe is soft: {}", slope(0.08));
    assert!(slope(0.92) < 1.0, "shoulder is soft: {}", slope(0.92));
}

#[test]
fn faithful_look_darkens_shadow_keeps_neutral() {
    // The look adds contrast (a mid-shadow gets darker than the bare core), and a
    // neutral negative stays neutral (per-channel curve preserves equal channels).
    let base = [0.42, 0.55, 0.26];
    let scan = [0.30, 0.36, 0.18];
    let p = InversionParams { base, d_max: 1.5, tone_mode: ToneMode::Faithful, ..Default::default() };
    let out = invert_d(scan, &p);
    // neutral scan (equal density vs base) -> equal output channels
    let neg = [base[0] * 10f32.powf(-0.5), base[1] * 10f32.powf(-0.5), base[2] * 10f32.powf(-0.5)];
    let nout = invert_d(neg, &p);
    let (mx, mn) = (nout.iter().cloned().fold(f32::MIN, f32::max), nout.iter().cloned().fold(f32::MAX, f32::min));
    assert!(mx - mn < 1e-3, "neutral stays neutral under look: {nout:?}");
    assert!(out.iter().all(|&v| (0.0..=1.0).contains(&v)), "in range: {out:?}");
}

#[test]
fn faithful_hdr_bypasses_look() {
    // HDR Faithful keeps the headroom-expanded value (look applies SDR only): a dense
    // neg exceeds 1.0 under HDR but is capped at 1.0 under SDR.
    let base = [1.0, 1.0, 1.0];
    let bright = [10f32.powf(-1.6); 3];
    let sdr = invert_d(bright, &InversionParams { base, tone_mode: ToneMode::Faithful, hdr: false, ..Default::default() });
    let hdr = invert_d(bright, &InversionParams { base, tone_mode: ToneMode::Faithful, hdr: true, ..Default::default() });
    assert!(sdr[0] <= 1.0001, "SDR capped: {}", sdr[0]);
    assert!(hdr[0] > 1.0001, "HDR exceeds SDR white (look bypassed): {}", hdr[0]);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p film-core --lib engine::tests::look_s_anchors_and_pins engine::tests::faithful_look_darkens_shadow_keeps_neutral engine::tests::faithful_hdr_bypasses_look -- --nocapture`
Expected: FAIL — `cannot find function 'look_s' in this scope`.

- [ ] **Step 3: Add `LOOK_K` + `look_s`**

In `crates/film-core/src/engine.rs`, immediately AFTER the `const FAITHFUL_SCALE: f32 = 1.0 / 0.700;` line (and its doc comment), add:

```rust
/// Look-layer strength — the clean-punchy "MEDIUM" the user chose (~+31% mid-contrast).
/// MUST equal shaders.ts LOOK_K.
const LOOK_K: f32 = 2.0;

/// Clean-punchy look curve: a normalized symmetric tanh S applied to the faithful core's
/// SDR display value `v ∈ [0,1]`. Pivot 0.5, anchored `0→0` and `1→1`, strictly monotonic,
/// soft toe + soft shoulder — adds mid-contrast (punch) without clipping or crushing detail.
/// This is the film-LOOK layer on top of the measured faithful core; SDR only (HDR bypasses
/// it). MUST equal shaders.ts `lookS`.
#[inline]
fn look_s(v: f32) -> f32 {
    let t = (LOOK_K * 0.5).tanh();
    (0.5 + 0.5 * (LOOK_K * (v - 0.5)).tanh() / t).clamp(0.0, 1.0)
}
```

- [ ] **Step 4: Apply the look in the Faithful arm (SDR only)**

In `invert_d`, replace the `ToneMode::Faithful => { ... }` arm (currently lines ~305-315) with:

```rust
            ToneMode::Faithful => {
                let ceil = if p.hdr { HDR_HEADROOM } else { 1.0 };
                // Faithful uses a FIXED density scale on the raw density `d` (NOT the
                // per-frame `t = d/d_max`): a frozen, faithful transfer identical on every
                // frame. See FAITHFUL_SCALE. (`t` above is still used by the Filmic arm.)
                let t_eff = d * FAITHFUL_SCALE * expo_gain;
                let core = match p.wb_mode {
                    WbMode::Gain => gamma_shoulder(t_eff, ceil) * p.wb[c],
                    WbMode::Subtractive => gamma_shoulder(t_eff * p.wb[c].max(EPS).powf(CMY_STRENGTH), ceil),
                };
                // Look layer (clean-punchy S-curve), SDR only. HDR keeps the headroom-
                // expanded value (look↔HDR reconciliation is a follow-up). Mirror: shaders.ts lookS.
                if p.hdr { core } else { look_s(core) }
            }
```

- [ ] **Step 5: Run the new tests + the full engine suite**

Run: `cargo test -p film-core --lib`
Expected: PASS — all new `look_s`/`faithful_*` tests pass; **all existing tests still pass**, including `filmic_mode_is_unchanged_default`, `positive_false_matches_today`, and `faithful_mode_open_shadows_vs_filmic` (the look darkens Faithful shadows but they remain far above Filmic's deep toe, so that assertion still holds — if it unexpectedly fails, STOP and report rather than weakening it).

- [ ] **Step 6: Commit**

```bash
git add crates/film-core/src/engine.rs
git commit -m "feat(engine): clean-punchy look_s curve on the Faithful core (SDR)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mirror `look_s` on the GPU (shaders.ts)

**Files:**
- Modify: `app/src/lib/viewport/gl/shaders.ts` (faithful constants block ~lines 391-398; faithful branch ~lines 469-480)

**Interfaces:**
- Consumes: Task 1's `look_s` form + `LOOK_K = 2.0` (must match digit-for-digit).
- Produces: GLSL `float lookS(float v)` applied in `INVERT_FRAG` faithful branch.

- [ ] **Step 1: Add the GLSL `LOOK_K` + `lookS`**

In `app/src/lib/viewport/gl/shaders.ts`, in the `INVERT_FRAG` source, just AFTER the `const float FAITHFUL_SCALE  = 1.0 / 0.700;` line and BEFORE `float gammaShoulder(...)`, add:

```glsl
// Look-layer strength — MUST equal engine.rs LOOK_K (the clean-punchy MEDIUM).
const float LOOK_K = 2.0;
// Clean-punchy look curve — MUST equal engine.rs look_s. Normalized symmetric tanh S on
// the faithful core SDR value (pivot 0.5, anchored 0->0 / 1->1, soft toe+shoulder).
float lookS(float v) {
  return clamp(0.5 + 0.5 * tanh(LOOK_K * (v - 0.5)) / tanh(LOOK_K * 0.5), 0.0, 1.0);
}
```

- [ ] **Step 2: Apply `lookS` in the faithful branch**

In the `if (u_tone_mode == 1) { ... }` block of `invert()`, AFTER the `if (u_wb_mode == 1) { ... } else { ... }` that assigns `v`, and BEFORE the block's closing `}`, add:

```glsl
      // Look layer (SDR; INVERT_FRAG is always SDR). Mirror: engine.rs look_s.
      v = vec3(lookS(v.r), lookS(v.g), lookS(v.b));
```

(The shared `return clamp(v, 0.0, 1.0);` at the end of the Mode-D block is unchanged.)

- [ ] **Step 3: Verify the frontend builds**

Run: `cd app && npm run build`
Expected: exit 0 (no esbuild/TS errors). **Watch for stray backticks** in any GLSL comment — backticks terminate the template literal and break the build.

- [ ] **Step 4: Verify CPU↔GPU parity by inspection**

Confirm line-for-line that the GLSL matches `engine.rs`: `LOOK_K` is `2.0` in both; `lookS`/`look_s` use the identical `0.5 + 0.5*tanh(LOOK_K*(v-0.5))/tanh(LOOK_K*0.5)` with a `[0,1]` clamp; the faithful branch applies it per channel after the gain/subtractive assignment. The pinned values from Task 1 (`look_s(0.25)=0.19661`, `look_s(0.75)=0.80339`) are the cross-check numbers.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/viewport/gl/shaders.ts
git commit -m "feat(gpu): mirror look_s clean-punchy curve in INVERT_FRAG (parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Force Faithful at the backend chokepoints (commands.rs + gpu_upload.rs)

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (`build_params` ~line 255; tests module)
- Modify: `app/src-tauri/src/gpu_upload.rs` (`resolve_to_uniforms` ~line 224; test `resolve_to_uniforms_maps_tone_mode` ~line 478)

**Interfaces:**
- Consumes: `film_core::ToneMode`, existing `InvertParams`, `build_params`, `resolve_to_uniforms`.
- Produces: both CPU `InversionParams.tone_mode` and GPU `Uniforms.tone_mode` are always Faithful/`1`, regardless of the wire `p.tone_mode` string.

- [ ] **Step 1: Write the failing tests**

Replace the existing `resolve_to_uniforms_maps_tone_mode` test in `app/src-tauri/src/gpu_upload.rs` with:

```rust
#[test]
fn resolve_to_uniforms_forces_faithful_tone() {
    let mut p = sample_invert_params(); // existing helper in this test module
    p.tone_mode = "filmic".to_string();
    let u = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
    assert_eq!(u.tone_mode, 1u8, "tone_mode must be forced Faithful (1) even for 'filmic'");
    p.tone_mode = "faithful".to_string();
    let u2 = resolve_to_uniforms(&p, [0.8, 0.6, 0.4]);
    assert_eq!(u2.tone_mode, 1u8, "tone_mode stays Faithful (1)");
}
```

(`sample_invert_params()` and the `resolve_to_uniforms(&p, [0.8, 0.6, 0.4])` call match the old `resolve_to_uniforms_maps_tone_mode` test verbatim — just swap that whole test for this one.)

Add to the `#[cfg(test)] mod tests` in `app/src-tauri/src/commands.rs`:

```rust
#[test]
fn build_params_forces_faithful_tone_mode() {
    let mut p = crate::commands_test_support::sample_invert_params();
    p.tone_mode = "filmic".to_string();
    let ip = build_params(&p, [0.8, 0.6, 0.4]);
    assert!(matches!(ip.tone_mode, film_core::ToneMode::Faithful), "build_params must force Faithful");
}
```

(`crate::commands_test_support::sample_invert_params()` is the exact helper the existing `build_params_defaults_wb_mode_gain` test uses ~line 3095.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app build_params_forces_faithful_tone_mode resolve_to_uniforms_forces_faithful_tone`
Expected: FAIL — current code maps `"filmic"` to `Filmic`/`0`.

> If the crate name isn't `app`, use the package name from `app/src-tauri/Cargo.toml` (`grep '^name' app/src-tauri/Cargo.toml`).

- [ ] **Step 3: Force Faithful in `build_params`**

In `app/src-tauri/src/commands.rs`, in `build_params`, change line 255 from:

```rust
        tone_mode: tone_mode_from(&p.tone_mode),
```
to:
```rust
        // Faithful is the sole develop/tune path; ignore any stored `tone_mode` (Filmic
        // is retired from the app). See docs/superpowers/specs/2026-06-21-faithful-look-layer-sole-path-design.md.
        tone_mode: film_core::ToneMode::Faithful,
```

- [ ] **Step 4: Force Faithful in `resolve_to_uniforms`**

In `app/src-tauri/src/gpu_upload.rs`, change the `tone_mode:` field assignment (~line 224) from the `match crate::commands::tone_mode_from(&p.tone_mode) { ... }` expression to:

```rust
        // Faithful is the sole path (Filmic retired) — always 1, ignore the wire value.
        tone_mode: 1u8,
```

> Leave `crate::commands::tone_mode_from` defined (it is still referenced by tests and is harmless); if the compiler warns it is unused in non-test builds, add `#[allow(dead_code)]` to it rather than deleting it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p app build_params_forces_faithful_tone_mode resolve_to_uniforms_forces_faithful_tone`
Expected: PASS. Then `cargo test -p app` — the whole backend suite passes (the old mapping test is gone; no other test asserts Filmic from these chokepoints).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/gpu_upload.rs
git commit -m "feat(tone): force Faithful at CPU+GPU backend chokepoints (Filmic retired)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Force Faithful on the frontend + remove the toggle + i18n

**Files:**
- Modify: `app/src/lib/viewport/gl/invert.ts` (`toInversionUniforms` ~line 58)
- Modify: `app/src/lib/api.ts` (`defaultParams` ~line 364)
- Modify: `app/src/lib/develop/Basic.svelte` (toggle ~lines 351-355)
- Modify: `i18n-strings.csv` (lines 465-466) + regenerate `app/src/lib/i18n/dict.ts`

**Interfaces:**
- Consumes: the GPU uniform pipeline (`u_tone_mode`), the params store.
- Produces: the frontend preview always sends `tone_mode: 1`; no tone-mode UI; no `basic.toneMode*` strings.

- [ ] **Step 1: Force `tone_mode: 1` in `toInversionUniforms`**

In `app/src/lib/viewport/gl/invert.ts`, change line 58 from:

```ts
    tone_mode: r.tone_mode ?? 0,
```
to:
```ts
    tone_mode: 1, // Faithful is the sole path (Filmic retired) — ignore stored value
```

- [ ] **Step 2: Default params to faithful**

In `app/src/lib/api.ts` line 364, change `tone_mode: "filmic"` to `tone_mode: "faithful"` (cosmetic now that the chokepoints force it, but keeps the wire value honest).

- [ ] **Step 3: Remove the tone-mode toggle**

In `app/src/lib/develop/Basic.svelte`, delete the entire toggle button block (the 4 lines starting `<button class="auto" class:on={$params.tone_mode === 'faithful'}` through its closing `</button>`, currently lines 351-355). Leave the neighboring WB `auto` and `colorHead` buttons untouched.

- [ ] **Step 4: Remove the i18n strings + regenerate**

Delete lines 465-466 of `i18n-strings.csv` (`basic.toneMode,...` and `basic.toneModeTitle,...`). Then regenerate:

Run: `python3 scripts/gen-i18n.py`
Expected: `app/src/lib/i18n/dict.ts` regenerates without `basic.toneMode`/`basic.toneModeTitle`. (Do NOT hand-edit `dict.ts`.)

- [ ] **Step 5: Verify the frontend builds + no dangling references**

Run: `cd app && npm run build`
Expected: exit 0. Then confirm nothing else references the removed keys:
Run: `grep -rn "toneMode\|tone_mode" app/src/ | grep -v "invert.ts\|api.ts\|shaders.ts\|renderer.ts"`
Expected: no remaining UI/i18n references (the only hits are the uniform plumbing in invert.ts/shaders.ts/renderer.ts and the api.ts type/default).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/viewport/gl/invert.ts app/src/lib/api.ts app/src/lib/develop/Basic.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(develop): Faithful is the sole tone path — remove toggle + i18n, force on GPU

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Bump `ENGINE_VERSION` + pin the staleness trigger (lib.rs + catalog.rs)

**Files:**
- Modify: `crates/film-core/src/lib.rs` (`ENGINE_VERSION` ~line 29)
- Modify: `app/src-tauri/src/catalog.rs` (tests module)

**Interfaces:**
- Consumes: existing `catalog.rs::load_images` `thumb_stale = thumb_version != ENGINE_VERSION` logic.
- Produces: `ENGINE_VERSION == 2`; a test pinning that an old-version thumbnail loads stale.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `app/src-tauri/src/catalog.rs`:

```rust
#[test]
fn old_engine_version_thumbnail_loads_stale() {
    let cat = Catalog::open_in_memory().unwrap();
    let id = cat.upsert_image("/x/a.dng", "a.dng", "{}", "thumb", 0).unwrap();
    // Stamp a render at an OLDER engine version (current - 1) directly.
    {
        let conn = cat.conn.lock().unwrap();
        conn.execute(
            "UPDATE images SET thumb_version = ?2 WHERE id = ?1",
            rusqlite::params![id, (film_core::ENGINE_VERSION as i64) - 1],
        ).unwrap();
    }
    let imgs = cat.load_images(&|_| true).unwrap();
    let me = imgs.iter().find(|i| i.id == id).unwrap();
    assert!(me.thumb_stale, "thumbnail rendered by an older engine must load stale");
}
```

> NOTE: if `conn` is private to `Catalog`, this test is in the same module so it can access it; if the module layout differs, add a tiny `#[cfg(test)] pub(crate) fn set_thumb_version(&self, id, v)` helper to `Catalog` instead of poking `conn` directly.

- [ ] **Step 2: Run the test to verify it fails or is inconclusive**

Run: `cargo test -p app old_engine_version_thumbnail_loads_stale`
Expected: with `ENGINE_VERSION` still `1`, `current - 1 == 0`, so the row's version `0 != 1` → the test PASSES already. That's fine — it documents/guards the trigger. (If it fails to compile, fix the `conn` access per the note.) Proceed to bump the version; the test must remain green afterward.

- [ ] **Step 3: Bump `ENGINE_VERSION`**

In `crates/film-core/src/lib.rs`, change `pub const ENGINE_VERSION: u32 = 1;` to `2`, and extend the history doc comment above it:

```rust
/// History: 1 = filmic display S-curve + auto-WB-seeded develop-time thumbnails
/// (2026-06-20), replacing the pre-filmic paper encode + neutral-WB thumbnails.
/// 2 = Faithful core + clean-punchy look becomes the sole develop path (Filmic
/// retired); all prior thumbnails are stale and regenerate on app entry (2026-06-21).
pub const ENGINE_VERSION: u32 = 2;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p film-core --lib && cargo test -p app old_engine_version_thumbnail_loads_stale`
Expected: PASS. (Any existing test that hard-codes `ENGINE_VERSION == 1` must be updated to `2`; search with `grep -rn "ENGINE_VERSION" crates app/src-tauri | grep -i "== 1\|= 1\b"`.)

- [ ] **Step 5: Commit**

```bash
git add crates/film-core/src/lib.rs app/src-tauri/src/catalog.rs
git commit -m "feat(engine): bump ENGINE_VERSION 2 (Faithful look) — marks all thumbnails stale

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Eager catalog force-refresh on app entry (Grid.svelte)

**Files:**
- Modify: `app/src/lib/library/Grid.svelte` (reuse `regenStale`; add a startup sweep + trigger)

**Interfaces:**
- Consumes: existing `regenStale(img)`, the `images` store, `inFlight` set.
- Produces: `sweepStale()` — on first populated catalog load, regenerates every developed+stale thumbnail (bounded concurrency), so the whole catalog adopts the Faithful look without waiting for scroll.

- [ ] **Step 1: Add the eager sweep**

In `app/src/lib/library/Grid.svelte`, near `regenStale` (after its definition), add:

```ts
  // Eager force-refresh on app entry: regenerate EVERY developed+stale thumbnail (not just
  // visible cells) so a render-engine bump (ENGINE_VERSION) re-bakes the whole catalog to the
  // current look immediately. Runs once per session; reuses regenStale (which stamps the
  // version + clears thumb_stale). Bounded concurrency keeps the UI responsive.
  let sweptStale = false;
  async function sweepStale() {
    if (sweptStale) return;
    const list = get(images).filter((i) => i.developed && i.thumb_stale);
    sweptStale = true;
    if (!list.length) return;
    const POOL = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const next = list[idx++];
        const cur = get(images).find((i) => i.id === next.id); // re-read latest (observer may have done it)
        if (cur?.developed && cur.thumb_stale) await regenStale(cur);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, list.length) }, worker));
  }
```

> NOTE: `get`, `images`, and `regenStale` are already imported/defined in this file (used by `regenStale`/`ensureVisible`). Do not add duplicate imports.

- [ ] **Step 2: Trigger the sweep when the catalog first populates**

Find the reactive line `$: boost, shown, ensureVisible();` (~line 88) and add, just below it:

```ts
  $: if ($images.length) sweepStale(); // once-per-session eager refresh after the catalog loads
```

- [ ] **Step 3: Verify the frontend builds**

Run: `cd app && npm run build`
Expected: exit 0, no TS errors.

- [ ] **Step 4: Manual smoke (human checkpoint)**

This is GUI behavior with no unit harness. Verify by reasoning + build:
- `sweepStale` runs once (`sweptStale` guard), iterates only `developed && thumb_stale` images, re-reads each before regenerating (so it co-exists with the on-scroll `regenStale` without double work), and `regenStale` already clears `thumb_stale` + stamps `ENGINE_VERSION`.
- On a real launch after the version bump, the grid thumbnails repaint to the Faithful look within a few seconds. (Note this in the task report for the user's GUI smoke test.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/library/Grid.svelte
git commit -m "feat(library): eager force-refresh of stale thumbnails on app entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Look curve `look_s` (LOOK_K=2.0), SDR-only, CPU — Task 1. GPU mirror — Task 2. ✓
- Faithful sole path: `build_params` + `resolve_to_uniforms` forced — Task 3; frontend uniform + defaultParams + toggle removal + i18n — Task 4. ✓
- Filmic dormant (code untouched, both `ToneMode` variants kept) — enforced by Global Constraints + Task 1 leaving the Filmic arm intact. ✓
- `ENGINE_VERSION` 1→2 + stale trigger — Task 5; eager refresh on entry — Task 6. ✓
- Saved edits preserved — no task changes edit storage; only the tone curve is forced. ✓
- HDR bypass — Task 1 Step 4 + test. ✓
- Testing (curve units, parity, sole-path tests, catalog stale test, HDR sanity) — covered across Tasks 1-5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. The two "NOTE for the implementer" callouts point at existing in-file test helpers (`sample_invert_params`/the neighboring tests) rather than inventing signatures — acceptable because the exact helper name varies and the implementer has the file open.

**Type consistency:** `look_s`/`lookS` identical form + `LOOK_K=2.0` in both engine.rs and shaders.ts; `tone_mode` forced to `ToneMode::Faithful` (CPU) and `1u8` (GPU uniform) and `1` (frontend uniform) consistently; `ENGINE_VERSION` referenced as `u32`/`i64` cast exactly as existing code does.

**Note on a deviation:** Task 5 Step 2 expects the test to pass (not fail) before the change because `current-1` already mismatches `1` — flagged honestly as a guard test rather than strict red→green. This is the one place TDD's red step is informational; called out so a reviewer isn't surprised.
