<script lang="ts">
  import { images, activeId, selectedFolder, gridZoom } from "../store";
  $: shown = $images.filter((i) => {
    const dir = i.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return dir === $selectedFolder;
  });
  $: colW = 130 + ($gridZoom / 100) * 230; // 130–360px column width

  // ctrl/cmd + scroll (and trackpad pinch, which arrives as a ctrl-wheel) resize
  // the thumbnails; plain scroll keeps scrolling the view.
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
  <div class="scroll" on:wheel={onWheel}>
    <div class="masonry" style="column-width:{colW}px">
      {#each shown as img (img.id)}
        <button class="cell" class:sel={$activeId === img.id} on:click={() => activeId.set(img.id)}>
          <img src={img.thumbnail} alt={img.file_name} />
        </button>
      {/each}
    </div>
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
  .scroll { flex: 1; overflow-y: auto; padding-right: 4px; }
  /* masonry: full-frame thumbnails (natural aspect, no crop) flowing in columns */
  .masonry { column-gap: 12px; }
  .cell { display: block; width: 100%; padding: 0; margin: 0 0 12px; break-inside: avoid;
    -webkit-column-break-inside: avoid; border: 1px solid var(--glass-brd); border-radius: 11px;
    overflow: hidden; background: #111; cursor: pointer; transition: box-shadow 0.12s; }
  .cell:hover { box-shadow: 0 10px 24px rgba(0,0,0,0.5); }
  .cell.sel { box-shadow: 0 0 0 2px var(--accent), 0 10px 24px rgba(0,0,0,0.5); }
  .cell img { width: 100%; height: auto; display: block; }
  .empty { color: var(--text-faint); padding: 16px; }
</style>
