<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { api, type InvertParams } from "../api";
  import type { ScreenRect } from "../crop/cropMath";

  export let id: string | null;
  export let params: InvertParams;
  export let imgW = 0;   // working-image dims (uncropped, oriented identity)
  export let imgH = 0;

  const dispatch = createEventDispatcher<{ sampled: [number, number, number] }>();
  const PAD = 60;
  // Long-edge cap for the source render. Shared by the on-screen view AND the
  // loupe, so the loupe zooms real working-image pixels (the same buffer the
  // backend samples) rather than an upscaled display proxy.
  const CAP = 2400;
  // Sampled patch as a fraction of image WIDTH; height matched for square px.
  // Small (~0.4%) so it fits inside a thin rebate without straddling the scene;
  // the loupe lets the user aim it, and the backend trims grain/dust over it.
  // Scroll-wheel over the picker grows/shrinks it around the cursor (clamped),
  // so the user can dial the patch to the rebate width on the fly.
  const PATCH_DEFAULT = 0.004;
  const PATCH_MIN = 0.001;
  const PATCH_MAX = 0.02; // at this size the reticle fills the loupe (= LOUPE_FRAC)
  const PATCH_STEP = 1.12; // multiplicative zoom per wheel notch
  let patch = PATCH_DEFAULT;
  // Loupe geometry: a circular pixel-zoom that follows the cursor.
  const LOUPE_D = 184;          // diameter (px)
  const LOUPE_FRAC = 0.02;      // fraction of image WIDTH shown across the loupe
  const LOUPE_GAP = 22;         // offset from the cursor

  let el: HTMLDivElement;
  let src = "";
  let vpW = 0, vpH = 0;
  let mark: { x: number; y: number } | null = null; // last sampled point (normalized)
  let hover: { sx: number; sy: number; nx: number; ny: number } | null = null;

  function measure() { if (el) { vpW = el.clientWidth; vpH = el.clientHeight; } }
  onMount(() => { measure(); const ro = new ResizeObserver(measure); if (el) ro.observe(el); return () => ro.disconnect(); });

  $: avW = Math.max(1, vpW - 2 * PAD);
  $: avH = Math.max(1, vpH - 2 * PAD);
  $: fit = imgW > 0 && imgH > 0 && vpW > 0 ? Math.min(avW / imgW, avH / imgH) : 0;
  $: dispW = imgW * fit;
  $: dispH = imgH * fit;
  $: imgScreen = { left: (vpW - dispW) / 2, top: (vpH - dispH) / 2, width: dispW, height: dispH } as ScreenRect;

  let lastKey = "";
  async function render() {
    if (!id || !imgW || !vpW) return;
    const rscale = Math.min(1, CAP / Math.max(imgW, imgH));
    const out_w = Math.max(1, Math.round(imgW * rscale));
    const out_h = Math.max(1, Math.round(imgH * rscale));
    try {
      src = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw: true, finish: false,
        image_crop: null, rot90: 0, flip_h: false, flip_v: false, angle: 0,
      });
    } catch { /* keep last */ }
  }
  $: key = `${id}|${vpW}|${vpH}|${imgW}|${imgH}`;
  $: if (key !== lastKey) { lastKey = key; render(); }

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // Sample a small averaged patch centered on a normalized point in the raw negative.
  async function sampleAt(nx: number, ny: number) {
    if (!id) return;
    const w = patch;
    const h = imgH > 0 ? patch * (imgW / imgH) : patch; // square in pixels
    const x = clamp01(nx - w / 2);
    const y = clamp01(ny - h / 2);
    const rect: [number, number, number, number] = [x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)];
    try {
      const b = await api.sampleBaseAt(id, rect);
      dispatch("sampled", b);
    } catch { /* ignore */ }
  }

  // Normalized image coords from a pointer event, or null if outside the negative.
  function locate(e: MouseEvent): { sx: number; sy: number; nx: number; ny: number } | null {
    if (!dispW || !dispH) return null;
    const r = el.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const nx = (sx - imgScreen.left) / dispW;
    const ny = (sy - imgScreen.top) / dispH;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { sx, sy, nx, ny };
  }

  function onMove(e: MouseEvent) { hover = locate(e); }
  function onLeave() { hover = null; }

  function onClick(e: MouseEvent) {
    const p = locate(e);
    if (!p) return; // clicked outside the negative
    mark = { x: p.nx, y: p.ny };
    sampleAt(p.nx, p.ny);
  }

  // Re-sampling is debounced so a fast scroll doesn't flood the backend; the
  // reticle still resizes live (it's driven by `patch` reactively).
  let resampleTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleResample(nx: number, ny: number) {
    if (resampleTimer) clearTimeout(resampleTimer);
    resampleTimer = setTimeout(() => { resampleTimer = null; sampleAt(nx, ny); }, 70);
  }

  // Scroll over the picker grows/shrinks the sample rect around the cursor and
  // re-samples the base there. Up = grow, down = shrink (clamped to min/max).
  function onWheel(e: WheelEvent) {
    const p = locate(e) ?? hover;
    if (!p) return; // pointer not over the negative
    const factor = e.deltaY < 0 ? PATCH_STEP : 1 / PATCH_STEP;
    const next = Math.min(PATCH_MAX, Math.max(PATCH_MIN, patch * factor));
    if (next === patch) return; // already at a clamp; nothing to do
    patch = next;
    mark = { x: p.nx, y: p.ny };
    scheduleResample(p.nx, p.ny);
  }

  // ── Loupe placement & content ────────────────────────────────────────────
  // Background sized so the cursor's image point sits at the loupe center, with
  // `image-rendering: pixelated` so individual pixels are visible for aiming.
  $: bgW = LOUPE_D / LOUPE_FRAC;
  $: bgH = imgW > 0 ? bgW * (imgH / imgW) : bgW;
  $: reticle = patch * bgW; // sample-patch size in loupe px (square)
  // Flip the loupe to whichever side keeps it on-screen.
  $: loupeLeft = hover
    ? (hover.sx + LOUPE_GAP + LOUPE_D <= vpW ? hover.sx + LOUPE_GAP : hover.sx - LOUPE_GAP - LOUPE_D)
    : 0;
  $: loupeTop = hover
    ? (hover.sy - LOUPE_GAP - LOUPE_D >= 0 ? hover.sy - LOUPE_GAP - LOUPE_D : hover.sy + LOUPE_GAP)
    : 0;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div class="basevp" bind:this={el} on:click={onClick} on:mousemove={onMove} on:mouseleave={onLeave} on:wheel|preventDefault={onWheel}>
  {#if src}
    <img {src} alt="negative" draggable="false"
      style="position:absolute; left:{imgScreen.left}px; top:{imgScreen.top}px; width:{dispW}px; height:{dispH}px;" />
    {#if mark}
      <div class="mark" style="left:{imgScreen.left + mark.x * dispW}px; top:{imgScreen.top + mark.y * dispH}px;"></div>
    {/if}
    {#if hover}
      <!-- focus dot at the cursor on the full image, for context -->
      <div class="focus" style="left:{hover.sx}px; top:{hover.sy}px;"></div>
      <!-- pixel-zoom loupe -->
      <div class="loupe" style="left:{loupeLeft}px; top:{loupeTop}px; width:{LOUPE_D}px; height:{LOUPE_D}px;
        background-image:url('{src}');
        background-size:{bgW}px {bgH}px;
        background-position:{LOUPE_D / 2 - hover.nx * bgW}px {LOUPE_D / 2 - hover.ny * bgH}px;">
        <div class="reticle" style="width:{reticle}px; height:{reticle}px;"></div>
      </div>
    {/if}
  {:else}<div class="hint">…</div>{/if}
</div>

<style>
  .basevp { position: relative; width: 100%; height: 100%; overflow: hidden;
    border-radius: 10px; user-select: none; cursor: crosshair; }
  .hint { color: var(--text-dim); position: absolute; inset: 0; display: grid; place-items: center; }
  .mark { position: absolute; width: 14px; height: 14px; transform: translate(-50%, -50%);
    border: 2px solid rgba(120,220,255,0.95); border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5); pointer-events: none; }
  .focus { position: absolute; width: 5px; height: 5px; transform: translate(-50%, -50%);
    background: rgba(120,220,255,0.95); border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.6); pointer-events: none; }
  .loupe { position: absolute; border-radius: 50%; pointer-events: none;
    background-repeat: no-repeat; image-rendering: pixelated;
    border: 2px solid rgba(255,255,255,0.85);
    box-shadow: 0 2px 10px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.5); }
  .loupe .reticle { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    border: 1.5px solid rgba(120,220,255,0.95);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.7); }
</style>
