<script lang="ts">
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { params, activeId, images, folderBaseByPath, baseSampling, sampledBase } from "../store";
  import { api, defaultParams } from "../api";
  import { reseedActive, commitActive } from "./historyStore";
  import { createSeedGuard } from "./seedGuard";
  import { withEffectiveBase } from "./base";
  import { imageDir } from "../library/folderScope";
  import Icon from "../icons/Icon.svelte";
  import Slider from "./Slider.svelte";
  import { TEMP_GRADIENT, TINT_GRADIENT, SAT_GRADIENT, signed, ev, kelvin } from "./gradients";
  import { slide } from "svelte/transition";
  import { cubicInOut } from "svelte/easing";

  // Gray-point WB picker: parent (Develop) arms the viewport crosshair and routes the
  // sampled pixel; this component only toggles it and reflects the active state.
  export let onWbPick: (() => void) | null = null;
  export let wbPicking = false;
  // The persistent normalized image crop [x,y,w,h] (null = full frame). Analysis
  // (base / D_max / WB) runs against this so black scan borders don't skew it.
  export let imageCrop: [number, number, number, number] | null = null;

  let open = true;

  $: activeImg = $images.find((i) => i.id === $activeId);
  $: dir = activeImg ? imageDir(activeImg) : "";

  // The backend auto-detects a film base per developed image. Surface it so the
  // swatch isn't empty when nothing is manually set (the "auto" scope).
  // Mirror crates/film-core/src/calibrate.rs REBATE_CONFIDENCE (keep in sync).
  const REBATE_CONF_UI = 0.12;
  let autoBase: { base: [number, number, number]; confidence: number } | null = null;
  async function loadAutoBase(id: string | null, _developed?: boolean) {
    if (!id) { autoBase = null; return; }
    try { autoBase = await api.autoBaseInfo(id); }
    catch { autoBase = null; } // not developed yet
  }
  // `activeImg?.developed` is a pure reactive trigger: on the first develop of a
  // not-yet-developed image it flips false->true and re-fetches so the swatch fills.
  $: loadAutoBase($activeId, activeImg?.developed);

  $: effBase = $params.base_override ?? (dir ? $folderBaseByPath[dir] : null) ?? autoBase?.base ?? null;

  // Reset any in-progress sampling when the active image changes.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  $: { $activeId; sampledBase.set(null); baseSampling.set(false); }
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
      const wb = await api.asShotWb(id!, withEffectiveBase(get(params), dir), imageCrop);
      params.update((p) => ({ ...p, temp: wb.temp, tint: wb.tint, wb_manual: false }));
      reseedActive();
    } catch { /* not developed yet */ }
  }
  $: seed($activeId, $params.stock, JSON.stringify(effBase));

  function autoWb() { seed($activeId, $params.stock, JSON.stringify(effBase), true); }

  // ---- Crop-aware D_max analysis ----
  // Derive D_max from the image area (the persistent crop) and apply it to THIS
  // image, then reseed WB so the white point matches the new dynamic range.
  async function reanalyze() {
    const id = get(activeId); if (!id) return;
    try {
      const { d_max } = await api.analyze(id, withEffectiveBase(get(params), dir), imageCrop);
      params.update((p) => ({ ...p, d_max_override: d_max }));
      commitActive();
      autoWb();
    } catch { /* not developed yet */ }
  }

  // Re-derive D_max only when the crop CHANGES on the current image — not on image
  // switch (the stored develop-time d_max already covers that). Switching no longer
  // recomputes analysis or adds an undo step.
  let lastCrop = { id: "", key: "" };
  $: {
    const id = $activeId ?? "";
    const key = JSON.stringify(imageCrop);
    if (id && id === lastCrop.id && key !== lastCrop.key) {
      reanalyze();
    }
    lastCrop = { id, key };
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
      exposure: d.exposure,
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
        <button class="recal reanalyze" on:click={reanalyze}>{$t('base.reanalyze')}</button>

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
          <button class="wbdrop" class:on={wbPicking} title={$t('basic.grayPick')} on:click={() => onWbPick?.()}>
            <Icon name="pipette" size={14} />
          </button>
          <button class="auto" on:click={autoWb}>{$t('basic.auto')}</button>
        </span>
      </div>
      <Slider label={$t('basic.temp')} min={2000} max={50000} step={0.5} scale="reciprocal"
        bind:value={$params.temp} def={5500} gradient={TEMP_GRADIENT} format={kelvin} on:input={markWbManual} />
      <Slider label={$t('basic.tint')} min={-150} max={150} step={1}
        bind:value={$params.tint} def={0} gradient={TINT_GRADIENT} format={signed} on:input={markWbManual} />

      <!-- Tone -->
      <div class="sub">{$t('basic.tone')}</div>
      <Slider label={$t('basic.exposure')} min={-5} max={5} step={0.05} bind:value={$params.exposure} def={0} format={ev} />
      <Slider label={$t('basic.contrast')} min={-100} max={100} bind:value={$params.contrast} def={0} format={signed} />
      <Slider label={$t('basic.highlights')} min={-100} max={100} bind:value={$params.highlights} def={0} format={signed} />
      <Slider label={$t('basic.shadows')} min={-100} max={100} bind:value={$params.shadows} def={0} format={signed} />
      <Slider label={$t('basic.whites')} min={-100} max={100} bind:value={$params.whites} def={0} format={signed} />
      <Slider label={$t('basic.blacks')} min={-100} max={100} bind:value={$params.blacks} def={0} format={signed} />

      <!-- Presence -->
      <div class="sub">{$t('basic.presence')}</div>
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
  .wbbtns { display: inline-flex; align-items: center; gap: 6px; }
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
