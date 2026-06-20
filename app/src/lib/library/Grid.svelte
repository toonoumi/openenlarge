<script lang="ts">
  import { tick, onMount } from "svelte";
  import { get } from "svelte/store";
  import { activeId, selectedFolder, gridZoom, folderImages, selection, selectClick,
    editsById, cropById, dustById, images } from "../store";
  import { api, defaultParams, type ImageEntry } from "../api";
  import { withEffectiveBase } from "../develop/base";
  import { imageDir } from "./folderScope";
  import { gridColumns, gridThumbView, GRID_HIRES_EDGE, GRID_STATIC_EDGE, GRID_HIRES_MAX_COLS } from "./gridHiRes";
  import { t } from "$lib/i18n";

  const mods = (e: MouseEvent) => ({ meta: e.metaKey || e.ctrlKey, shift: e.shiftKey });
  let scrollEl: HTMLDivElement;
  let containerW = 800;
  $: shown = $folderImages;
  const MIN = 130;
  const PADX = 16; // total horizontal padding of .scroll (8px each side)
  const GAP = 12;  // .grid gap
  // 130px at zoom 0 → full container width at zoom 100 (1 image per row).
  $: maxCol = Math.max(MIN, containerW - PADX);
  $: minCol = MIN + ($gridZoom / 100) * (maxCol - MIN);
  // Zoomed-in to ≤2 cells per row → boost the 320px thumbnail to a crisp 1080px render.
  $: cols = gridColumns(containerW, minCol, PADX, GAP);
  $: boost = cols <= GRID_HIRES_MAX_COLS;

  // --- Hi-res thumbnails (only the developed, visible cells while zoomed in) ----
  // id → { key, url }: `key` is the static thumbnail the render was made from, so a
  // later edit (which re-renders img.thumbnail) auto-invalidates the cached hi-res.
  let hiRes: Record<string, { key: string; url: string }> = {};
  let io: IntersectionObserver | null = null;
  const visible = new Set<string>();
  const inFlight = new Set<string>();

  // `cache`/`on` are passed in so Svelte tracks them as markup dependencies and
  // re-renders the <img> when a hi-res render lands or the boost threshold flips.
  function hiResSrc(img: ImageEntry, cache: typeof hiRes, on: boolean): string {
    const h = cache[img.id];
    return on && h && h.key === img.thumbnail ? h.url : img.thumbnail;
  }

  async function renderHiRes(img: ImageEntry) {
    const id = img.id, key = img.thumbnail;
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const params = withEffectiveBase(get(editsById)[id] ?? defaultParams(), imageDir(img));
      const view = gridThumbView(get(cropById)[id], get(dustById)[id], GRID_HIRES_EDGE);
      const url = await api.thumbnail(id, params, view);
      hiRes = { ...hiRes, [id]: { key, url } };
    } catch { /* not developed yet / decode failed → keep the static thumbnail */ }
    finally { inFlight.delete(id); }
  }

  // Lazily regenerate a stale static thumbnail (baked by an older render engine, e.g.
  // pre-filmic) the first time its cell is visible — reusing the proven render path
  // (resident-LRU bounded). For never-opened images we bake the same auto-WB seed the
  // develop-time thumbnail uses; opened images render from their saved edits. One
  // regen per image: saveThumbnail stamps the engine version, clearing thumb_stale.
  async function regenStale(img: ImageEntry) {
    if (!img.developed || !img.thumb_stale || inFlight.has(img.id)) return;
    inFlight.add(img.id);
    try {
      const dir = imageDir(img);
      const saved = get(editsById)[img.id];
      let params;
      if (saved) {
        params = withEffectiveBase(saved, dir);
      } else {
        const seed = withEffectiveBase({ ...defaultParams(), positive: img.positive }, dir);
        const wb = await api.asShotWb(img.id, seed, null, { rot90: 0, flip_h: false, flip_v: false, angle: 0 });
        params = { ...seed, temp: wb.temp, tint: wb.tint };
      }
      const view = gridThumbView(get(cropById)[img.id], get(dustById)[img.id], GRID_STATIC_EDGE);
      const url = await api.thumbnail(img.id, params, view);
      await api.saveThumbnail(img.id, url);
      images.update((list) =>
        list.map((i) => (i.id === img.id ? { ...i, thumbnail: url, thumb_stale: false } : i)));
    } catch { /* not developed yet / decode failed → leave stale, retry on next view */ }
    finally { inFlight.delete(img.id); }
  }

  // For every visible developed cell: refresh a stale static thumbnail first, else
  // (when zoomed) render the hi-res boost.
  function ensureVisible() {
    for (const id of visible) {
      const img = shown.find((i) => i.id === id);
      if (!img?.developed) continue;
      if (img.thumb_stale) { regenStale(img); continue; }
      if (boost && hiRes[id]?.key !== img.thumbnail) renderHiRes(img);
    }
  }
  $: boost, shown, ensureVisible(); // re-check when zoom crosses the threshold or list changes

  // (Re)observe cells so we only render what's on screen; rootMargin pre-warms a little.
  async function reobserve() {
    if (!io || !scrollEl) return;
    await tick();
    io.disconnect();
    visible.clear();
    scrollEl.querySelectorAll(".cell").forEach((el) => io!.observe(el));
  }
  $: shown, reobserve();

  onMount(() => {
    const measure = () => { if (scrollEl) containerW = scrollEl.clientWidth; };
    measure();
    const ro = new ResizeObserver(measure);
    if (scrollEl) ro.observe(scrollEl);
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.id;
        if (!id) continue;
        if (e.isIntersecting) visible.add(id); else visible.delete(id);
      }
      ensureVisible();
    }, { root: scrollEl, rootMargin: "200px" });
    reobserve();
    return () => { ro.disconnect(); io?.disconnect(); };
  });

  // ctrl/cmd + scroll (and trackpad pinch) resize thumbnails; plain scroll scrolls.
  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      gridZoom.update((z) => Math.max(0, Math.min(100, z - e.deltaY * 0.5)));
    }
  }

  // Keep the active image visible in the grid whenever selection changes
  // (from the grid, the filmstrip, or arrow keys) — only if it's in this folder.
  async function revealActive() {
    await tick();
    if (scrollEl && $activeId) {
      scrollEl.querySelector(`[data-id="${$activeId}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }
  $: $activeId, revealActive();
</script>

<div class="center">
  <div class="head">
    <div class="where"><b>{$selectedFolder?.split("/").pop() ?? "—"}</b> · {$t('grid.imageCount', { count: shown.length, plural: shown.length === 1 ? '' : 's' })}</div>
    <div class="right">{$t('grid.thumbSize')} <input class="zoom" type="range" min="0" max="100" bind:value={$gridZoom} /></div>
  </div>
  <div class="scroll" bind:this={scrollEl} role="listbox" aria-label={$t('grid.folderImagesAria')} on:wheel={onWheel}>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax({minCol}px,1fr))">
      {#each shown as img (img.id)}
        <button data-id={img.id} class="cell" class:sel={$activeId === img.id}
          class:multi={$selection.selected.has(img.id)}
          on:click={(e) => selectClick(img.id, mods(e))}>
          <div class="ratio"><img src={hiResSrc(img, hiRes, boost)} alt={img.file_name} /></div>
        </button>
      {/each}
    </div>
    {#if shown.length === 0}<div class="empty">{$t('grid.selectFolder')}</div>{/if}
  </div>
</div>

<style>
  .center { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .head { display: flex; align-items: center; gap: 12px; padding: 2px 4px 12px; }
  .where { color: var(--text-dim); } .where b { color: var(--text); }
  .right { margin-left: auto; display: flex; align-items: center; gap: 9px; color: var(--text-faint); font-size: 12px; }
  .zoom { appearance: none; width: 120px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.14); outline: 0; }
  .zoom::-webkit-slider-thumb { appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #fff; }
  .scroll { flex: 1; overflow-y: auto; padding: 4px 8px; outline: none; }
  .grid { display: grid; gap: 12px; align-content: start; }
  .cell { display: block; padding: 0; border: 1px solid var(--glass-brd); border-radius: 11px;
    overflow: hidden; background: #0d0d10; cursor: pointer; transition: box-shadow 0.12s; }
  .cell:hover { box-shadow: 0 12px 26px rgba(0,0,0,0.5); }
  .cell.multi { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent), 0 12px 26px rgba(0,0,0,0.5); }
  .cell.sel { border-color: #fff; box-shadow: 0 0 0 2px #fff, 0 12px 26px rgba(0,0,0,0.5); }
  .ratio { position: relative; width: 100%; height: 0; padding-bottom: 100%; }
  .ratio img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
  .empty { color: var(--text-faint); padding: 16px; }
</style>
