<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { t } from "$lib/i18n";
  import { api, type InvertParams, type ExportFormat } from "../api";
  import { upscalerInstalled } from "../store";

  /** Everything needed to reproduce the export pixels for the active image. */
  export let id: string | null;
  export let params: InvertParams;
  export let imageCrop: [number, number, number, number] | null = null;
  export let geom: { rot90?: number; flip_h?: boolean; flip_v?: boolean; angle?: number } = {};
  /** Longest source side (px) so we can show target size + the >=8K notice. */
  export let sourceLong = 0;

  let checking = true;
  let downloadBytes = 0;
  let downloading = false;
  let dlReceived = 0;
  let dlTotal = 0;

  let busy = false;
  let progress = 0; // 0..1 during inference
  let error = "";
  let result = ""; // preview data URL
  let outW = 0, outH = 0;

  let unlistenDl: UnlistenFn | null = null;
  let unlistenUp: UnlistenFn | null = null;

  $: atOrAbove8k = sourceLong >= 8192;
  $: mb = (downloadBytes / 1_000_000).toFixed(0);
  $: dlPct = Math.min(dlTotal ? (dlReceived / dlTotal) * 100 : 0, 100);
  $: upPct = Math.min(progress * 100, 100);

  onMount(async () => {
    unlistenDl = await listen<{ received: number; total: number }>(
      "upscale://download-progress", (e) => { dlReceived = e.payload.received; dlTotal = e.payload.total; });
    unlistenUp = await listen<{ done: number; total: number }>(
      "upscale://progress", (e) => { progress = e.payload.total ? e.payload.done / e.payload.total : 0; });
    try {
      const s = await api.upscalerStatus();
      $upscalerInstalled = s.installed;
      downloadBytes = s.downloadBytes;
    } catch (e) { error = String(e); }
    checking = false;
  });
  onDestroy(() => { unlistenDl?.(); unlistenUp?.(); });

  async function download() {
    error = ""; downloading = true; dlReceived = 0; dlTotal = downloadBytes;
    try { await api.downloadUpscaler(); $upscalerInstalled = true; }
    catch (e) { error = String(e); }
    finally { downloading = false; }
  }

  async function upscale() {
    if (!id || atOrAbove8k) return;
    error = ""; result = ""; busy = true; progress = 0;
    try {
      const r = await api.upscaleImage(id, params, imageCrop, geom);
      result = r.previewDataUrl; outW = r.outW; outH = r.outH;
    } catch (e) { error = String(e); }
    finally { busy = false; }
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
  <div class="head"><span>{$t("upscale.title")}</span><span class="exp">{$t("upscale.local")}</span></div>

  {#if checking}
    <div class="hint">{$t("upscale.checking")}</div>
  {:else if !$upscalerInstalled}
    <div class="hint">{$t("upscale.downloadPrompt", { mb })}</div>
    {#if downloading}
      <div class="bar"><span style="width:{dlPct}%"></span></div>
    {:else}
      <button class="go" on:click={download}>{$t("upscale.download")}</button>
    {/if}
  {:else}
    {#if atOrAbove8k}
      <div class="hint">{$t("upscale.already8k")}</div>
    {:else}
      <button class="go" class:busy disabled={busy || !id} on:click={upscale}>
        {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
        <span>{busy ? $t("upscale.working") : $t("upscale.button")}</span>
      </button>
      {#if busy}<div class="bar"><span style="width:{upPct}%"></span></div>{/if}
    {/if}

    {#if error}<div class="err">{error}</div>{/if}

    {#if result}
      <div class="result">
        <img src={result} alt={$t("upscale.title")} />
        <div class="dims">{outW} × {outH}</div>
        <button class="row" on:click={saveResult}>{$t("upscale.save")}</button>
      </div>
    {/if}
  {/if}

  <div class="hint">{$t("upscale.hint")}</div>
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
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
  .result { margin-top: 8px; }
  .result img { display: block; width: 100%; border: 1px solid var(--glass-brd); border-radius: 8px; }
  .dims { font-size: 11px; color: var(--text-dim); margin: 6px 0; text-align: center; font-variant-numeric: tabular-nums; }
  .row { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--glass-brd);
    background: transparent; color: var(--text); cursor: pointer; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
</style>
