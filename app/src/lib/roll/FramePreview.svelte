<script lang="ts">
  import { t } from "$lib/i18n";
  import { get } from "svelte/store";
  import { rollReferenceId, rollDraft } from "$lib/roll/draft";
  import { images, editsById, cropById, developRev, dustById } from "$lib/store";
  import { developedFolderImages } from "$lib/export/eligible";
  import Viewport from "$lib/viewport/Viewport.svelte";
  import CropView from "$lib/crop/CropView.svelte";
  import CropPanel from "$lib/crop/CropPanel.svelte";
  import ConfirmOverwrite from "$lib/roll/ConfirmOverwrite.svelte";
  import { withEffectiveBase } from "$lib/develop/base";
  import { imageDir } from "$lib/library/folderScope";
  import { defaultParams } from "$lib/api";
  import { orientDims } from "$lib/crop/transforms";
  import { emptyDust } from "$lib/develop/dust";
  import type { Rect, CropRect } from "$lib/crop/types";
  import { defaultFull, conform, constrainToRotated } from "$lib/crop/cropMath";
  import { presetNormAspect } from "$lib/crop/presets";
  import { rotateRectCW, rotateRectCCW, flipRectH, flipRectV, flipOrient } from "$lib/crop/transforms";
  import { framesWithCrop, applyCropToAll } from "$lib/roll/apply";

  // The frame being previewed.
  $: id = $rollReferenceId;
  $: frame = id ? $images.find((i) => i.id === id) ?? null : null;

  // Frame metadata dimensions.
  $: origW = frame?.metadata.width ?? 0;
  $: origH = frame?.metadata.height ?? 0;

  // Frame's own committed crop (mirrors Develop.svelte lines 288-294).
  $: committed = id ? ($cropById[id] ?? null) : null;
  $: cRot = committed?.rot90 ?? 0;
  $: [coW, coH] = orientDims(origW, origH, cRot);
  $: effW = committed ? Math.max(1, Math.round(committed.rect.w * coW)) : coW;
  $: effH = committed ? Math.max(1, Math.round(committed.rect.h * coH)) : coH;
  $: imageCrop = committed
    ? ([committed.rect.x, committed.rect.y, committed.rect.w, committed.rect.h] as [number, number, number, number])
    : null;

  // Frame's own stored edits (not the roll draft — this is a preview of the frame as-is).
  $: frameParams = id ? ($editsById[id] ?? defaultParams()) : defaultParams();
  $: dir = frame ? imageDir(frame) : "";
  $: effectiveParams = withEffectiveBase(frameParams, dir);

  // Frame's own dust edits (empty if none).
  $: dustEdits = id ? ($dustById[id] ?? emptyDust()) : emptyDust();

  // ---- Mode toggle ----
  type OverlayMode = "preview" | "crop";
  let mode: OverlayMode = "preview";

  // ---- Crop draft state (only while mode === "crop") ----
  let rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  let aspect = "original";
  let orientation: "landscape" | "portrait" = "landscape";
  let rot90 = 0, flipH = false, flipV = false, angle = 0;
  let cropInit = false;

  $: [oW, oH] = orientDims(origW, origH, rot90);
  $: orientedRatio = oH > 0 ? oW / oH : 1;

  function startCrop() {
    // Seed from the roll draft crop (fall back to full frame).
    const c = $rollDraft.crop;
    if (c) {
      rect = { ...c.rect }; aspect = c.aspect; orientation = c.orientation;
      rot90 = c.rot90; flipH = c.flipH; flipV = c.flipV; angle = c.angle;
    } else {
      rect = defaultFull(); aspect = "original"; orientation = origW >= origH ? "landscape" : "portrait";
      rot90 = 0; flipH = false; flipV = false; angle = 0;
    }
    cropInit = true;
  }

  function draftCrop(): CropRect {
    return { rect, aspect, orientation, rot90: rot90 as 0 | 1 | 2 | 3, flipH, flipV, angle };
  }

  function commitCrop() {
    if (!cropInit) return;
    // Write the draft crop into the roll draft (not the frame's cropById).
    rollDraft.update((d) => ({ ...d, crop: draftCrop() }));
    cropInit = false;
  }

  function onPreset(id: string) { aspect = id; rect = conform(rect, presetNormAspect(id, orientedRatio, orientation)); }
  function onSwap() { orientation = orientation === "landscape" ? "portrait" : "landscape"; rect = conform(rect, presetNormAspect(aspect, orientedRatio, orientation)); }
  function onReset() { rect = defaultFull(); aspect = "original"; orientation = origW >= origH ? "landscape" : "portrait"; rot90 = 0; flipH = false; flipV = false; angle = 0; }
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

  $: lockRatio = presetNormAspect(aspect, orientedRatio, orientation);
  // Keep the crop inside the rotated image (constrainToRotated is idempotent → no loop).
  $: if (angle !== 0) rect = constrainToRotated(rect, angle, oW, oH);

  let prevMode: OverlayMode = mode;
  $: {
    if (mode === "crop" && prevMode !== "crop") startCrop();
    if (mode !== "crop" && prevMode === "crop") { commitCrop(); }
    prevMode = mode;
  }

  function toggleCropMode() {
    mode = mode === "crop" ? "preview" : "crop";
  }

  // ---- Apply crop to roll ----
  // pending tracks which apply action awaits confirmation.
  let pending: "crop" | null = null;
  let showConfirm = false;
  let confirmCount = 0;
  let applyIds: string[] = [];

  function applyCrop() {
    cropById.set(applyCropToAll(get(cropById), applyIds, $rollDraft.crop));
    showConfirm = false;
    pending = null;
  }

  function onConfirm() {
    if (pending === "crop") applyCrop();
    showConfirm = false;
    pending = null;
  }

  function onApplyCropClick() {
    // Snapshot count + ids at click time (do NOT call get() inside the template).
    applyIds = $developedFolderImages.map((i) => i.id);
    const conflicts = framesWithCrop($cropById, applyIds);
    if (conflicts.length > 0) {
      confirmCount = conflicts.length;
      pending = "crop";
      showConfirm = true;
    } else {
      pending = "crop";
      applyCrop();
    }
  }

  function close() {
    // Commit any in-progress crop before closing.
    if (mode === "crop") {
      commitCrop();
      mode = "preview";
    }
    rollReferenceId.set(null);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showConfirm) { showConfirm = false; pending = null; return; }
      if (mode === "crop") { commitCrop(); mode = "preview"; return; }
      close();
    }
    if (mode === "crop") {
      if (e.key === "x" || e.key === "X") { onSwap(); }
    }
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="overlay" on:click|self={close} role="dialog" aria-modal="true">
  <div class="viewport-wrap">
    {#if frame?.developed && id}
      {#if mode === "crop"}
        <CropView {id} params={effectiveParams} imgW={oW} imgH={oH}
                  bind:rect {lockRatio} {rot90} {flipH} {flipV} {angle}
                  on:custom={() => (aspect = "custom")} on:straighten={(e) => onStraighten(e.detail)} />
      {:else}
        <Viewport
          {id}
          params={effectiveParams}
          imgW={effW}
          imgH={effH}
          imageCrop={imageCrop}
          rot90={cRot}
          flipH={committed?.flipH ?? false}
          flipV={committed?.flipV ?? false}
          angle={committed?.angle ?? 0}
          fallbackThumb={frame?.thumbnail ?? ""}
          dust={dustEdits.strokes}
          irRemoval={dustEdits.irRemoval}
          dustRev={0}
          developRev={$developRev}
          eraser={false}
          pointPick={false}
          clipHigh={false}
          clipLow={false}
          clipStrict={false}
        />
      {/if}
    {/if}
  </div>

  {#if mode === "crop"}
    <div class="crop-panel-wrap">
      <CropPanel bind:aspect bind:orientation bind:angle
                 on:preset={(e) => onPreset(e.detail)} on:swap={onSwap} on:reset={onReset}
                 on:rotate={(e) => onRotate(e.detail)} on:flip={(e) => onFlip(e.detail)} />
    </div>
  {/if}

  <div class="toolbar">
    <button class="tool-btn" class:active={mode === "crop"} on:click={toggleCropMode}>
      {$t('roll.crop.tool')}
    </button>
    {#if $rollDraft.crop}
      <button class="apply-btn" on:click={onApplyCropClick}>
        {$t('roll.crop.apply')}
      </button>
    {/if}
    <button class="close-btn" on:click={close}>{$t('roll.close')}</button>
  </div>
</div>

{#if showConfirm}
  <ConfirmOverwrite
    count={confirmCount}
    on:confirm={onConfirm}
    on:cancel={() => { showConfirm = false; pending = null; }}
  />
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: #111;
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .viewport-wrap {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
  }
  .crop-panel-wrap {
    position: absolute;
    right: 16px;
    top: 60px;
    width: 260px;
    z-index: 52;
    background: var(--glass-bg, rgba(20,20,25,0.92));
    border: 1px solid var(--glass-brd, rgba(255,255,255,0.1));
    border-radius: 12px;
    padding: 4px 0;
    overflow-y: auto;
    max-height: calc(100vh - 120px);
  }
  .toolbar {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 8px;
    align-items: center;
    z-index: 51;
  }
  .tool-btn {
    padding: 8px 18px;
    border-radius: 9px;
    border: 1px solid rgba(255,255,255,0.25);
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .tool-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }
  .tool-btn.active {
    background: var(--accent-grad, #4a90e2);
    border-color: transparent;
  }
  .apply-btn {
    padding: 8px 18px;
    border-radius: 9px;
    border: 0;
    background: var(--accent-grad, #4a90e2);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .apply-btn:hover {
    opacity: 0.85;
  }
  .close-btn {
    padding: 8px 18px;
    border-radius: 9px;
    border: 0;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .close-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }
</style>
