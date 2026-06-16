<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { save } from "@tauri-apps/plugin-dialog";
  import { t } from "$lib/i18n";
  import { api, type ExportFormat } from "../api";
  import { upscalerInstalled } from "../store";

  /** Runs the actual upscale for this control's source, at the chosen longest side. */
  export let run: (targetLong: number) => Promise<{ previewDataUrl: string; outW: number; outH: number }>;
  export let disabled = false;

  let target = 7680; // 8K default
  let checking = true;
  let downloadBytes = 0;
  let downloading = false;
  let dlReceived = 0;
  let dlTotal = 0;
  let busy = false;
  let progress = 0;
  let error = "";
  let result = "";
  let outW = 0, outH = 0;
  let unlistenDl: UnlistenFn | null = null;
  let unlistenUp: UnlistenFn | null = null;

  $: dlPct = Math.min(dlTotal ? (dlReceived / dlTotal) * 100 : 0, 100);
  $: upPct = Math.min(progress * 100, 100);

  onMount(async () => {
    unlistenDl = await listen<{ received: number; total: number }>(
      "upscale://download-progress", (e) => { dlReceived = e.payload.received; dlTotal = e.payload.total; });
    unlistenUp = await listen<{ done: number; total: number }>(
      "upscale://progress", (e) => { if (busy) progress = e.payload.total ? e.payload.done / e.payload.total : 0; });
    try { const s = await api.upscalerStatus(); $upscalerInstalled = s.installed; downloadBytes = s.downloadBytes; }
    catch (e) { error = String(e); }
    checking = false;
  });
  onDestroy(() => { unlistenDl?.(); unlistenUp?.(); });

  async function download() {
    error = ""; downloading = true; dlReceived = 0; dlTotal = downloadBytes;
    try { await api.downloadUpscaler(); $upscalerInstalled = true; }
    catch (e) { error = String(e); }
    finally { downloading = false; }
  }

  async function doUpscale() {
    error = ""; result = ""; busy = true; progress = 0;
    try { const r = await run(target); result = r.previewDataUrl; outW = r.outW; outH = r.outH; }
    catch (e) { error = String(e); }
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

<div class="up">
  {#if checking}
    <div class="hint">{$t("upscale.checking")}</div>
  {:else if !$upscalerInstalled}
    <div class="hint">{$t("upscale.downloadPrompt", { mb: (downloadBytes / 1_000_000).toFixed(0) })}</div>
    {#if downloading}
      <div class="bar"><span style="width:{dlPct}%"></span></div>
    {:else}
      <button class="btn" on:click={download}>{$t("upscale.download")}</button>
    {/if}
  {:else}
    <div class="seg">
      <button class:on={target === 3840} on:click={() => (target = 3840)}>{$t("upscale.res4k")}</button>
      <button class:on={target === 7680} on:click={() => (target = 7680)}>{$t("upscale.res8k")}</button>
    </div>
    <button class="btn go" class:busy disabled={busy || disabled} on:click={doUpscale}>
      {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
      <span>{busy ? $t("upscale.working") : $t("upscale.button")}</span>
    </button>
    {#if busy}<div class="bar"><span style="width:{upPct}%"></span></div>{/if}
    {#if result}
      <img class="preview" src={result} alt={$t("upscale.title")} />
      <div class="dims">{outW} × {outH}</div>
      <button class="btn" on:click={saveResult}>{$t("upscale.save")}</button>
    {/if}
  {/if}
  {#if error}<div class="err">{error}</div>{/if}
</div>

<style>
  .up { margin: 6px 0 0; }
  .hint { font-size: 11px; color: var(--text-dim); margin: 4px 0 6px; line-height: 1.4; }
  .seg { display: flex; gap: 6px; margin-bottom: 6px; }
  .seg button { flex: 1; padding: 6px; border-radius: 8px; font-size: 12px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text-dim); cursor: pointer; }
  .seg button.on { color: #fff; background: rgba(244,157,78,0.18); border-color: rgba(244,157,78,0.5); }
  .btn { width: 100%; padding: 8px 10px; margin: 4px 0; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text); cursor: pointer; font-size: 13px; }
  .btn:not(:disabled):hover { background: var(--glass-hi); }
  .btn.go { border-color: rgba(244,157,78,0.5); background: rgba(244,157,78,0.18); color: #fff; }
  .btn.go:not(:disabled):hover { background: rgba(244,157,78,0.30); }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .bar { width: 100%; height: 6px; border-radius: 3px; background: var(--glass-hi); overflow: hidden; margin: 6px 0; }
  .bar span { display: block; height: 100%; background: var(--accent); transition: width 0.2s ease; }
  .preview { display: block; width: 100%; margin-top: 8px; border: 1px solid var(--glass-brd); border-radius: 8px; }
  .dims { font-size: 11px; color: var(--text-dim); margin: 6px 0; text-align: center; font-variant-numeric: tabular-nums; }
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
</style>
