<!-- app/src/lib/tabs/Roll.svelte -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "$lib/i18n";
  import { developedFolderImages } from "$lib/export/eligible";
  import { setActive } from "$lib/store";
  import { rollReferenceId, resetRollDraft } from "$lib/roll/draft";

  // Fresh roll draft each time the section opens (seed from defaults per spec).
  onMount(() => { resetRollDraft(); });

  function openFrame(id: string) {
    setActive(id);
    rollReferenceId.set(id);
  }
</script>

<div class="roll">
  <div class="sheet">
    {#if $developedFolderImages.length === 0}
      <div class="empty">{$t('roll.empty')}</div>
    {:else}
      <div class="grid">
        {#each $developedFolderImages as img (img.id)}
          <button class="cell" data-id={img.id} on:click={() => openFrame(img.id)}>
            <div class="ratio"><img src={img.thumbnail} alt={img.file_name} draggable="false" /></div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if $rollReferenceId}
  <!-- FramePreview added in Task 9; placeholder keeps the shell compilable. -->
{/if}

<style>
  .roll { height: 100%; min-height: 0; display: flex; }
  .sheet { flex: 1; overflow-y: auto; padding: 8px; }
  .grid { display: grid; gap: 12px; align-content: start;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .cell { display: block; padding: 0; border: 1px solid var(--glass-brd); border-radius: 11px;
    overflow: hidden; background: #0d0d10; cursor: pointer; transition: box-shadow 0.12s; }
  .cell:hover { box-shadow: 0 12px 26px rgba(0,0,0,0.5); }
  .ratio { position: relative; width: 100%; height: 0; padding-bottom: 75%; }
  .ratio img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
  .empty { color: var(--text-faint); padding: 16px; }
</style>
