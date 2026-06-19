<!-- app/src/lib/tabs/Roll.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fade } from "svelte/transition";
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { developedFolderImages } from "$lib/export/eligible";
  import { editsById, cropById, images, activeId, setActive, rollOverwriteSkip, module, deleteTarget } from "$lib/store";
  import { rollReferenceId, resetRollDraft, rollDraft, rollDraftTouched } from "$lib/roll/draft";
  import RollAdjust from "$lib/roll/RollAdjust.svelte";
  import { applyToneColorToAll, applyBaseToAll, applyWhitePointToAll, applyCropToAll, framesWithToneColor, framesWithCrop, framesWithBase, framesWithWhitePoint } from "$lib/roll/apply";
  import { livePreviewParams, draftThumbView } from "$lib/roll/livePreview";
  import { withEffectiveBase } from "$lib/develop/base";
  import { imageDir } from "$lib/library/folderScope";
  import { api, defaultParams } from "$lib/api";
  import { debounce } from "$lib/catalog";
  import { rollFilmEdge, rollEdgeText } from "$lib/store";
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
  import QualityMenu from "$lib/viewport/QualityMenu.svelte";

  // Entry gate: enabled after confirm (or if no conflicts / skip-pref set).
  let mirrorEnabled = false;
  let showEntryConfirm = false;
  let entryConflictCount = 0;

  // Fresh roll draft each time the section opens (seed from defaults per spec).
  onMount(() => {
    resetRollDraft();
    wpManual = false;

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

  // --- Film-strip contact sheet helpers -------------------------------------
  const STRIP_SIZE = 6;

  // Chunk images into strips of STRIP_SIZE, computing flat sequential frame numbers.
  $: strips = (() => {
    const imgs = $developedFolderImages;
    const result: { frames: { img: typeof imgs[0]; num: string; idx: number }[]; padCount: number }[] = [];
    for (let i = 0; i < imgs.length; i += STRIP_SIZE) {
      const slice = imgs.slice(i, i + STRIP_SIZE);
      const frames = slice.map((img, j) => ({
        img,
        num: String(i + j + 1).padStart(2, "0"),
        idx: i + j,
      }));
      result.push({ frames, padCount: STRIP_SIZE - frames.length });
    }
    return result;
  })();

  // Editable edge text state — only the tapped strip shows the input
  let edgeEditingStrip: number | null = null;
  let edgeInputValue = "";

  function startEdgeEdit(stripIndex: number) {
    edgeInputValue = $rollEdgeText;
    edgeEditingStrip = stripIndex;
  }

  function commitEdgeEdit() {
    const trimmed = edgeInputValue.trim();
    if (trimmed) rollEdgeText.set(trimmed);
    edgeEditingStrip = null;
  }

  function cancelEdgeEdit() {
    edgeEditingStrip = null;
  }

  function onEdgeKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); commitEdgeEdit(); }
    else if (e.key === "Escape") { cancelEdgeEdit(); }
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
    if (previewRafHandle !== null) {
      cancelAnimationFrame(previewRafHandle);
      previewRafHandle = null;
    }
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

  // Single-in-flight guard: only one preview batch runs at a time.
  let previewRunning = false;
  let previewPending: typeof $rollDraft | null = null;
  // rAF handle for the coalescing loop (cancelled on batch end / component destroy).
  let previewRafHandle: number | null = null;

  async function runPreviewBatch(draft: typeof $rollDraft): Promise<void> {
    previewRunning = true;
    try {
      const token = ++previewToken;
      const frames = get(developedFolderImages);
      // Read touched flag once at batch start — consistent across all frames in this batch.
      const touched = get(rollDraftTouched);

      // Accumulator: start from current previewMap so unrendered frames keep their old preview.
      const acc: Record<string, string> = { ...previewMap };
      let dirty = false;

      // Start a single rAF coalescing loop — commits previewMap at most ~60/sec.
      if (previewRafHandle !== null) cancelAnimationFrame(previewRafHandle);
      if (typeof requestAnimationFrame !== "undefined") {
        const rafLoop = () => {
          if (dirty && previewToken === token && !destroyed) {
            previewMap = { ...acc };
            dirty = false;
          }
          // Keep looping until this batch is superseded or the component is destroyed.
          if (previewToken === token && !destroyed) {
            previewRafHandle = requestAnimationFrame(rafLoop);
          } else {
            previewRafHandle = null;
          }
        };
        previewRafHandle = requestAnimationFrame(rafLoop);
      }

      // Build render tasks in folder order so the first (visible) frames update first.
      const tasks = frames.map((frame) => async () => {
        const own = editsEntry(frame.id);
        // When untouched: render each frame with its own stored edits + its own stored crop
        // (the roll as-is — no revert, no reset). When touched: apply the draft look to all,
        // and use the draft crop if set (else fall back to each frame's own crop).
        const baseParams = touched
          ? {
              ...livePreviewParams(draft.params, own),
              ...(draft.params.base_override != null ? { base_override: draft.params.base_override } : {}),
              ...(draft.params.d_max_override != null ? { d_max_override: draft.params.d_max_override } : {}),
            }
          : own;
        const params = withEffectiveBase(baseParams, imageDir(frame));
        // When touched: use the draft crop if set, else fall back to the frame's own crop.
        // When untouched: always use the frame's own stored crop (no draft applied).
        const frameCrop = touched
          ? (draft.crop != null ? draft.crop : (get(cropById)[frame.id] ?? null))
          : (get(cropById)[frame.id] ?? null);
        const view = draftThumbView(frameCrop);
        const dataUrl = await api.thumbnail(frame.id, params, view);
        // Write into accumulator (plain property set — no Svelte reactivity triggered here).
        if (previewToken === token && !destroyed) {
          acc[frame.id] = dataUrl;
          dirty = true;
        }
        return { id: frame.id, dataUrl };
      });

      // Limit to 5 concurrent backend renders.
      await pooled(tasks, 5);

      // Batch complete: cancel the rAF loop and do one final commit (covers SSR/test envs too).
      if (previewRafHandle !== null) {
        cancelAnimationFrame(previewRafHandle);
        previewRafHandle = null;
      }
      if (previewToken === token && !destroyed) {
        previewMap = { ...acc };
      }
    } finally {
      previewRunning = false;
      // If a newer draft arrived while we were running, render it now.
      if (previewPending !== null) {
        const next = previewPending;
        previewPending = null;
        runPreviewBatch(next);
      }
    }
  }

  const schedulePreview = debounce((draft: typeof $rollDraft) => {
    if (previewRunning) {
      // Queue the latest draft; an in-flight batch will pick it up on completion.
      previewPending = draft;
      return;
    }
    runPreviewBatch(draft);
  }, 120);

  // --- PASS 2: PERSIST — heavy, deferred, fires once after drag settles (600 ms) --
  // Writes editsById (triggers catalog write-through) + saveThumbnail for each frame.
  // Reuses whatever is already in previewMap — does NOT re-render.
  let persistToken = 0;
  const schedulePersist = debounce(async (draft: typeof $rollDraft) => {
    const token = ++persistToken;
    if (destroyed) return;
    // Guard: if the user hasn't touched any control yet (fresh/re-entry), don't write
    // anything — prevents resetting each frame's look/crop on every Develop tab visit.
    if (!get(rollDraftTouched)) return;

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
  // Sticky flag: once the user manually picks a white point, auto re-analysis from
  // crop changes is suppressed for the remainder of this roll session.
  let wpManual = false;

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
    // Seed from the draft crop if a roll crop is already in progress, else from the
    // reference frame's COMMITTED crop (so orientation/flip/rotation + the crop box
    // persist when re-entering crop), else full frame. (refCommitted is stale here
    // because enterCropMode sets refId synchronously just before calling this.)
    const c = $rollDraft.crop ?? (refId ? get(cropById)[refId] ?? null : null);
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
    rollDraftTouched.set(true);
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

  function onBaseSampled(e: CustomEvent<[number, number, number]>) {
    rollDraft.update((d) => ({ ...d, params: { ...d.params, base_override: e.detail } }));
    rollDraftTouched.set(true);
    exitEditMode();
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
      rollDraftTouched.set(true);
      wpManual = true;
    } catch { /* ignore */ }
    // Auto-dismiss: exit wp mode after one successful pick (mirrors film-base behaviour).
    exitEditMode();
  }

  /** Apply the current crop draft to all frames, then leave crop mode.
   *  If no manual WP pick has been made, re-derives D-max from the reference
   *  frame's new crop and applies that one value roll-wide. */
  async function applyCropAndExit() {
    commitCropToDraft();
    // Capture ref info before clearing refId.
    const id = refId;
    const crop = get(rollDraft).crop;
    const frame = id ? get(images).find((i) => i.id === id) : null;
    const dir = frame ? imageDir(frame) : "";
    // Exit crop mode immediately so the UI returns to the sheet.
    cropInit = false;
    editMode = "none";
    refId = null;
    // Re-analyze D-max from the new crop unless the user has manually picked a WP.
    if (id && crop && !wpManual) {
      try {
        const imageCrop: [number, number, number, number] = [crop.rect.x, crop.rect.y, crop.rect.w, crop.rect.h];
        const geom = { rot90: crop.rot90, flip_h: crop.flipH, flip_v: crop.flipV, angle: crop.angle };
        const { d_max } = await api.analyze(id, withEffectiveBase(get(rollDraft).params, dir), imageCrop, geom);
        rollDraft.update((d) => ({ ...d, params: { ...d.params, d_max_override: d_max } }));
        rollDraftTouched.set(true);
      } catch { /* not developed / analyze failed — leave d_max as-is */ }
    }
  }

  /** Leave crop mode WITHOUT committing — prior roll crop is preserved. */
  function discardCropAndExit() {
    cropInit = false;
    editMode = "none";
    refId = null;
  }

  function exitEditMode() {
    // base / wp: draft writes already mirrored live — nothing extra to commit.
    // NOTE: do NOT call this from crop mode — use applyCropAndExit or discardCropAndExit.
    editMode = "none";
    wpPicking = false;
    refId = null;
  }

  function onStripClick(id: string) {
    refId = id;
    setActive(id);
    // Re-seed crop with same draft (don't reset — the crop is roll-wide).
  }

  /** True while a form control has focus (INPUT/TEXTAREA/SELECT), so typing in the
   *  straighten field or edge-text input isn't hijacked by crop shortcuts. */
  function formFocused(): boolean {
    const a = document.activeElement;
    const tag = a?.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  }

  /** Context menu state for the crop-mode right-click flip menu. */
  let menu: { x: number; y: number } | null = null;

  function onCropContextMenu(e: MouseEvent) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY };
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (editMode === "crop") {
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === "Enter" && !formFocused()) {
        e.preventDefault();
        applyCropAndExit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        discardCropAndExit();
        return;
      }
      if ((e.key === "x" || e.key === "X") && !formFocused() && !meta) {
        e.preventDefault();
        onSwap();
        return;
      }
      if (meta && (e.key === "]" || e.key === "[")) {
        e.preventDefault();
        onRotate(e.key === "]" ? 1 : -1);
        return;
      }
    } else if (e.key === "Escape" && editMode !== "none") {
      exitEditMode();
    }
  }

  // Svelte action: focus an input element immediately on mount.
  function focusOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
    return {};
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

