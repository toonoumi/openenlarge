<script lang="ts">
  import { tick } from "svelte";
  import { folderImages, activeId, selection, selectClick } from "../store";
  import { t } from "$lib/i18n";
  let stripEl: HTMLDivElement;

  const mods = (e: MouseEvent) => ({ meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });

  // Arrow-key navigation lives in Develop.svelte (window-level) so it works from
  // anywhere in Develop, not only when the strip is focused.

  // Keep the active image visible in the strip whenever selection changes
  // (from the strip, the grid, or arrow keys).
  async function revealActive() {
    await tick();
    if (stripEl && $activeId) {
      stripEl.querySelector(`[data-id="${$activeId}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }
  $: $activeId, revealActive();

  // The strip is a single horizontal row, but a vertical mouse wheel would otherwise
  // scroll an ancestor (or nothing) instead of the strip. Translate vertical wheel
  // delta into horizontal scroll so the wheel moves through the frames.
  function onWheel(e: WheelEvent) {
    if (!stripEl) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // trackpad horizontal already works
    const max = stripEl.scrollWidth - stripEl.clientWidth;
    if (max <= 0) return; // nothing to scroll
    e.preventDefault();
    stripEl.scrollLeft += e.deltaY;
  }
</script>

<div class="strip" bind:this={stripEl} role="listbox" aria-label={$t('filmstrip.importedImagesAria')} on:wheel|nonpassive={onWheel}>
  {#each $folderImages as img}
    <button data-id={img.id} class:active={$activeId === img.id}
      class:multi={$selection.selected.has(img.id)}
      on:click={(e) => selectClick(img.id, mods(e))}>
      <img src={img.thumbnail} alt={img.file_name} />
    </button>
  {/each}
</div>

<style>
  .strip { display: flex; gap: 8px; overflow-x: auto; padding: 6px; height: 100%; align-items: center; outline: none; }
  button { padding: 0; border: 1px solid var(--glass-brd); border-radius: 8px; background: none;
    flex: 0 0 auto; cursor: pointer; }
  button.multi { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  button.active { border-color: #fff; box-shadow: 0 0 0 1px #fff; }
  img { height: 64px; display: block; border-radius: 7px; }
</style>
