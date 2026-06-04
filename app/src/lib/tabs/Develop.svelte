<script lang="ts">
  import { save } from "@tauri-apps/plugin-dialog";
  import { activeId, params, images, tool } from "../store";
  import { api } from "../api";
  import Filmstrip from "../panels/Filmstrip.svelte";
  import Viewport from "../viewport/Viewport.svelte";
  import QualityMenu from "../viewport/QualityMenu.svelte";
  import Histogram from "../viewport/Histogram.svelte";
  import Toolbar from "../develop/Toolbar.svelte";
  import Basic from "../develop/Basic.svelte";
  import GlassPanel from "../glass/GlassPanel.svelte";

  $: active = $images.find((i) => i.id === $activeId);

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
    try { await api.exportImage($activeId, $params, out); msg = "Exported ✓"; }
    catch (e) { msg = "Error: " + e; }
    exporting = false;
  }
</script>

<div class="layout" on:contextmenu={onContext}>
  <section class="center">
    {#if active?.developed}
      <Viewport id={$activeId} params={$params}
                imgW={active.metadata.width} imgH={active.metadata.height} />
    {:else}<div class="hint">Not developed yet</div>{/if}
  </section>

  <aside class="right">
    <GlassPanel>
      <Histogram />
      <Toolbar />
      {#if $tool === "edit"}
        <Basic />
      {:else if $tool === "crop"}
        <div class="placeholder">Crop — coming in Plan 2</div>
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
  .placeholder { color: var(--text-dim); font-size: 12px; padding: 20px 0; text-align: center; }
  .export { width: 100%; margin-top: 12px; padding: 10px; border: 0; border-radius: 10px;
    background: var(--accent); color: white; font-weight: 600; cursor: pointer; }
  .export:disabled { opacity: 0.5; }
  .msg { margin-top: 8px; color: var(--text-dim); font-size: 12px; }
</style>