{#if editMode === "none"}
  <!-- ===== Default contact-sheet view ===== -->
  <div class="roll">
    <div class="sheet-col">
      <div class="sheet-toolbar">
        <!-- Film edge toggle (left of export button) -->
        <button class="film-edge-toggle" on:click={() => rollFilmEdge.update(b => !b)}
                aria-label={$t('roll.filmEdge')} aria-pressed={$rollFilmEdge}>
          <span class="film-edge-label">{$t('roll.filmEdge')}</span>
          <span class="pill" class:pill-on={$rollFilmEdge}>
            <span class="knob"></span>
          </span>
        </button>
        <button class="export-btn" on:click={exportContactSheet} disabled={$developedFolderImages.length === 0}>
          {$t('roll.export.button')}
        </button>
      </div>
      <div class="sheet">
      {#if $developedFolderImages.length === 0}
        <div class="empty">{$t('roll.empty')}</div>
      {:else}
        {#key $rollFilmEdge}
          <div class="sheet-anim" in:fade={{ duration: 180 }}>
            <div class="strips-container">
              {#if $rollFilmEdge}
                <!-- ===== FILM-EDGE ON: filmstrip with rebates ===== -->
                {#each strips as strip, stripIndex}
                  <div class="filmstrip-strip">
                    <!-- Top rebate -->
                    <div class="rebate rebate-top">
                      <div class="sprocket-holes"></div>
                      <div class="frame-numbers">
                        {#each strip.frames as f}
                          <div class="frame-num">{f.num}</div>
                        {/each}
                        {#each Array(strip.padCount) as _}
                          <div class="frame-num frame-pad"></div>
                        {/each}
                      </div>
                    </div>
                    <!-- Frames row -->
                    <div class="frames-row">
                      {#each strip.frames as f}
                        <button class="frame-cell" data-id={f.img.id}
                                on:click={() => openFrame(f.img.id)}>
                          <img src={previewMap[f.img.id] ?? f.img.thumbnail}
                               alt={f.img.file_name} draggable="false" />
                        </button>
                      {/each}
                      {#each Array(strip.padCount) as _}
                        <div class="frame-cell frame-cell-pad"></div>
                      {/each}
                    </div>
                    <!-- Bottom rebate -->
                    <div class="rebate rebate-bottom">
                      <div class="rebate-info-row">
                        <div class="barcode"></div>
                        {#if edgeEditingStrip === stripIndex}
                          <input
                            class="edge-text-input"
                            type="text"
                            bind:value={edgeInputValue}
                            on:blur={commitEdgeEdit}
                            on:keydown={onEdgeKeydown}
                            aria-label="Film edge text"
                            use:focusOnMount
                          />
                        {:else}
                          <button class="edge-text" on:click|stopPropagation={() => startEdgeEdit(stripIndex)}
                                  aria-label="Edit film edge text">{$rollEdgeText}</button>
                        {/if}
                        <div style="flex:1"></div>
                        <span class="edge-arrow">→</span>
                      </div>
                      <div class="sprocket-holes"></div>
                    </div>
                  </div>
                {/each}
              {:else}
                <!-- ===== FILM-EDGE OFF: proof grid ===== -->
                {#each strips as strip}
                  <div class="proof-strip">
                    {#each strip.frames as f}
                      <div class="proof-cell">
                        <button class="proof-frame" data-id={f.img.id}
                                on:click={() => openFrame(f.img.id)}>
                          <img src={previewMap[f.img.id] ?? f.img.thumbnail}
                               alt={f.img.file_name} draggable="false" />
                        </button>
                        <div class="proof-caption">{f.num}</div>
                      </div>
                    {/each}
                    {#each Array(strip.padCount) as _}
                      <div class="proof-cell proof-cell-pad"></div>
                    {/each}
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/key}
      {/if}
      </div>
    </div>

    <aside class="panel">
      <RollAdjust>
        <!-- Change A+D: tool row rendered in slot between heading and sliders -->
        <div class="tool-row">
          <div class="tool">
            <button class="tool-btn" on:click={enterCropMode} disabled={$developedFolderImages.length === 0}
                    aria-label={$t('roll.crop.tool')}>
              <Icon name="crop" size={20} />
            </button>
            <span class="tool-label">{$t('roll.crop.tool')}</span>
          </div>
          <div class="tool">
            <button class="tool-btn" class:on={(editMode as string) === "base"}
                    on:click={enterBaseMode} disabled={$developedFolderImages.length === 0}
                    aria-label={$t('roll.base.heading')}>
              <Icon name="droplet" size={20} />
            </button>
            <span class="tool-label">{$t('roll.base.heading')}</span>
          </div>
          <div class="tool">
            <button class="tool-btn" class:on={(editMode as string) === "wp"}
                    on:click={enterWpMode} disabled={$developedFolderImages.length === 0}
                    aria-label={$t('roll.wp.heading')}>
              <Icon name="pipette" size={20} />
            </button>
            <span class="tool-label">{$t('roll.wp.heading')}</span>
          </div>
        </div>
      </RollAdjust>
    </aside>
  </div>

  {#if $rollReferenceId}
    <FramePreview />
  {/if}

{:else if editMode === "crop"}
  <!-- ===== Reference-edit crop layout ===== -->
  <div class="ref-layout">
    <!-- Center: CropView on the reference frame -->
    <div class="ref-center" on:contextmenu={onCropContextMenu}>
      {#if refFrame?.developed && refId}
        <CropView id={refId} params={refEffParams} imgW={oW} imgH={oH}
                  bind:rect {lockRatio} {rot90} {flipH} {flipV} {angle}
                  on:custom={() => (aspect = "custom")}
                  on:straighten={(e) => onStraighten(e.detail)} />
      {:else}
        <div class="ref-hint">{$t('develop.notDevelopedYet')}</div>
      {/if}
    </div>

    <!-- Right panel: CropPanel + Apply button -->
    <aside class="ref-panel">
      <div class="ref-panel-inner">
        <CropPanel bind:aspect bind:orientation bind:angle
                   on:preset={(e) => onPreset(e.detail)}
                   on:swap={onSwap}
                   on:reset={onReset}
                   on:rotate={(e) => onRotate(e.detail)}
                   on:flip={(e) => onFlip(e.detail)} />
        <button class="done-btn" on:click={applyCropAndExit}>
          {$t('roll.crop.tool')}
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

    <!-- Right panel: empty (picking auto-closes; press Escape to cancel) -->
    <aside class="ref-panel">
      <div class="ref-panel-inner"></div>
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

    <!-- Right panel: empty (picking auto-closes; press Escape to cancel) -->
    <aside class="ref-panel">
      <div class="ref-panel-inner"></div>
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

{#if menu && editMode === "crop"}
  <QualityMenu x={menu.x} y={menu.y} showFlip={true} showReveal={false}
    on:flipH={() => { onFlip("h"); menu = null; }}
    on:flipV={() => { onFlip("v"); menu = null; }}
    on:delete={() => { if (refId) deleteTarget.set([refId]); menu = null; }}
    on:close={() => (menu = null)} />
{/if}

<style>
  /* ===== Contact-sheet layout ===== */
  .roll { height: 100%; min-height: 0; display: grid; grid-template-columns: 1fr 320px; }
  .sheet-col { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .sheet-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 10px;
    padding: 6px 8px; border-bottom: 1px solid #222; flex: none; background: transparent; }
  .sheet { flex: 1; overflow-y: auto; padding: 0; background: #111111; display: flex; flex-direction: column; }
  .empty { color: var(--text-faint); padding: 16px; }

  /* ===== Film-edge toggle ===== */
  .film-edge-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer;
    background: transparent; border: none; padding: 0; margin-right: auto; }
  .film-edge-label { font-size: 13px; color: #b6b5b9; }
  .pill { position: relative; width: 38px; height: 21px; border-radius: 11px;
    background: #34343a; transition: background 0.2s; flex: none; }
  .pill-on { background: #cf9152; }
  .knob { position: absolute; top: 2px; width: 17px; height: 17px; border-radius: 50%;
    transition: left 0.2s ease, background 0.2s ease; }
  .pill-on .knob { left: 19px; background: #fff; }
  .pill:not(.pill-on) .knob { left: 2px; background: #a6a6ab; }

  /* ===== Strip container ===== */
  .strips-container { padding: 24px 26px 30px; display: flex; flex-direction: column; }

  /* ===== Filmstrip (film-edge ON) ===== */
  .filmstrip-strip { margin-bottom: 16px; }

  .rebate { background: #131210; }
  .rebate-top { border-radius: 1px 1px 0 0; }
  .rebate-bottom { border-radius: 0 0 1px 1px; }

  .sprocket-holes { height: 8px;
    background: repeating-linear-gradient(90deg,
      rgba(216,207,184,0) 0 9px,
      rgba(216,207,184,.16) 9px 15px,
      rgba(216,207,184,0) 15px 20px); }

  .frame-numbers { display: flex; height: 19px; align-items: center; }
  .frame-num { flex: 1; text-align: center;
    font: 600 10px 'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color: #7e7868; letter-spacing: .12em; }
  .frame-num.frame-pad { visibility: hidden; }

  .frames-row { display: flex; gap: 7px; background: #000; padding: 0 6px; align-items: flex-start; }
  .frame-cell { flex: 1; position: relative; background: #000;
    overflow: hidden; padding: 0; border: none; cursor: pointer; display: block;
    appearance: none; -webkit-appearance: none; }
  .frame-cell img { width: 100%; height: auto; display: block; }
  .frame-cell-pad { flex: 1; background: transparent; cursor: default; }

  .rebate-info-row { display: flex; align-items: center; gap: 11px; height: 18px; padding: 0 10px; }
  .barcode { width: 30px; height: 9px; flex: none;
    background: repeating-linear-gradient(90deg,
      #c9c3b0 0 1px, transparent 1px 3px,
      #c9c3b0 3px 4px, transparent 4px 6px,
      #c9c3b0 6px 8px, transparent 8px 11px,
      #c9c3b0 11px 12px, transparent 12px 15px,
      #c9c3b0 15px 17px, transparent 17px 19px); }
  .edge-text { background: transparent; border: none; padding: 0; cursor: text;
    font: 600 9px 'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color: #857f6f; letter-spacing: .24em; white-space: nowrap; }
  .edge-text-input { background: transparent; border: none; border-bottom: 1px solid #857f6f;
    padding: 0; outline: none;
    font: 600 9px 'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color: #857f6f; letter-spacing: .24em; white-space: nowrap;
    width: 220px; }
  .edge-arrow { font: 600 9px 'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color: #6c6657; letter-spacing: .24em; }

  /* ===== Proof grid (film-edge OFF) ===== */
  .proof-strip { display: flex; gap: 16px; padding: 0 0 16px; align-items: flex-start; }
  .proof-cell { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .proof-cell-pad { flex: 1; }
  .proof-frame { background: #d8d3c4; padding: 3px; overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,.5); border: none; cursor: pointer;
    display: block; width: 100%; appearance: none; -webkit-appearance: none; }
  .proof-frame img { width: 100%; height: auto; display: block; }
  .proof-caption { text-align: center;
    font: 600 10px 'Spline Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    color: #6f6a5e; letter-spacing: .12em; }
  .panel { border-left: 1px solid var(--glass-brd); display: flex; flex-direction: column;
    gap: 8px; padding: 12px; overflow-y: auto; }
  .export-btn { padding: 8px 16px; border-radius: 9px; font-weight: 600; font-size: 12px;
    background: var(--glass-hi); border: 1px solid var(--glass-brd); color: var(--text);
    transition: background 0.15s, border-color 0.15s; cursor: pointer; }
  .export-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  .export-btn:disabled { opacity: 0.45; cursor: default; }

  /* ===== Square icon tool buttons (Change D) ===== */
  .tool-row { display: flex; flex-direction: row; gap: 6px; margin: 10px 0; }
  .tool { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .tool-btn { width: 46px; height: 46px; border-radius: 10px; border: 1px solid var(--glass-brd);
    background: var(--glass-hi); color: var(--text-dim); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s; }
  .tool-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  .tool-btn:disabled { opacity: 0.45; cursor: default; }
  .tool-btn.on { background: rgba(244,157,78,0.14); box-shadow: inset 0 0 0 1px rgba(244,157,78,0.4);
    border-color: rgba(244,157,78,0.4); color: var(--text); }
  .tool-label { font-size: 11px; color: var(--text-dim); text-align: center; line-height: 1.2; }

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
    background: rgba(244,157,78,0.18);
    border: 1px solid rgba(244,157,78,0.5);
    color: #fff;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .done-btn:hover { background: rgba(244,157,78,0.28); border-color: rgba(244,157,78,0.7); }
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
