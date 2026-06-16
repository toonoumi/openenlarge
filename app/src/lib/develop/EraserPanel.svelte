<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { t } from "$lib/i18n";

  /** Brush radius normalized to image width (0.005..0.2). */
  export let brush: number;
  /** Whether the active image carries an IR plane (Plan B enables the toggle). */
  export let hasIr = false;
  export let irEnabled = false;
  export let irSensitivity = 50;
  /** AI-fill mode: strokes show as a red mask overlay until "AI erase" applies MI-GAN. */
  export let brushMigan = false;
  /** Whether the current strokes have been MI-GAN-applied (drives the button state). */
  export let aiApplied = false;
  /** Number of committed strokes (enables/disables the AI erase button). */
  export let strokeCount = 0;
  /** True while the MI-GAN erase bake is running. */
  export let aiBusy = false;

  const dispatch = createEventDispatcher<{
    reset: void; irEnabled: boolean; irSensitivity: number; brushMigan: boolean; aiErase: void;
  }>();
</script>

<div class="section">
  <div class="head"><span>{$t('eraser.title')}</span></div>

  {#if hasIr}
    <button class="ir on" class:active={irEnabled} aria-pressed={irEnabled}
            on:click={() => dispatch("irEnabled", !irEnabled)}>
      {$t('eraser.removeDustIr')} <span class="state">{irEnabled ? $t('eraser.on') : $t('eraser.off')}</span>
    </button>
    {#if irEnabled}
      <div class="sub">{$t('eraser.sensitivity')}</div>
      <div class="slrow">
        <input type="range" min="0" max="100" step="1" value={irSensitivity}
               on:input={(e) => dispatch("irSensitivity", +(e.target as HTMLInputElement).value)} />
        <span class="val">{Math.round(irSensitivity)}</span>
      </div>
    {/if}
  {:else}
    <span class="ir-wrap" title={$t('eraser.requiresIrChannel')}>
      <button class="ir" disabled>
        {$t('eraser.removeDustIr')} <span class="soon">{$t('eraser.soon')}</span>
      </button>
    </span>
  {/if}

  <div class="sub">{$t('eraser.brushSize')}</div>
  <div class="slrow">
    <input type="range" min="0.005" max="0.2" step="0.001" bind:value={brush} />
    <span class="val">{(brush * 100).toFixed(1)}%</span>
  </div>

  <button class="ir on" class:active={brushMigan} aria-pressed={brushMigan}
          title={$t('eraser.brushAiHelp')}
          on:click={() => dispatch("brushMigan", !brushMigan)}>
    {$t('eraser.brushAi')} <span class="state">{brushMigan ? $t('eraser.on') : $t('eraser.off')}</span>
  </button>

  {#if brushMigan}
    <button class="go" class:busy={aiBusy} disabled={aiBusy || strokeCount === 0 || aiApplied}
            on:click={() => dispatch("aiErase")}>
      {#if aiBusy}<span class="spinner" aria-hidden="true"></span>{/if}
      <span>{aiBusy ? $t('eraser.aiErasing') : $t('eraser.aiErase')}</span>
    </button>
  {/if}

  <button class="row" on:click={() => dispatch("reset")}>{$t('eraser.reset')}</button>
  <div class="hint">{brushMigan ? $t('eraser.aiMaskHint') : $t('eraser.hint')}</div>
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { color: var(--text); font-weight: 600; padding: 4px 0; }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 12px 0 4px; }
  .ir-wrap { display: block; width: 100%; }
  .ir { width: 100%; display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: default; opacity: 0.5; }
  .ir.on { cursor: pointer; opacity: 1; }
  .ir.on.active { background: rgba(244,157,78,0.18); border-color: rgba(244,157,78,0.5); }
  .go { width: 100%; margin: 6px 0; padding: 9px 10px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18); color: #fff;
    cursor: pointer; font-size: 13px; }
  .go:not(:disabled):hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
  .go:disabled { opacity: 0.55; cursor: default; }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .soon, .state { font-size: 10px; border: 1px solid var(--glass-brd); border-radius: 4px;
    padding: 0 5px; color: var(--text-dim); }
  .slrow { display: flex; align-items: center; gap: 8px; }
  .slrow input[type="range"] { flex: 1; accent-color: var(--accent); }
  .val { font-size: 12px; color: var(--text); width: 44px; text-align: right;
    font-variant-numeric: tabular-nums; }
  .row { width: 100%; display: flex; justify-content: space-between; align-items: center;
    padding: 7px 10px; margin: 6px 0; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
