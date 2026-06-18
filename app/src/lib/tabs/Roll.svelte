<!-- app/src/lib/tabs/Roll.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { developedFolderImages } from "$lib/export/eligible";
  import { editsById, cropById, images, activeId, setActive, rollOverwriteSkip, module } from "$lib/store";
  import { rollReferenceId, resetRollDraft, rollDraft } from "$lib/roll/draft";
  import RollAdjust from "$lib/roll/RollAdjust.svelte";
  import { applyToneColorToAll, applyBaseToAll, applyWhitePointToAll, applyCropToAll, framesWithToneColor, framesWithCrop, framesWithBase, framesWithWhitePoint } from "$lib/roll/apply";
  import { livePreviewParams, draftThumbView } from "$lib/roll/livePreview";
  import { withEffectiveBase } from "$lib/develop/base";
  import { imageDir } from "$lib/library/folderScope";
  import { api, defaultParams } from "$lib/api";
  import { debounce } from "$lib/catalog";
  import FramePreview from "$lib/roll/FramePreview.svelte";
  import ConfirmOverwrite from "$lib/roll/ConfirmOverwrite.svelte";
  import { exportContactSheet } from "$lib/roll/exportSheet";
  import Viewport from "$lib/viewport/Viewport.svelte";
  import CropView from "$lib/crop/CropView.svelte";
  import CropPanel from "$lib/crop/CropPanel.svelte";
  import { orientDims, rotateRectCW, rotateRectCCW, flipRectH, flipRectV, flipOrient } from "$lib/crop/transforms";
  import { defaultFull, conform, constrainToRotated } from "$lib/crop/cropMath";
  import { presetNormAspect } from "$lib/crop/presets";
  import type { Rect, CropRect } from "$lib/crop/types";
  import { emptyDust } from "$lib/develop/dust";
  import { developRev, dustById } from "$lib/store";

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
    let nextEdits = applyToneColorToAll(get(editsById), ids, draft.params);
    // Also persist base/dmax overrides when set in the draft (no-ops until base/wp UI is added).
    if (draft.params.base_override != null) nextEdits = applyBaseToAll(nextEdits, ids, draft.params.base_override);
    if (draft.params.d_max_override != null) nextEdits = applyWhitePointToAll(nextEdits, ids, draft.params.d_max_override);
    editsById.set(nextEdits);

    // Persist crop to all frames when the draft has a crop set.
    if (draft.crop != null) cropById.set(applyCropToAll(get(cropById), ids, draft.crop));

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

  // --- Reference-edit mode (crop only for R5a) --------------------------------
  type EditMode = "none" | "crop";
  let editMode: EditMode = "none";
  let refId: string | null = null;

  // Reference frame metadata (for the crop state machine).
  $: refFrame = refId ? $images.find((i) => i.id === refId) ?? null : null;
  $: origW = refFrame?.metadata.width ?? 0;
  $: origH = refFrame?.metadata.height ?? 0;
  $: refDir = refFrame ? imageDir(refFrame) : "";

  // Reference frame's own committed crop (for the Viewport view).
  // In crop mode we show the draft crop, not the committed one.
  $: refCommitted = refId ? ($cropById[refId] ?? null) : null;
  $: cRot = editMode === "crop" ? rot90 : (refCommitted?.rot90 ?? 0);
  $: [coW, coH] = orientDims(origW, origH, cRot);
  $: effW = editMode === "crop"
    ? coW
    : (refCommitted ? Math.max(1, Math.round(refCommitted.rect.w * coW)) : coW);
  $: effH = editMode === "crop"
    ? coH
    : (refCommitted ? Math.max(1, Math.round(refCommitted.rect.h * coH)) : coH);
  $: imageCrop = (editMode !== "crop" && refCommitted)
    ? ([refCommitted.rect.x, refCommitted.rect.y, refCommitted.rect.w, refCommitted.rect.h] as [number, number, number, number])
    : null;

  // Reference frame render params: use its own stored edits + effective base.
  $: refFrameParams = refId ? ($editsById[refId] ?? defaultParams()) : defaultParams();
  $: refEffParams = withEffectiveBase(refFrameParams, refDir);

  // Reference frame dust edits (view-only in crop mode).
  $: refDust = refId ? ($dustById[refId] ?? emptyDust()) : emptyDust();

  // --- Crop state machine (ported from Develop.svelte lines 88-145) -----------
  let rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  let aspect = "original";
  let orientation: "landscape" | "portrait" = "landscape";
  let rot90 = 0, flipH = false, flipV = false, angle = 0;
  let cropInit = false;

  $: [oW, oH] = orientDims(origW, origH, rot90);
  $: orientedRatio = oH > 0 ? oW / oH : 1;
  $: lockRatio = presetNormAspect(aspect, orientedRatio, orientation);
  // Keep the crop inside the rotated image (constrainToRotated is idempotent → no loop).
  $: if (angle !== 0) rect = constrainToRotated(rect, angle, oW, oH);

  function startCrop() {
    // Seed from rollDraft crop (fall back to full frame).
    const c = $rollDraft.crop;
    if (c) {
      rect = { ...c.rect }; aspect = c.aspect; orientation = c.orientation;
      rot90 = c.rot90; flipH = c.flipH; flipV = c.flipV; angle = c.angle;
    } else {
      rect = defaultFull(); aspect = "original";
      orientation = origW >= origH ? "landscape" : "portrait";
      rot90 = 0; flipH = false; flipV = false; angle = 0;
    }
    cropInit = true;
  }

  function draftCrop(): CropRect {
    return { rect, aspect, orientation, rot90: rot90 as 0 | 1 | 2 | 3, flipH, flipV, angle };
  }

  function commitCropToDraft() {
    if (!cropInit) return;
    rollDraft.update((d) => ({ ...d, crop: draftCrop() }));
    // The live-apply mirror ($: if mirrorEnabled) will pick this up and call
    // applyCropToAll on the next scheduleLiveApply tick.
  }

  function onPreset(presetId: string) {
    aspect = presetId;
    rect = conform(rect, presetNormAspect(presetId, orientedRatio, orientation));
  }
  function onSwap() {
    orientation = orientation === "landscape" ? "portrait" : "landscape";
    rect = conform(rect, presetNormAspect(aspect, orientedRatio, orientation));
  }
  function onReset() {
    rect = defaultFull(); aspect = "original";
    orientation = origW >= origH ? "landscape" : "portrait";
    rot90 = 0; flipH = false; flipV = false; angle = 0;
  }
  function onRotate(dir: number) {
    if (dir > 0) { rot90 = (rot90 + 1) % 4; rect = rotateRectCW(rect); }
    else { rot90 = (rot90 + 3) % 4; rect = rotateRectCCW(rect); }
  }
  function onFlip(axis: "h" | "v") {
    ({ rot90, flipH, flipV } = flipOrient({ rot90, flipH, flipV }, axis));
    rect = axis === "h" ? flipRectH(rect) : flipRectV(rect);
    angle = -angle;
  }
  function onStraighten(v: number) { angle = Math.max(-45, Math.min(45, v)); }

  // Reactively commit the draft crop on every change so the mirror picks it up live.
  $: if (cropInit) {
    rollDraft.update((d) => ({ ...d, crop: draftCrop() }));
  }

  function enterCropMode() {
    const id = get(activeId) ?? $developedFolderImages[0]?.id ?? null;
    if (!id) return;
    refId = id;
    setActive(id);
    editMode = "crop";
    startCrop();
  }

  function exitEditMode() {
    if (editMode === "crop") {
      commitCropToDraft();
      cropInit = false;
    }
    editMode = "none";
    refId = null;
  }

  function onStripClick(id: string) {
    refId = id;
    setActive(id);
    // Re-seed crop with same draft (don't reset — the crop is roll-wide).
  }
