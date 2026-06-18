<!-- app/src/lib/tabs/Roll.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { developedFolderImages } from "$lib/export/eligible";
  import { editsById, images, setActive } from "$lib/store";
  import { rollReferenceId, resetRollDraft, rollDraft } from "$lib/roll/draft";
  import RollAdjust from "$lib/roll/RollAdjust.svelte";
  import ConfirmOverwrite from "$lib/roll/ConfirmOverwrite.svelte";
  import { framesWithToneColor, applyToneColorToAll } from "$lib/roll/apply";
  import { livePreviewParams, draftThumbView } from "$lib/roll/livePreview";
  import { withEffectiveBase } from "$lib/develop/base";
  import { imageDir } from "$lib/library/folderScope";
  import { api, defaultParams } from "$lib/api";
  import { debounce } from "$lib/catalog";
  import FramePreview from "$lib/roll/FramePreview.svelte";
  import { exportContactSheet } from "$lib/roll/exportSheet";

  // Fresh roll draft each time the section opens (seed from defaults per spec).
  onMount(() => { resetRollDraft(); });

  function openFrame(id: string) {
    setActive(id);
    rollReferenceId.set(id);
  }

  // --- Live preview -----------------------------------------------------------
  // Component-local map of id → data-URL for draft-look thumbnails.
  let previewMap: Record<string, string> = {};
  // Monotonically increasing token; used to discard stale async resolutions.
  let previewToken = 0;

  const editsEntry = (id: string) => get(editsById)[id] ?? defaultParams();

  let destroyed = false;
  onDestroy(() => { destroyed = true; });

  const scheduleLivePreview = debounce(async (draft: typeof $rollDraft) => {
    const token = ++previewToken;
    const frames = get(developedFolderImages);
    const view = draftThumbView(draft.crop);
    const next: Record<string, string> = {};

    await Promise.all(
      frames.map(async (frame) => {
        const params = withEffectiveBase(
          livePreviewParams(draft.params, editsEntry(frame.id)),
          imageDir(frame),
        );
        const dataUrl = await api.thumbnail(frame.id, params, view);
        if (previewToken !== token) return; // stale — newer batch started
        next[frame.id] = dataUrl;
      }),
    );

    if (previewToken === token && !destroyed) {
      previewMap = next;
    }
  }, 250);

  // Trigger live preview whenever rollDraft changes.
  $: scheduleLivePreview($rollDraft);

  // --- Apply look to roll -----------------------------------------------------
  let showConfirm = false;
  let confirmCount = 0;
  let applyIds: string[] = [];

  function applyLook() {
    editsById.set(applyToneColorToAll(get(editsById), applyIds, $rollDraft.params));
    // Write rendered draft thumbnails back into the images store and persist them.
    for (const id of applyIds) {
      if (previewMap[id]) {
        const thumb = previewMap[id];
        images.update((xs) => xs.map((i) => i.id === id ? { ...i, thumbnail: thumb } : i));
        api.saveThumbnail(id, thumb);
      }
    }
    showConfirm = false;
  }

  function onApplyClick() {
    applyIds = $developedFolderImages.map((i) => i.id);
    const conflicts = framesWithToneColor(get(editsById), applyIds);
    if (conflicts.length > 0) {
      confirmCount = conflicts.length;
      showConfirm = true;
    } else {
      applyLook();
    }
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
            <div class="ratio"><img src={previewMap[img.id] ?? img.thumbnail} alt={img.file_name} draggable="false" /></div>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <aside class="panel">
    <RollAdjust />
    <button class="apply-btn" on:click={onApplyClick}>
      {$t('roll.applyLook')}
    </button>
    <button class="export-btn" on:click={exportContactSheet} disabled={$developedFolderImages.length === 0}>
      {$t('roll.export.button')}
    </button>
  </aside>
</div>

{#if $rollReferenceId}
  <FramePreview />
{/if}

{#if showConfirm}
  <ConfirmOverwrite
    count={confirmCount}
    on:confirm={applyLook}
    on:cancel={() => { showConfirm = false; }}
  />
{/if}

<style>
  .roll { height: 100%; min-height: 0; display: grid; grid-template-columns: 1fr 320px; }
  .sheet { overflow-y: auto; padding: 0; background: #0d0d0f; }
  .grid { display: grid; gap: 0; align-content: start;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .cell { display: block; padding: 0; border: 0; border-right: 1px solid #222; border-bottom: 1px solid #222;
    border-radius: 0; overflow: hidden; background: #0d0d0f; cursor: pointer; transition: none; }
  .cell:hover { box-shadow: none; }
  .ratio { position: relative; width: 100%; height: 0; padding-bottom: 75%; }
  .ratio img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
  .empty { color: var(--text-faint); padding: 16px; }
  .panel { border-left: 1px solid var(--glass-brd); display: flex; flex-direction: column;
    gap: 8px; padding: 12px; overflow-y: auto; }
  .apply-btn { margin-top: auto; padding: 10px 16px; border-radius: 9px; border: 0;
    background: var(--accent-grad); color: white; font-weight: 600; cursor: pointer; }
  .export-btn { padding: 8px 16px; border-radius: 9px; font-weight: 600; font-size: 12px;
    background: var(--glass-hi); border: 1px solid var(--glass-brd); color: var(--text);
    transition: background 0.15s, border-color 0.15s; cursor: pointer; }
  .export-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  .export-btn:disabled { opacity: 0.45; cursor: default; }
</style>
