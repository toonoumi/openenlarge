<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { t } from "$lib/i18n";
  import { api, type InvertParams, type DustStroke, type IrRemoval, type ExportFormat } from "../api";
  import { autodustInstalled } from "../store";

  /** Everything needed to finish the full-res positive image for detection. */
  export let id: string | null;
  export let params: InvertParams;
  export let imageCrop: [number, number, number, number] | null = null;
  export let geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {};
  export let dust: DustStroke[] = [];
  export let irRemoval: IrRemoval = { enabled: false, sensitivity: 50 };
  /** Persisted per-image sensitivity (0..100). */
  export let sensitivity = 50;

  const dispatch = createEventDispatcher<{ sensitivity: number }>();

  let checking = true;
  let downloadBytes = 0;
  let downloading = false;
  let dlReceived = 0;
  let dlTotal = 0;

  let busy = false;
  let error = "";
  let result = ""; // preview data URL
  let count: number | null = null;

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

  async function detect() {
    if (!id) return;
    error = ""; busy = true;
    try {
      const r = await api.autodustDetect(id, params, imageCrop, geom, dust, irRemoval, sensitivity);
      result = r.previewDataUrl; count = r.count;
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }

  // Slider commits on `change` (not `input`): each run re-inpaints, so we debounce
  // to pointer-release. Persist the value, then re-run if we already have a result.
  function onSensitivity(v: number) {
    sensitivity = v;
    dispatch("sensitivity", v);
    if (result) detect();
  }

  async function saveResult() {
    const path = await save({
      filters: [{ name: "PNG", extensions: ["png"] }, { name: "TIFF", extensions: ["tiff"] }, { name: "JPEG", extensions: ["jpg"] }],
    });
    if (!path) return;
    const ext = path.split(".").pop()?.toLowerCase();
    const format: ExportFormat =
      ext === "tiff" || ext === "tif" ? { kind: "tiff", bitDepth: 16 }
      : ext === "jpg" || ext === "jpeg" ? { kind: "jpeg", quality: 92 }
      : { kind: "png", bitDepth: 16 };
    try { await api.saveUpscaled(path, format); }
    catch (e) { error = String(e); }
  }
</script>

<div class="section">
  <div class="head"><span>{$t("eraser.autoTitle")}</span><span class="exp">{$t("eraser.autoLocal")}</span></div>

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
    <button class="go" class:busy disabled={busy || !id} on:click={detect}>
      {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
      <span>{busy ? $t("eraser.autoWorking") : $t("eraser.autoButton")}</span>
    </button>

    <div class="sub">{$t("eraser.sensitivity")}</div>
    <div class="slrow">
      <input type="range" min="0" max="100" step="1" value={sensitivity}
             on:change={(e) => onSensitivity(+(e.target as HTMLInputElement).value)} />
      <span class="val">{Math.round(sensitivity)}</span>
    </div>

    {#if error}<div class="err">{error}</div>{/if}

    {#if result}
      <div class="result">
        <img src={result} alt={$t("eraser.autoTitle")} />
        {#if count !== null}<div class="dims">{$t("eraser.autoCount", { n: String(count) })}</div>{/if}
        <button class="row" on:click={saveResult}>{$t("eraser.autoSave")}</button>
      </div>
    {/if}
  {/if}

  <div class="hint">{$t("eraser.autoHint")}</div>
</div>

<style>
  .section { margin-bottom: 12px; }
  .head { display: flex; align-items: center; gap: 8px; color: var(--text); font-weight: 600; padding: 4px 0; }
  .exp { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid rgba(244,157,78,0.5); color: var(--accent); border-radius: 4px; padding: 0 5px; }
  .go { width: 100%; padding: 9px 10px; margin: 6px 0; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18); color: #fff; cursor: pointer; font-size: 13px; }
  .go:not(:disabled):hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
  .go:disabled { opacity: 0.55; cursor: default; }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bar { width: 100%; height: 6px; border-radius: 3px; background: var(--glass-hi); overflow: hidden; margin: 6px 0; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.2s ease; }
  .sub { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 12px 0 4px; }
  .slrow { display: flex; align-items: center; gap: 8px; }
  .slrow input[type="range"] { flex: 1; accent-color: var(--accent); }
  .val { font-size: 12px; color: var(--text); width: 44px; text-align: right;
    font-variant-numeric: tabular-nums; }
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
  .result { margin-top: 8px; }
  .result img { display: block; width: 100%; border: 1px solid var(--glass-brd); border-radius: 8px; }
  .dims { font-size: 11px; color: var(--text-dim); margin: 6px 0; text-align: center; }
  .row { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
