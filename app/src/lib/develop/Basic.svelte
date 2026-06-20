<script lang="ts">
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { params, activeId, images, folderBaseByPath, baseSampling, sampledBase, sampledDmax, whitePointPinned, preReanalyze, developProgress } from "../store";
  import { api, defaultParams } from "../api";
  import { autoBrightnessRoll } from "../workflow";
  import { reseedActive, commitActive } from "./historyStore";
  import { createSeedGuard } from "./seedGuard";
  import { withEffectiveBase } from "./base";
  import { imageDir } from "../library/folderScope";
  import Icon from "../icons/Icon.svelte";
  import HelpDot from "./HelpDot.svelte";
  import Slider from "./Slider.svelte";
  import { TEMP_GRADIENT, TINT_GRADIENT, SAT_GRADIENT, signed, ev, relKelvin } from "./gradients";
  import { slide } from "svelte/transition";
  import { cubicInOut } from "svelte/easing";

  // Gray-point WB picker: parent (Develop) arms the viewport crosshair and routes the
  // sampled pixel; this component only toggles it and reflects the active state.
  export let onWbPick: (() => void) | null = null;
  export let wbPicking = false;
  /** Jump the viewport to 100% (1:1) so resolution-dependent effects (Texture)
   *  preview truthfully — at fit the proxy can't show the real result. Wired by
   *  Develop to the Viewport's zoomTo100(). */
  export let onViewActual: (() => void) | null = null;
  // The persistent normalized image crop [x,y,w,h] (null = full frame). Analysis
  // (base / D_max / WB) runs against this so black scan borders don't skew it.
  export let imageCrop: [number, number, number, number] | null = null;
  // Orientation/straighten of the active image. The crop is expressed in oriented
  // space, so analysis must apply the same geometry before sampling (a horizontal
  // flip otherwise re-analyzes the wrong region and shifts brightness).
  export let geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {};

  let open = true;

  $: activeImg = $images.find((i) => i.id === $activeId);
  $: dir = activeImg ? imageDir(activeImg) : "";

  // The backend auto-detects a film base per developed image. Surface it so the
  // swatch isn't empty when nothing is manually set (the "auto" scope).
  // Mirror crates/film-core/src/calibrate.rs REBATE_CONFIDENCE (keep in sync).
  const REBATE_CONF_UI = 0.12;
  let autoBase: { base: [number, number, number]; confidence: number } | null = null;
  // Only the (image, developed-state) pair should drive a refetch. `activeImg` gets a
  // fresh object reference on every `images` mutation (e.g. the live thumbnail write-back
  // in Develop.svelte), so keying the reactive on the object alone refetches constantly —
  // and since the auto base wobbles between develops, that re-arms the WB auto-seed guard
  // (effBase changes → new key) into an unbounded seed→params→thumbnail→images→base loop.
  let autoBaseKey = "";
  async function loadAutoBase(id: string | null, developed?: boolean) {
    const key = `${id ?? ""}|${developed ? 1 : 0}`;
    if (key === autoBaseKey) return; // unrelated `images` churn — base is unchanged
    autoBaseKey = key;
    if (!id) { autoBase = null; return; }
    try { autoBase = await api.autoBaseInfo(id); }
    catch { autoBase = null; autoBaseKey = ""; } // not developed yet — allow a retry
  }
  // `activeImg?.developed` is a pure reactive trigger: on the first develop of a
  // not-yet-developed image it flips false->true and re-fetches so the swatch fills.
  $: loadAutoBase($activeId, activeImg?.developed);

  $: effBase = $params.base_override ?? (dir ? $folderBaseByPath[dir] : null) ?? autoBase?.base ?? null;

  // Reset any in-progress sampling when the active image changes.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  $: { $activeId; sampledBase.set(null); baseSampling.set(false); sampledDmax.set(null); preReanalyze.set(null); }
  // 8-bit swatch preview of a linear base (display gamma ~1/2.2).
  const baseCss = (b: [number, number, number] | null) =>
    b ? `rgb(${b.map((v) => Math.round(255 * Math.min(1, Math.max(0, v ** (1 / 2.2))))).join(",")})` : "transparent";
  // Hint to repoint only when the base actually in use is the auto one and its
  // detection confidence is low (no override / folder base to mask it).
  $: lowConfBase =
    !$params.base_override && !(dir && $folderBaseByPath[dir]) &&
    autoBase != null && autoBase.confidence < REBATE_CONF_UI;

  // Tapping the swatch arms the rebate picker (BaseView overlay on the negative).
  function toggleRecalibrate() { baseSampling.update((v) => !v); }

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

  // Apply a freshly measured white-point D_max (from the Tone-section picker in the
  // parent viewport): pin it, override, reseed WB. Handed off via the sampledDmax store.
  function applyWhitePointDmax(d: number) {
    const id = get(activeId); if (!id) { sampledDmax.set(null); return; }
    setPinned(id, true);
    params.update((p) => ({ ...p, d_max_override: d }));
    commitActive();
    autoWb();
    sampledDmax.set(null);
  }
  $: if ($sampledDmax != null) applyWhitePointDmax($sampledDmax);

  // Picking a point auto-applies that base to the ACTIVE image; commitActive puts it
  // in the Cmd+Z / Cmd+Shift+Z undo scope (replacing the old apply / reset buttons).
  function applyBaseThisImage() {
    const s = get(sampledBase);
    if (!s) return;
    params.update((p) => ({ ...p, base_override: s }));
    commitActive();
    sampledBase.set(null); baseSampling.set(false);
  }
  $: if ($sampledBase) applyBaseThisImage();

  // Seed Temp/Tint from the estimated as-shot white point when the image OR the
  // film profile changes (or the effective base changes). The estimate runs
  // against the effective base and stock/mode, so switching a profile or
  // applying a roll calibration re-balances to the correct neutral point.
  // Guard remembers every (image, profile, base) it has seeded — not just the
  // last — so revisiting an image never re-runs the auto seed and clobbers the
  // manual Temp/Tint the user set on it. `force` (Auto button) re-seeds anyway.
  const shouldSeed = createSeedGuard();
  async function seed(id: string | null, stock: string, baseKey: string, force = false) {
    // A deliberate WB (gray-point pick) is sticky: don't let the base/profile-change
    // auto-reseed clobber it. The Auto button (force) overrides and re-takes control.
    if (!force && get(params).wb_manual) return;
    const key = id ? `${id}:${stock}:${baseKey}` : null;
    if (!shouldSeed(key, force)) return;
    try {
      const wb = await api.asShotWb(id!, withEffectiveBase(get(params), dir), imageCrop, geom);
      params.update((p) => ({ ...p, temp: wb.temp, tint: wb.tint, wb_manual: false }));
      // Auto-exposure on initial develop: fold a highlight-preserving exposure into the
      // baseline (after WB, so it measures the balanced positive) the first time a frame
      // is shown — so a fresh inversion opens at a sensible brightness, like auto-WB.
      await seedExposure(id!);
      reseedActive();
    } catch { /* not developed yet */ }
  }
  $: seed($activeId, $params.stock, JSON.stringify(effBase));

  // One-shot-per-image auto-exposure. Only runs while exposure is untouched (default),
  // so it never clobbers a saved or hand-set value; marked seen only on success so a
  // not-yet-developed frame retries on the next seed pass. Folded into the baseline by
  // seed()'s reseedActive — it's part of the initial look, not a separate undo step.
  const expSeeded = new Set<string>();
  async function seedExposure(id: string) {
    if (expSeeded.has(id)) return;
    if (get(params).exposure !== defaultParams().exposure) { expSeeded.add(id); return; }
    const { exposure } = await api.autoBrightness(id, withEffectiveBase(get(params), dir), imageCrop, geom);
    params.update((p) => ({ ...p, exposure }));
    expSeeded.add(id);
  }

  function autoWb() { seed($activeId, $params.stock, JSON.stringify(effBase), true); }

  // Auto brightness (this image): solve the exposure that lands bright content on a
  // balanced target via the highlight-preserving filmic curve, then commit it as a
  // deliberate, undoable look change. Each image measures its own — see whole-roll below.
  async function autoBrightness() {
    const id = $activeId;
    if (!id) return;
    try {
      const { exposure } = await api.autoBrightness(id, withEffectiveBase(get(params), dir), imageCrop, geom);
      params.update((p) => ({ ...p, exposure }));
      commitActive();
    } catch { /* not developed yet */ }
  }
  // Auto brightness across every developed frame in the roll (per-image values).
  function autoBrightnessAll() {
    if ($developProgress.active) return;
    autoBrightnessRoll();
  }

  // As-shot neutral baseline for the Temp readout. Temp is shown as a relative ±
  // offset from this point (feedback I2: absolute Kelvin is meaningless to the user).
  // Tracked independently of seed() so the readout is correct even on images that
  // were already seeded earlier (or where WB is sticky/manual) — the baseline is the
  // auto white point, not the user's current setting. Re-fetched when the image or
  // the effective base changes (both move the neutral point).
  let tempBaseline = 5500;
  let baselineKey = "";
  async function loadBaseline(id: string | null, baseKey: string) {
    if (!id) { tempBaseline = 5500; baselineKey = ""; return; }
    const key = `${id}:${baseKey}`;
    if (key === baselineKey) return;
    baselineKey = key;
    try {
      const wb = await api.asShotWb(id, withEffectiveBase(get(params), dir), imageCrop, geom);
      tempBaseline = wb.temp;
    } catch { baselineKey = ""; /* not developed yet — allow a retry */ }
  }
  $: loadBaseline($activeId, JSON.stringify(effBase));

  // ---- Crop-aware D_max analysis ----
  // Derive D_max from the image area (the persistent crop) and apply it to THIS
  // image, then reseed WB so the white point matches the new dynamic range.
  async function reanalyze(pinnedAtStart?: boolean) {
    const id = get(activeId); if (!id) return;
    // Snapshot the pre-reanalyze state so this is always one-click revertible (B3).
    // `pinnedAtStart` lets a caller record the pin as it was BEFORE the caller
    // mutated it (manualReanalyze unpins first); defaults to the live pin state.
    preReanalyze.set({ id, d_max_override: get(params).d_max_override ?? null, pinned: pinnedAtStart ?? isPinned(id) });
    try {
      const { d_max } = await api.analyze(id, withEffectiveBase(get(params), dir), imageCrop, geom);
      params.update((p) => ({ ...p, d_max_override: d_max }));
      commitActive();
      autoWb();
    } catch { preReanalyze.set(null); /* not developed yet */ }
  }
  // Restore the d_max_override + pin captured before the last re-analyze (B3).
  function revertReanalyze() {
    const snap = get(preReanalyze); if (!snap) return;
    const id = get(activeId);
    if (id && id === snap.id) {
      setPinned(id, snap.pinned);
      params.update((p) => ({ ...p, d_max_override: snap.d_max_override }));
      commitActive();
    }
    preReanalyze.set(null);
  }
  function manualReanalyze() {
    const id = get(activeId);
    // Capture the real pin state before unpinning, so revert restores the
    // true pre-reanalyze state (B3) rather than the just-cleared pin.
    const wasPinned = !!id && isPinned(id);
    if (id) setPinned(id, false);
    reanalyze(wasPinned);
  }

  // Re-derive D_max only when the crop CHANGES on the current image — not on image
  // switch (the stored develop-time d_max already covers that). Switching no longer
  // recomputes analysis or adds an undo step.
  let lastCrop = { id: "", key: "", orient: "" };
  $: {
    const id = $activeId ?? "";
    const key = JSON.stringify(imageCrop);
    // rot90 / flips / straighten merely RE-ORIENT the same pixels, so D_max (and the
    // WB re-seed reanalyze() does) must not move. Rotating the crop rect changes
    // `imageCrop`, which previously refit the white point and visibly brightened the
    // frame ("exposure jumps on rotate"). Re-derive ONLY when the crop's coverage
    // changes (resize/move) WITHOUT a reorientation.
    const orient = `${geom.rot90 ?? 0}|${geom.flip_h ? 1 : 0}|${geom.flip_v ? 1 : 0}|${geom.angle ?? 0}`;
    if (id && id === lastCrop.id && key !== lastCrop.key && orient === lastCrop.orient && !isPinned(id)) {
      reanalyze();
    }
    lastCrop = { id, key, orient };
  }

  // A user drag of Temp/Tint makes WB user-controlled (sticky vs the base-change
  // auto-reseed). Fires only on real input events, not programmatic seed updates.
  function markWbManual() {
    params.update((p) => (p.wb_manual ? p : { ...p, wb_manual: true }));
  }

  // Reset every Basic-section control to its default, leaving all other develop
  // state (mode, base_override, black/gamma, tone curve, color grading) untouched.
  // Temp/Tint are re-seeded to the as-shot white point rather than the hard
  // slider defaults, matching the Auto button.
  function resetBasic() {
    const d = defaultParams();
    params.update((p) => ({
      ...p,
      stock: d.stock,
      exposure: d.exposure, brightness: d.brightness,
      contrast: d.contrast, highlights: d.highlights, shadows: d.shadows,
      whites: d.whites, blacks: d.blacks,
      texture: d.texture, vibrance: d.vibrance, saturation: d.saturation,
    }));
    autoWb();
  }

  // Flip this image between negative (Cineon inversion) and positive (passthrough).
  // Re-renders live; analysis (base/D_max) already ran at develop time so the flip
  // is instant in both directions. Undoable.
  function togglePositive() {
    params.update((p) => ({ ...p, positive: !p.positive }));
    commitActive();
  }
