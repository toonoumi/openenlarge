<script lang="ts">
  import { save } from "@tauri-apps/plugin-dialog";
  import { activeId, params, images, tool, cropById, activeCrop } from "../store";
  import { api } from "../api";
  import Filmstrip from "../panels/Filmstrip.svelte";
  import Viewport from "../viewport/Viewport.svelte";
  import QualityMenu from "../viewport/QualityMenu.svelte";
  import Histogram from "../viewport/Histogram.svelte";
  import Toolbar from "../develop/Toolbar.svelte";
  import Basic from "../develop/Basic.svelte";
  import GlassPanel from "../glass/GlassPanel.svelte";
  import CropView from "../crop/CropView.svelte";
  import CropPanel from "../crop/CropPanel.svelte";
  import type { Rect, CropRect } from "../crop/types";
  import { default80, conform } from "../crop/cropMath";
  import { effectiveRatio } from "../crop/presets";

  $: active = $images.find((i) => i.id === $activeId);
  $: origW = active?.metadata.width ?? 0;
  $: origH = active?.metadata.height ?? 0;
  $: nativeRatio = origH > 0 ? origW / origH : 1;

  $: committed = $activeCrop;
  $: effW = committed ? Math.max(1, Math.round(committed.rect.w * origW)) : origW;
  $: effH = committed ? Math.max(1, Math.round(committed.rect.h * origH)) : origH;
  $: imageCrop = committed
    ? [committed.rect.x, committed.rect.y, committed.rect.w, committed.rect.h] as [number, number, number, number]
    : null;

  let rect: Rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  let aspect = "original";
  let orientation: "landscape" | "portrait" = "landscape";
  let cropInit = false;

  function startCrop() {
    const c = $activeCrop;
    if (c) { rect = { ...c.rect }; aspect = c.aspect; orientation = c.orientation; }
    else { rect = default80(nativeRatio); aspect = "original"; orientation = nativeRatio >= 1 ? "landscape" : "portrait"; }
    cropInit = true;
  }
  function commitCrop() {
    const id = $activeId; if (!id || !cropInit) return;
    const c: CropRect = { rect, aspect, orientation };
    cropById.update((m) => ({ ...m, [id]: c }));
  }
  function discardCrop() {
    const c = $activeCrop;
    if (c) { rect = { ...c.rect }; aspect = c.aspect; orientation = c.orientation; }
    else { rect = default80(nativeRatio); aspect = "original"; }
  }
  function onPreset(id: string) {
    aspect = id;
    rect = conform(rect, effectiveRatio(id, nativeRatio, orientation));
  }
  function onSwap() {
    orientation = orientation === "landscape" ? "portrait" : "landscape";
    rect = conform(rect, effectiveRatio(aspect, nativeRatio, orientation));
  }
  function onReset() { rect = default80(nativeRatio); aspect = "original"; orientation = nativeRatio >= 1 ? "landscape" : "portrait"; }

  $: lockRatio = effectiveRatio(aspect, nativeRatio, orientation);

  let prevTool = $tool;
  $: {
    if ($tool === "crop" && prevTool !== "crop") startCrop();
    if ($tool !== "crop" && prevTool === "crop") { commitCrop(); cropInit = false; }
    prevTool = $tool;
  }

  function onKey(e: KeyboardEvent) {
    if ($tool !== "crop") return;
    if (e.key === "Enter") { commitCrop(); tool.set("edit"); }
    else if (e.key === "Escape") { discardCrop(); }
    else if (e.key === "x" || e.key === "X") { onSwap(); }
  }

  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshThumb() {
    if (thumbTimer) clearTimeout(thumbTimer);
    const id = $activeId;
    if (!id) return;
    thumbTimer = setTimeout(async () => {
      try {
        const t = await api.thumbnail(id, $params);
        images.update((xs) => xs.map((i) => (i.id === id ? { ...i, thumbnail: t } : i)));
      } catch { /* ignore */ }
    }, 400);
  }
  $: $params, $activeId, refreshThumb();

  let menu: { x: number; y: number } | null = null;
  function onContext(e: MouseEvent) { e.preventDefault(); menu = { x: e.clientX, y: e.clientY }; }

  let exporting = false, msg = "";
  async function exportTiff() {
    if (!$activeId) return;
    const out = await save({ defaultPath: "redroom-export.tiff", filters: [{ name: "TIFF", extensions: ["tiff"] }] });
    if (!out) return;
    exporting = true; msg = "";
    try { await api.exportImage($activeId, $params, out, imageCrop); msg = "Exported ✓"; }
    catch (e) { msg = "Error: " + e; }
    exporting = false;
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="layout" on:contextmenu={onContext}>
  <section class="center">
    {#if active?.developed}
      {#if $tool === "crop"}
        <CropView id={$activeId} params={$params} imgW={origW} imgH={origH}
                  bind:rect {lockRatio} on:custom={() => (aspect = "custom")} />
      {:else}
        <Viewport id={$activeId} params={$params} imgW={effW} imgH={effH} imageCrop={imageCrop} />
      {/if}
    {:else}<div class="hint">Not developed yet</div>{/if}
  </section>

  <aside class="right">
    <GlassPanel>
      <Histogram />
      <Toolbar />
      {#if $tool === "edit"}
        <Basic />
      {:else if $tool === "crop"}
        <CropPanel bind:aspect bind:orientation
                   on:preset={(e) => onPreset(e.detail)} on:swap={onSwap} on:reset={onReset} />
      {/if}
      <button class="export" on:click={exportTiff} disabled={exporting || !$activeId}>
        {exporting ? "Exporting…" : "Export 16-bit TIFF"}
      </button>
      {#if msg}<div class="msg">{msg}</div>{/if}
    </GlassPanel>
  </aside>

  <footer class="bottom"><Filmstrip /></footer>
</div>
{#if menu}<QualityMenu x={menu.x} y={menu.y} on:close={() => (menu = null)} />{/if}

<style>
  .layout { display: grid; height: 100%; gap: 12px;
    grid-template-columns: 1fr 300px; grid-template-rows: 1fr 88px;
    grid-template-areas: "center right" "bottom bottom"; }
  .right { grid-area: right; min-height: 0; overflow-y: auto; }
  .center { grid-area: center; min-height: 0; display: grid; place-items: center; }
  .hint { color: var(--text-dim); }
  .bottom { grid-area: bottom; }
  .export { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 10px;
    background: var(--accent); color: white; font-weight: 600; cursor: pointer; }
  .export:disabled { opacity: 0.5; }
  .msg { margin-top: 8px; color: var(--text-dim); font-size: 12px; }
</style>
