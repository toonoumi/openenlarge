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
  import BaseView from "$lib/develop/BaseView.svelte";
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
  import Icon from "$lib/icons/Icon.svelte";

  // 8-bit swatch preview of a linear base (display gamma ~1/2.2). Copied from Basic.svelte.
  const baseCss = (b: [number, number, number] | null) =>
    b ? `rgb(${b.map((v) => Math.round(255 * Math.min(1, Math.max(0, v ** (1 / 2.2))))).join(",")})` : "transparent";

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
  onDestroy(() => {
    schedulePersist.flush();   // flush while destroyed is still false, so the final look persists
    destroyed = true;
  });

  // --- Tiny concurrency pool: run `fns` with at most `concurrency` in-flight at once.
  async function pooled<T>(fns: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
    const results: T[] = new Array(fns.length);
    let next = 0;
    async function worker() {
      while (next < fns.length) {
        const i = next++;
        results[i] = await fns[i]();
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, fns.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // --- PASS 1: PREVIEW — cheap, frequent, display-only (120 ms debounce) --------
  // Renders draft thumbnails into previewMap. Does NOT write editsById or saveThumbnail.
  const schedulePreview = debounce(async (draft: typeof $rollDraft) => {
    const token = ++previewToken;
    const frames = get(developedFolderImages);
    const view = draftThumbView(draft.crop);

    // Build render tasks in folder order so the first (visible) frames update first.
    const tasks = frames.map((frame) => async () => {
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
      // Commit each result as it arrives if still fresh; avoids waiting for the whole batch.
      if (previewToken === token && !destroyed) {
        previewMap = { ...previewMap, [frame.id]: dataUrl };
      }
      return { id: frame.id, dataUrl };
    });

    // Limit to 5 concurrent backend renders.
    await pooled(tasks, 5);
  }, 120);

  // --- PASS 2: PERSIST — heavy, deferred, fires once after drag settles (600 ms) --
  // Writes editsById (triggers catalog write-through) + saveThumbnail for each frame.
  // Reuses whatever is already in previewMap — does NOT re-render.
  let persistToken = 0;
  const schedulePersist = debounce(async (draft: typeof $rollDraft) => {
    const token = ++persistToken;
    if (destroyed) return;

    const frames = get(developedFolderImages);
    const ids = frames.map((f) => f.id);

    // Compute the next edits — apply tone/color look into every frame's edits.
    let nextEdits = applyToneColorToAll(get(editsById), ids, draft.params);
    // Also apply base/dmax overrides when set in the draft (null-guarded).
    if (draft.params.base_override != null) nextEdits = applyBaseToAll(nextEdits, ids, draft.params.base_override);
    if (draft.params.d_max_override != null) nextEdits = applyWhitePointToAll(nextEdits, ids, draft.params.d_max_override);

    // Guard: discard stale batch BEFORE writing stores so a stale run doesn't clobber newer state.
    if (persistToken !== token || destroyed) return;

    // Write tone/color look into every frame's edits (persisted automatically via write-through).
    editsById.set(nextEdits);

    // Persist crop to all frames when the draft has a crop set (null-guarded).
    if (draft.crop != null) cropById.set(applyCropToAll(get(cropById), ids, draft.crop));

    // Persist thumbnail for each frame — reuse previewMap renders, no re-render.
    const snap = previewMap;
    for (const id of ids) {
      const url = snap[id];
      if (url) {
        images.update((xs) => xs.map((i) => i.id === id ? { ...i, thumbnail: url } : i));
        api.saveThumbnail(id, url);
      }
    }
  }, 600);

  // Mirror every rollDraft change (tone/color/base/dmax/crop) to all frames,
  // but only once mirroring has been enabled (after entry confirm or no conflicts).
  $: if (mirrorEnabled) { schedulePreview($rollDraft); schedulePersist($rollDraft); }

  // --- Reference-edit mode (crop / base / wp) ----------------------------------
  type EditMode = "none" | "crop" | "base" | "wp";
  let editMode: EditMode = "none";
  // Whether a wp-pick click is currently being processed (disarm after one pick).
  let wpPicking = false;
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

  // Effective base for the film-base swatch: roll draft override if set, else
  // the first (reference) frame's effective base (folder base or per-image base_override).
  $: firstFrame = $developedFolderImages[0] ?? null;
  $: firstFrameDir = firstFrame ? imageDir(firstFrame) : "";
  $: firstFrameParams = firstFrame ? ($editsById[firstFrame.id] ?? defaultParams()) : defaultParams();
  $: firstFrameEffBase = withEffectiveBase(firstFrameParams, firstFrameDir).base_override ?? null;
  $: swatchBase = ($rollDraft.params.base_override ?? firstFrameEffBase) as [number,number,number] | null;

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
  // NOTE: explicitly reference rect/rot90/flipH/flipV/angle/aspect/orientation so
  // Svelte tracks them as dependencies of this block (Svelte does not look inside
  // function bodies for dependencies, so draftCrop() alone would only re-run on
  // cropInit changes — rotation and flip changes would never propagate to all frames).
  $: if (cropInit) {
    // Touch all crop variables so Svelte's dependency tracker picks them up.
    void rect; void rot90; void flipH; void flipV; void angle; void aspect; void orientation;
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

  function enterBaseMode() {
    const id = get(activeId) ?? $developedFolderImages[0]?.id ?? null;
    if (!id) return;
    refId = id;
    setActive(id);
    editMode = "base";
  }

  function enterWpMode() {
    const id = get(activeId) ?? $developedFolderImages[0]?.id ?? null;
    if (!id) return;
    refId = id;
    setActive(id);
    editMode = "wp";
    wpPicking = true;
  }

  async function onAutoBase() {
    const id = get(activeId) ?? $developedFolderImages[0]?.id ?? null;
    if (!id) return;
    // Set refId so the reference panel is visible, but don't need to enter base mode.
    refId = id;
    setActive(id);
    if (editMode === "none") editMode = "base";
    try {
      const r = await api.autoBaseInfo(id);
      rollDraft.update((d) => ({ ...d, params: { ...d.params, base_override: r.base } }));
    } catch { /* ignore */ }
  }

  function onBaseSampled(e: CustomEvent<[number, number, number]>) {
    rollDraft.update((d) => ({ ...d, params: { ...d.params, base_override: e.detail } }));
  }

  async function onWpPick(e: CustomEvent<{ r: number; g: number; b: number; u: number; v: number }>) {
    if (!refId) return;
    wpPicking = false;
    const { u, v } = e.detail;
    const P = 0.02;
    const c01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
    const rect: [number, number, number, number] = [c01(u - P / 2), c01(v - P / 2), P, P];
    try {
      const { d_max } = await api.analyzeWhitePoint(refId, withEffectiveBase($rollDraft.params, refDir), rect);
      rollDraft.update((d) => ({ ...d, params: { ...d.params, d_max_override: d_max } }));
    } catch { /* ignore */ }
    // Re-arm for another pick without leaving wp mode.
    wpPicking = true;
  }

  function exitEditMode() {
    if (editMode === "crop") {
      commitCropToDraft();
      cropInit = false;
    }
    // base / wp: draft writes already mirrored live — nothing extra to commit.
    editMode = "none";
    wpPicking = false;
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
        <!-- Film base: Tune-identical swatch + pipette widget -->
        <div class="panel-section-label">{$t('roll.base.heading')}</div>
        <button class="baseswatch" class:on={(editMode as string) === "base"} disabled={$developedFolderImages.length === 0}
                on:click={enterBaseMode} title={$t('roll.base.sample')} aria-label={$t('roll.base.sample')}>
          <span class="cube big" style="background:{baseCss(swatchBase)}"></span>
          <span class="pick"><Icon name="pipette" size={18} /></span>
        </button>
        <button class="auto-link" on:click={onAutoBase} disabled={$developedFolderImages.length === 0}>
          {$t('roll.base.auto')}
        </button>

        <!-- White point: Tune-identical pipette button -->
        <div class="wp-row">
          <span class="panel-section-label">{$t('roll.wp.heading')}</span>
          <button class="wbdrop" class:on={(editMode as string) === "wp"} disabled={$developedFolderImages.length === 0}
                  on:click={enterWpMode} title={$t('roll.wp.pick')} aria-label={$t('roll.wp.pick')}>
            <Icon name="pipette" size={14} />
          </button>
        </div>
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
    <!-- Center: CropView on the reference frame -->
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

{:else if editMode === "base"}
  <!-- ===== Reference-edit base layout ===== -->
  <div class="ref-layout">
    <!-- Center: BaseView fills the area — it owns all pointer events (no overlay, no z-index obstruction).
         This is the fix for feedback #2: the previous approach layered BaseView on top of a Viewport
         inside .base-overlay with position:absolute, risking z-index conflicts and click interception
         by the Viewport's own interactive layer. Here BaseView IS the center content, unobstructed. -->
    <div class="ref-center">
      {#if refFrame?.developed && refId}
        <BaseView id={refId} params={refEffParams} imgW={origW} imgH={origH}
                  on:sampled={onBaseSampled} />
      {:else}
        <div class="ref-hint">{$t('develop.notDevelopedYet')}</div>
      {/if}
    </div>

    <!-- Right panel: hint + Done button -->
    <aside class="ref-panel">
      <div class="ref-panel-inner">
        <div class="panel-mode-hint">{$t('roll.base.sample')}</div>
        <button class="done-btn" on:click={exitEditMode}>
          {$t('roll.close')}
        </button>
      </div>
    </aside>

    <!-- Bottom strip -->
    <div class="ref-strip">
      {#each $developedFolderImages as img (img.id)}
        <button class="strip-cell" class:strip-active={img.id === refId}
                data-id={img.id} on:click={() => onStripClick(img.id)}>
          <img src={previewMap[img.id] ?? img.thumbnail} alt={img.file_name} draggable="false" />
        </button>
      {/each}
    </div>
  </div>

{:else if editMode === "wp"}
  <!-- ===== Reference-edit white-point layout ===== -->
  <div class="ref-layout">
    <!-- Center: Viewport with pointPick armed on the reference frame -->
    <div class="ref-center">
      {#if refFrame?.developed && refId}
        <Viewport
          id={refId}
          params={refEffParams}
          imgW={effW}
          imgH={effH}
          imageCrop={imageCrop}
          rot90={cRot}
          flipH={refCommitted?.flipH ?? false}
          flipV={refCommitted?.flipV ?? false}
          angle={refCommitted?.angle ?? 0}
          fallbackThumb={refFrame?.thumbnail ?? ""}
          dust={refDust.strokes}
          irRemoval={refDust.irRemoval}
          dustRev={0}
          developRev={$developRev}
          eraser={false}
          pointPick={wpPicking}
          clipHigh={false}
          clipLow={false}
          clipStrict={false}
          on:pointpick={onWpPick}
        />
      {:else}
        <div class="ref-hint">{$t('develop.notDevelopedYet')}</div>
      {/if}
    </div>

    <!-- Right panel: hint + Done button -->
    <aside class="ref-panel">
      <div class="ref-panel-inner">
        <div class="panel-mode-hint">{$t('roll.wp.pick')}</div>
        <button class="done-btn" on:click={exitEditMode}>
          {$t('roll.close')}
        </button>
      </div>
    </aside>

    <!-- Bottom strip -->
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

  /* Panel section labels and button rows (sheet mode) */
  .panel-section-label { font-size: 10px; font-weight: 600; color: var(--text-dim, #888);
    text-transform: uppercase; letter-spacing: 0.06em; padding: 4px 0 2px; }
  /* Mode hint inside ref-panel-inner (base / wp modes) */
  .panel-mode-hint { font-size: 11px; color: var(--text-dim, #888); padding: 4px 0; }

  /* Film-base swatch widget — identical to Basic.svelte's .baseswatch/.cube/.pick */
  .cube { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--glass-brd);
    flex: none; }
  .cube.big { width: 100%; height: 30px; border-radius: 8px; box-sizing: border-box; }
  .baseswatch { position: relative; display: flex; width: 100%; padding: 0; border: 0;
    background: transparent; cursor: pointer; margin: 4px 0 2px; }
  .baseswatch:disabled { opacity: 0.45; cursor: default; }
  .baseswatch .pick { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: #fff; background: rgba(0,0,0,0.4); border-radius: 8px;
    opacity: 0; transition: opacity 120ms; }
  .baseswatch:hover:not(:disabled) .pick, .baseswatch.on .pick { opacity: 1; }
  .baseswatch.on .cube.big { box-shadow: 0 0 0 2px rgba(244,157,78,0.7); }

  /* Small "auto" text link next to the swatch — secondary affordance only */
  .auto-link { background: transparent; border: none; color: var(--text-dim, #888);
    font-size: 11px; padding: 0 0 4px; cursor: pointer; text-align: left; }
  .auto-link:hover:not(:disabled) { color: var(--text); }
  .auto-link:disabled { opacity: 0.45; cursor: default; }

  /* White-point row: label + pipette button side by side */
  .wp-row { display: flex; align-items: center; justify-content: space-between;
    gap: 6px; margin-top: 4px; }
  .wp-row .panel-section-label { padding: 0; margin: 0; }

  /* WB pipette button — identical to Basic.svelte's .wbdrop */
  .wbdrop { display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: 1px solid var(--glass-brd); color: var(--text-dim);
    border-radius: 6px; padding: 2px 6px; cursor: pointer; }
  .wbdrop.on { color: var(--text); border-color: var(--accent); }
  .wbdrop:disabled { opacity: 0.45; cursor: default; }
</style>
