<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { t } from "$lib/i18n";
  import { api } from "../api";
  import { autodustInstalled } from "../store";

  /** Image id — the toggle is disabled when nothing is loaded. */
  export let id: string | null;
  /** Whether AI auto-dust is on (live heal on the main display). */
  export let enabled = false;
  /** True while the heal bake is running (detector + MI-GAN can take many seconds). */
  export let busy = false;
  /** Persisted per-image sensitivity (0..100). */
  export let sensitivity = 50;

  const dispatch = createEventDispatcher<{ sensitivity: number; toggle: boolean }>();

  let checking = true;
  let downloadBytes = 0;
  let downloading = false;
  let dlReceived = 0;
  let dlTotal = 0;
  let error = "";

  let unlistenDl: UnlistenFn | null = null;

  $: mb = (downloadBytes / 1_000_000).toFixed(0);
  $: dlPct = Math.min(dlTotal ? (dlReceived / dlTotal) * 100 : 0, 100);

  onMount(async () => {
    unlistenDl = await listen<{ received: number; total: number }>(
      "autodust://download-progress", (e) => { dlReceived = e.payload.received; dlTotal = e.payload.total; });
    try {
      const s = await api.autodustStatus();
      $autodustInstalled = s.installed;
      downloadBytes = s.downloadBytes;
    } catch (e) { error = String(e); }
    checking = false;
  });
  onDestroy(() => { unlistenDl?.(); });

  async function download() {
    error = ""; downloading = true; dlReceived = 0; dlTotal = downloadBytes;
    try { await api.downloadAutodust(); $autodustInstalled = true; }
    catch (e) { error = String(e); }
    finally { downloading = false; }
  }

  // Slider commits on `change` (not `input`): each value re-bakes on the main
  // display, so debounce to pointer-release. Persist + emit; the viewport re-heals.
  function onSensitivity(v: number) {
    sensitivity = v;
    dispatch("sensitivity", v);
  }
  function toggle() {
    dispatch("toggle", !enabled);
  }
</script>

<div class="section">
  <div class="head">
    <span>{$t("eraser.autoTitle")}</span>
    <button type="button" class="help" aria-label={$t("eraser.autoHint")}>?<span class="tip">{$t("eraser.autoHint")}</span></button>
  </div>

  {#if checking}
    <div class="hint">{$t("eraser.autoChecking")}</div>
  {:else if !$autodustInstalled}
    <div class="hint">{$t("eraser.autoDownloadPrompt", { mb })}</div>
    {#if downloading}
      <div class="bar"><span style="width:{dlPct}%"></span></div>
    {:else}
      <button class="go" on:click={download}>{$t("eraser.autoDownload")}</button>
    {/if}
  {:else}
    <div class="sub">
      <span>{$t("eraser.sensitivity")}</span>
      <button type="button" class="help" aria-label={$t("eraser.autoSensitivityHelp")}>?<span class="tip">{$t("eraser.autoSensitivityHelp")}</span></button>
    </div>
    <div class="slrow">
      <input type="range" min="0" max="100" step="1" value={sensitivity}
             on:change={(e) => onSensitivity(+(e.target as HTMLInputElement).value)} />
      <span class="val">{Math.round(sensitivity)}</span>
    </div>

    <button class="go" class:active={enabled} class:busy disabled={!id || busy} on:click={toggle}>
      {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
      <span>{$t("eraser.autoButton")}</span>
    </button>
  {/if}

  {#if error}<div class="err">{error}</div>{/if}
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { position: relative; display: flex; align-items: center; gap: 8px; color: var(--text); font-weight: 600; padding: 4px 0; }
  /* "?" help chip with a hover/focus tooltip (replaces inline hint text). */
  .help { display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; padding: 0; border-radius: 50%;
    border: 1px solid var(--glass-brd); background: transparent;
    color: var(--text-dim); font-size: 10px; font-weight: 600; line-height: 1;
    cursor: help; user-select: none; }
  .help:hover, .help:focus-visible { color: var(--text); border-color: var(--accent); outline: none; }
  .tip { position: absolute; left: 0; top: calc(100% + 4px); width: 100%; z-index: 30;
    padding: 8px 10px; border-radius: 8px; background: var(--bg-1);
    border: 1px solid var(--glass-brd); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    color: var(--text-dim); font-size: 11px; font-weight: 400; line-height: 1.5;
    opacity: 0; visibility: hidden; transition: opacity 0.14s ease; pointer-events: none; }
  .help:hover .tip, .help:focus-visible .tip { opacity: 1; visibility: visible; }
  .go { width: 100%; padding: 9px 10px; margin: 6px 0; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18); color: #fff; cursor: pointer; font-size: 13px; }
  .go:not(:disabled):hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
  .go:disabled { opacity: 0.55; cursor: default; }
  /* Active = auto-dust toggled on (heal showing on the main display). */
  .go.active { background: rgba(244,157,78,0.34); border-color: rgba(244,157,78,0.85); }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bar { width: 100%; height: 6px; border-radius: 3px; background: var(--glass-hi); overflow: hidden; margin: 6px 0; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.2s ease; }
  .sub { position: relative; display: flex; align-items: center; gap: 6px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 12px 0 4px; }
  .slrow { display: flex; align-items: center; gap: 8px; }
  .slrow input[type="range"] { flex: 1; accent-color: var(--accent); }
  .val { font-size: 12px; color: var(--text); width: 44px; text-align: right;
    font-variant-numeric: tabular-nums; }
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