</script>

<div class="section">
  <div class="head">
    <button class="toggle" on:click={() => (open = !open)}>
      <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      <span>{$t('basic.title')}</span>
    </button>
    <span class="headbtns">
      <button class="hdrtoggle" class:on={$params.hdr}
              title={$t('basic.hdrTitle')} aria-pressed={$params.hdr}
              on:click={() => { params.update((p) => ({ ...p, hdr: !p.hdr })); commitActive(); }}>
        {$t('basic.hdr')}
      </button>
      <button class="reset" on:click={resetBasic}>{$t('basic.reset')}</button>
    </span>
  </div>

  {#if open}
    <div class="body" transition:slide={{ duration: 280, easing: cubicInOut }}>
      <!-- Inverse: always available; flips negative↔positive for this image. -->
      <button class="recal inverse" on:click={togglePositive}>{$t('basic.inverseBtn')}</button>

      <!-- Inversion-specific controls only apply to negatives. -->
      {#if !$params.positive}
        <!-- Crop re-analysis (re-derive D_max + WB from the current crop) -->
        <button class="recal reanalyze" on:click={manualReanalyze}>{$t('base.reanalyze')}</button>
        {#if $preReanalyze && $preReanalyze.id === $activeId}
          <button class="recal revert" on:click={revertReanalyze}>{$t('base.revertReanalyze')}</button>
        {/if}

        <!-- Film Base: tap the swatch to pick the rebate; the pick auto-applies to this image -->
        <div class="sub">{$t('base.title')}</div>
        <button class="baseswatch" class:on={$baseSampling} on:click={toggleRecalibrate}
                title={$t('base.recalibrate')} aria-label={$t('base.recalibrate')}>
          <span class="cube big" style="background:{baseCss(effBase)}"></span>
          <span class="pick"><Icon name="pipette" size={18} /></span>
        </button>
        {#if lowConfBase}
          <p class="lowconf">{$t('base.lowConfidence')}</p>
        {/if}
      {/if}

      <!-- White Balance -->
      <div class="sub">{$t('basic.whiteBalance')}</div>
      <div class="wbhead">
        <span>{$t('basic.tempTint')}</span>
        <span class="wbbtns">
          <!-- Manual white-point picker: target/crosshair icon (distinct from the
               Auto WB button so the two are no longer confused). -->
          <button class="wbdrop" class:on={wbPicking} title={$t('basic.grayPick')}
                  aria-label={$t('basic.grayPick')} on:click={() => onWbPick?.()}>
            <Icon name="target" size={14} />
          </button>
          <HelpDot text={$t('basic.grayPickHelp')} />
          <!-- One-click Auto WB (Lightroom-style): sparkles + label, calls as_shot_wb. -->
          <button class="auto autowb" title={$t('basic.autoWbTitle')} on:click={autoWb}>
            <Icon name="sparkles" size={12} />{$t('basic.auto')}
          </button>
          <button class="auto" class:on={$params.wb_mode === 'subtractive'}
                  title={$t('basic.colorHeadTitle')} aria-pressed={$params.wb_mode === 'subtractive'}
                  on:click={() => { params.update((p) => ({ ...p, wb_mode: p.wb_mode === 'subtractive' ? 'gain' : 'subtractive' })); commitActive(); }}>
            {$t('basic.colorHead')}
          </button>
        </span>
      </div>
      <!-- Temp: tightened film range (2800–10000 K) on the reciprocal track so the
           thumb isn't hyper-sensitive, shown as a relative ± offset from the as-shot
           neutral. Tint: range trimmed to ±100 and stepped finely (0.1) to kill the
           banding a coarse 1-unit step produced across a sweep (I2). -->
      <Slider label={$t('basic.temp')} min={2800} max={10000} step={0.5} scale="reciprocal" scrubStep={10}
        bind:value={$params.temp} def={tempBaseline} gradient={TEMP_GRADIENT} format={(v) => relKelvin(v - tempBaseline)} on:input={markWbManual} />
      <Slider label={$t('basic.tint')} min={-100} max={100} step={0.1}
        bind:value={$params.tint} def={0} gradient={TINT_GRADIENT} format={signed} on:input={markWbManual} />

      <!-- Tone -->
      <div class="sub tonehead">
        <span>{$t('basic.tone')}</span>
        <span class="wbbtns">
          <!-- Auto brightness: solves a highlight-preserving exposure. Sparkles = this
               image; "roll" = every developed frame, each with its own value. -->
          <button class="auto" title={$t('basic.autoBrightnessTitle')} on:click={autoBrightness}>
            <Icon name="sun" size={12} />{$t('basic.auto')}
          </button>
          <button class="auto roll" title={$t('basic.autoBrightnessAllTitle')}
                  on:click={autoBrightnessAll} disabled={$developProgress.active}>
            {$t('basic.autoBrightnessAll')}
          </button>
        </span>
      </div>
      <Slider label={$t('basic.exposure')} min={-5} max={5} step={0.01} bind:value={$params.exposure} def={0} format={ev} />
      <Slider label={$t('basic.brightness')} min={-100} max={100} bind:value={$params.brightness} def={0} format={signed} />
      <Slider label={$t('basic.contrast')} min={-100} max={100} bind:value={$params.contrast} def={0} format={signed} />
      <Slider label={$t('basic.highlights')} min={-100} max={100} bind:value={$params.highlights} def={0} format={signed} />
      <Slider label={$t('basic.shadows')} min={-100} max={100} bind:value={$params.shadows} def={0} format={signed} />
      <Slider label={$t('basic.whites')} min={-100} max={100} bind:value={$params.whites} def={0} format={signed} />
      <Slider label={$t('basic.blacks')} min={-100} max={100} bind:value={$params.blacks} def={0} format={signed} />

      <!-- Presence -->
      <div class="wbhead">
        <span>{$t('basic.presence')}</span>
        <span class="wbbtns">
          <button class="auto" title={$t('basic.textureHint')} on:click={() => onViewActual?.()}>{$t('basic.textureViewActual')}</button>
          <HelpDot text={$t('basic.textureHint')} />
        </span>
      </div>
      <Slider label={$t('basic.texture')} min={-100} max={100} bind:value={$params.texture} def={0} format={signed} />
      <Slider label={$t('basic.vibrance')} min={-100} max={100} bind:value={$params.vibrance} def={0} gradient={SAT_GRADIENT} format={signed} />
      <Slider label={$t('basic.saturation')} min={-100} max={100} bind:value={$params.saturation} def={0} gradient={SAT_GRADIENT} format={signed} />
    </div>
  {/if}
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { display: flex; align-items: center; justify-content: space-between;
    width: 100%; padding: 4px 0; }
  .toggle { display: flex; align-items: center; gap: 6px;
    background: transparent; border: 0; color: var(--text); font-weight: 600;
    padding: 0; cursor: pointer; }
  .reset { background: transparent; border: 1px solid var(--glass-brd); color: var(--text-dim);
    border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .headbtns { display: inline-flex; align-items: center; gap: 6px; }
  .hdrtoggle { background: transparent; border: 1px solid var(--glass-brd); color: var(--text-dim);
    border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; font-weight: 600; }
  .hdrtoggle.on { color: #fff; border-color: var(--accent); background: rgba(244,157,78,0.18); }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 12px 0 4px; }
  .wbhead { display: flex; justify-content: space-between; align-items: center;
    font-size: 11px; color: var(--text-dim); margin: 4px 0; }
  .auto { background: transparent; border: 1px solid var(--glass-brd); color: var(--text-dim);
    border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  /* Auto WB: icon + label, accent on hover so it reads as the primary one-click action. */
  .autowb { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 6px; }
  .autowb:hover { color: var(--text); border-color: var(--accent); background: rgba(244,157,78,0.12); }
  /* Toggle-on state for .auto buttons (e.g. color-head toggle). */
  .auto.on { color: #fff; border-color: var(--accent); background: rgba(244,157,78,0.18); }
  .wbbtns { display: inline-flex; align-items: center; gap: 6px; }
  /* Tone header carries the Auto-brightness buttons; .sub gives the label its caps,
     so the buttons opt out of the inherited uppercase/tracking. */
  .tonehead { display: flex; justify-content: space-between; align-items: center; }
  .tonehead .auto { display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px 2px 6px; text-transform: none; letter-spacing: 0; }
  .tonehead .auto:hover { color: var(--text); border-color: var(--accent);
    background: rgba(244,157,78,0.12); }
  .tonehead .auto[disabled] { opacity: 0.5; cursor: default; }
  .wbdrop { display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: 1px solid var(--glass-brd); color: var(--text-dim);
    border-radius: 6px; padding: 2px 6px; cursor: pointer; }
  .wbdrop.on { color: var(--text); border-color: var(--accent); }

  /* Film Base */
  .cube { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--glass-brd);
    flex: none; }
  /* Full-width rectangle swatch — match the re-analysis button's radius + height. */
  .cube.big { width: 100%; height: 30px; border-radius: 8px; box-sizing: border-box; }
  /* The swatch IS the picker: hover (or armed) reveals the pipette overlay.
     7px vertical margin matches the slider rhythm so spacing aligns with others. */
  .baseswatch { position: relative; display: flex; width: 100%; padding: 0; border: 0;
    background: transparent; cursor: pointer; margin: 7px 0; }
  .baseswatch .pick { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: #fff; background: rgba(0,0,0,0.4); border-radius: 8px;
    opacity: 0; transition: opacity 120ms; }
  .baseswatch:hover .pick, .baseswatch.on .pick { opacity: 1; }
  .baseswatch.on .cube.big { box-shadow: 0 0 0 2px rgba(244,157,78,0.7); }
  .recal { width: 100%; padding: 7px; border-radius: 8px; font-size: 12px; cursor: pointer;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text); margin-bottom: 8px;
    transition: border-color 120ms, background 120ms; }
  .recal:hover { border-color: var(--accent); background: rgba(244,157,78,0.12); }
  /* Crop re-analysis sits at the top of the panel — breathing room above + below. */
  .reanalyze { margin: 14px 0 16px; }
  .lowconf { font-size: 11px; color: rgba(244,157,78,0.9); margin: 6px 0 0; }
  /* Inverse button sits at the top of the panel — breathing room above. */
  .inverse { margin-top: 14px; }
</style>
