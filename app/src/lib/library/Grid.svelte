<script lang="ts">
  import { images, activeId, selectedFolder, gridZoom } from "../store";
  $: shown = $images.filter((i) => {
    const dir = i.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return dir === $selectedFolder;
  });
  $: minCol = 120 + ($gridZoom / 100) * 220;

  // ctrl/cmd + scroll (and trackpad pinch, which arrives as a ctrl-wheel) resize
  // the thumbnails; plain scroll keeps scrolling the grid.
  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      gridZoom.update((z) => Math.max(0, Math.min(100, z - e.deltaY * 0.5)));
    }
  }
</script>

<div class="center">
  <div class="head">
    <div class="where"><b>{$selectedFolder?.split("/").pop() ?? "—"}</b> · {shown.length} image{shown.length === 1 ? "" : "s"}</div>
    <div class="right">Thumb size <input class="zoom" type="range" min="0" max="100" bind:value={$gridZoom} /></div>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax({minCol}px,1fr))" on:wheel={onWheel}>
    {#each shown as img (img.id)}
      <button class="cell" class:sel={$activeId === img.id} on:click={() => activeId.set(img.id)}>
        <div class="ratio"><img src={img.thumbnail} alt={img.file_name} /></div>
      </button>
    {/each}
    {#if shown.length === 0}<div class="empty">Select a folder with images</div>{/if}
  </div>
</div>

<style>
  .center { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { display: flex; align-items: center; gap: 12px; padding: 2px 4px 12px; }
  .where { color: var(--text-dim); } .where b { color: var(--text); }
  .right { margin-left: auto; display: flex; align-items: center; gap: 9px; color: var(--text-faint); font-size: 12px; }
  .zoom { appearance: none; width: 120px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.14); outline: 0; }
  .zoom::-webkit-slider-thumb { appearance: none; width: 13px; height: 13px; border-radius: 50%; background: var(--accent); }
  .grid { flex: 1; overflow: auto; display: grid; gap: 12px; align-content: start; padding-right: 4px; }
  .cell { display: block; padding: 0; border: 1px solid var(--glass-brd); border-radius: 11px;
    overflow: hidden; background: #111; cursor: pointer; transition: transform 0.12s, box-shadow 0.12s; }
  .cell:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(0,0,0,0.5); }
  .cell.sel { box-shadow: 0 0 0 2px var(--accent), 0 12px 26px rgba(0,0,0,0.5); }
  /* reliable 3:2 box (aspect-ratio on grid items is flaky in the webview) */
  .ratio { position: relative; width: 100%; height: 0; padding-bottom: 66.67%; }
  .ratio img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .empty { color: var(--text-faint); padding: 16px; }
</style>