</script>

{#if editMode === "none"}
  <!-- ===== Default contact-sheet view ===== -->
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
      <div class="panel-tools">
        <button class="tool-entry-btn" on:click={enterCropMode} disabled={$developedFolderImages.length === 0}>
          {$t('roll.crop.tool')}
        </button>
      </div>
      <button class="export-btn" on:click={exportContactSheet} disabled={$developedFolderImages.length === 0}>
        {$t('roll.export.button')}
      </button>
    </aside>
  </div>

  {#if $rollReferenceId}
    <FramePreview />
  {/if}

{:else if editMode === "crop"}
  <!-- ===== Reference-edit crop layout ===== -->
  <div class="ref-layout">
    <!-- Center: Viewport / CropView on the reference frame -->
    <div class="ref-center">
      {#if refFrame?.developed && refId}
        <CropView id={refId} params={refEffParams} imgW={oW} imgH={oH}
                  bind:rect {lockRatio} {rot90} {flipH} {flipV} {angle}
                  on:custom={() => (aspect = "custom")}
                  on:straighten={(e) => onStraighten(e.detail)} />
      {:else}
        <div class="ref-hint">{$t('develop.notDevelopedYet')}</div>
      {/if}
    </div>

    <!-- Right panel: CropPanel + Done button -->
    <aside class="ref-panel">
      <div class="ref-panel-inner">
        <CropPanel bind:aspect bind:orientation bind:angle
                   on:preset={(e) => onPreset(e.detail)}
                   on:swap={onSwap}
                   on:reset={onReset}
                   on:rotate={(e) => onRotate(e.detail)}
                   on:flip={(e) => onFlip(e.detail)} />
        <button class="done-btn" on:click={exitEditMode}>
          {$t('roll.close')}
        </button>
      </div>
    </aside>

    <!-- Bottom strip: contact-sheet thumbnails (short) -->
    <div class="ref-strip">
      {#each $developedFolderImages as img (img.id)}
        <button class="strip-cell" class:strip-active={img.id === refId}
                data-id={img.id} on:click={() => onStripClick(img.id)}>
          <img src={previewMap[img.id] ?? img.thumbnail} alt={img.file_name} draggable="false" />
        </button>
      {/each}
    </div>
  </div>
{/if}

{#if showEntryConfirm}
  <ConfirmOverwrite count={entryConflictCount} on:confirm={onEntryConfirm} on:cancel={onEntryCancel} />
{/if}

<style>
  /* ===== Contact-sheet layout ===== */
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
  .panel-tools { display: flex; flex-direction: column; gap: 6px; }
  .tool-entry-btn { padding: 8px 16px; border-radius: 9px; font-weight: 600; font-size: 12px;
    background: var(--glass-hi); border: 1px solid var(--glass-brd); color: var(--text);
    transition: background 0.15s, border-color 0.15s; cursor: pointer; text-align: left; }
  .tool-entry-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  .tool-entry-btn:disabled { opacity: 0.45; cursor: default; }
  .export-btn { padding: 8px 16px; border-radius: 9px; font-weight: 600; font-size: 12px;
    background: var(--glass-hi); border: 1px solid var(--glass-brd); color: var(--text);
    transition: background 0.15s, border-color 0.15s; cursor: pointer; }
  .export-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  .export-btn:disabled { opacity: 0.45; cursor: default; }

  /* ===== Reference-edit (crop) layout ===== */
  .ref-layout {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 280px;
    grid-template-rows: 1fr 110px;
    grid-template-areas:
      "center panel"
      "strip  panel";
    background: #0d0d0f;
  }
  .ref-center {
    grid-area: center;
    min-height: 0;
    display: grid;
    place-items: center;
    position: relative;
    background: #111;
  }
  .ref-hint { color: var(--text-dim, #888); }
  .ref-panel {
    grid-area: panel;
    border-left: 1px solid var(--glass-brd);
    overflow-y: auto;
    background: #111;
  }
  .ref-panel-inner {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    height: 100%;
    box-sizing: border-box;
  }
  .done-btn {
    margin-top: auto;
    padding: 8px 16px;
    border-radius: 9px;
    font-weight: 600;
    font-size: 12px;
    background: var(--accent-grad, rgba(255,255,255,0.15));
    border: 1px solid rgba(255,255,255,0.25);
    color: #fff;
    cursor: pointer;
    transition: background 0.15s;
  }
  .done-btn:hover { background: rgba(255,255,255,0.22); }
  .ref-strip {
    grid-area: strip;
    display: flex;
    flex-direction: row;
    overflow-x: auto;
    overflow-y: hidden;
    background: #0d0d0f;
    border-top: 1px solid #222;
    padding: 4px 4px;
    gap: 2px;
    align-items: center;
  }
  .strip-cell {
    flex: 0 0 auto;
    width: 120px;
    height: 90px;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 3px;
    overflow: hidden;
    background: #0d0d0f;
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .strip-cell img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .strip-cell:hover { border-color: rgba(255,255,255,0.25); }
  .strip-cell.strip-active { border-color: rgba(255,255,255,0.7); }
</style>
