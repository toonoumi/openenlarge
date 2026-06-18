<!-- app/src/lib/tabs/Roll.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { developedFolderImages } from "$lib/export/eligible";
  import { editsById, cropById, images, setActive, rollOverwriteSkip, module } from "$lib/store";
  import { rollReferenceId, resetRollDraft, rollDraft } from "$lib/roll/draft";
  import RollAdjust from "$lib/roll/RollAdjust.svelte";
  import { applyToneColorToAll, framesWithToneColor, framesWithCrop, framesWithBase, framesWithWhitePoint } from "$lib/roll/apply";
  import { livePreviewParams, draftThumbView } from "$lib/roll/livePreview";
  import { withEffectiveBase } from "$lib/develop/base";
  import { imageDir } from "$lib/library/folderScope";
  import { api, defaultParams } from "$lib/api";
  import { debounce } from "$lib/catalog";
  import FramePreview from "$lib/roll/FramePreview.svelte";
  import ConfirmOverwrite from "$lib/roll/ConfirmOverwrite.svelte";
  import { exportContactSheet } from "$lib/roll/exportSheet";

  // Entry gate: enabled after confirm (or if no conflicts / skip-pref set).
  let mirrorEnabled = false;
  let showEntryConfirm = false;
  let entryConflictCount = 0;

  // Fresh roll draft each time the section opens (seed from defaults per spec).
  onMount(() => {
    resetRollDraft();

    // Compute conflicts: union of frames with any edits across the developed folder.
    const frames = get(developedFolderImages);
    const ids = frames.map((f) => f.id);
    const edits = get(editsById);
    const crops = get(cropById);

    const conflictSet = new Set<string>([
      ...framesWithToneColor(edits, ids),
      ...framesWithCrop(crops, ids),
      ...framesWithBase(edits, ids),
      ...framesWithWhitePoint(edits, ids),
    ]);
    const count = conflictSet.size;

    if (count > 0 && !get(rollOverwriteSkip)) {
      entryConflictCount = count;
      showEntryConfirm = true;
      // Do NOT enable mirroring yet — wait for confirm.
    } else {
      mirrorEnabled = true;
    }
  });

  function onEntryConfirm(e: CustomEvent<{ dontAsk: boolean }>) {
    if (e.detail?.dontAsk) rollOverwriteSkip.set(true);
    showEntryConfirm = false;
    mirrorEnabled = true;
  }

  function onEntryCancel() {
    showEntryConfirm = false;
    module.set("library");
  }

  function openFrame(id: string) {
    setActive(id);
    rollReferenceId.set(id);
  }

  // --- Live apply -------------------------------------------------------------
  // Component-local map of id → data-URL for draft-look thumbnails (shown in the grid).
  let previewMap: Record<string, string> = {};
  // Monotonically increasing token; used to discard stale async batches.
  let previewToken = 0;

  const editsEntry = (id: string) => get(editsById)[id] ?? defaultParams();

  let destroyed = false;
  onDestroy(() => { destroyed = true; });

  const scheduleLiveApply = debounce(async (draft: typeof $rollDraft) => {
    const token = ++previewToken;
    const frames = get(developedFolderImages);
    const ids = frames.map((f) => f.id);
    const view = draftThumbView(draft.crop);
    const next: Record<string, string> = {};

    await Promise.all(
      frames.map(async (frame) => {
        // Merge: tone/color from draft onto frame's own base/dmax, then also
        // apply draft base_override and d_max_override if set (so re-picking base
        // refreshes thumbnails immediately, even before R5 persistence).
        const merged = livePreviewParams(draft.params, editsEntry(frame.id));
        const params = withEffectiveBase(
          {
            ...merged,
            ...(draft.params.base_override != null ? { base_override: draft.params.base_override } : {}),
            ...(draft.params.d_max_override != null ? { d_max_override: draft.params.d_max_override } : {}),
          },
          imageDir(frame),
        );
        const dataUrl = await api.thumbnail(frame.id, params, view);
        if (previewToken !== token) return; // stale — newer batch started
        next[frame.id] = dataUrl;
      }),
    );

    if (previewToken !== token || destroyed) return;

    // Commit: update previewMap for the grid, write look into editsById, save thumbnails.
    previewMap = next;

    // Write tone/color look into every frame's edits (persisted automatically via write-through).
    editsById.set(applyToneColorToAll(get(editsById), ids, draft.params));

    // Persist thumbnail for each frame.
    for (const id of ids) {
      if (next[id]) {
        images.update((xs) => xs.map((i) => i.id === id ? { ...i, thumbnail: next[id] } : i));
        api.saveThumbnail(id, next[id]);
      }
    }
  }, 250);

  // Mirror every rollDraft change (tone/color/base/dmax/crop) to all frames,
  // but only once mirroring has been enabled (after entry confirm or no conflicts).
  $: if (mirrorEnabled) scheduleLiveApply($rollDraft);
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
    <button class="export-btn" on:click={exportContactSheet} disabled={$developedFolderImages.length === 0}>
      {$t('roll.export.button')}
    </button>
  </aside>
</div>

{#if $rollReferenceId}
  <FramePreview />
{/if}

{#if showEntryConfirm}
  <ConfirmOverwrite count={entryConflictCount} on:confirm={onEntryConfirm} on:cancel={onEntryCancel} />
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
  .export-btn { padding: 8px 16px; border-radius: 9px; font-weight: 600; font-size: 12px;
    background: var(--glass-hi); border: 1px solid var(--glass-brd); color: var(--text);
    transition: background 0.15s, border-color 0.15s; cursor: pointer; }
  .export-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  .export-btn:disabled { opacity: 0.45; cursor: default; }
</style>
