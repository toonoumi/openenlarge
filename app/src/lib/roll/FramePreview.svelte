<script lang="ts">
  import { t } from "$lib/i18n";
  import { rollReferenceId } from "$lib/roll/draft";
  import { images, editsById, cropById, developRev, dustById } from "$lib/store";
  import Viewport from "$lib/viewport/Viewport.svelte";
  import { withEffectiveBase } from "$lib/develop/base";
  import { imageDir } from "$lib/library/folderScope";
  import { defaultParams } from "$lib/api";
  import { orientDims } from "$lib/crop/transforms";
  import { emptyDust } from "$lib/develop/dust";

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

  function close() {
    rollReferenceId.set(null);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="overlay" on:click|self={close} role="dialog" aria-modal="true">
  <div class="viewport-wrap">
    {#if frame?.developed && id}
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
  </div>

  <div class="toolbar">
    <button class="close-btn" on:click={close}>{$t('roll.close')}</button>
  </div>
</div>

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
  .toolbar {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    gap: 8px;
    align-items: center;
    z-index: 51;
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
