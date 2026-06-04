<script lang="ts">
  import { onMount } from "svelte";
  import { api, type InvertParams } from "../api";

  export let id: string | null;
  export let params: InvertParams;
  export let imgW = 0;
  export let imgH = 0;
  export let raw = false;
  export let interactive = true;

  // Max rendered long edge. The whole image is rendered at the zoom resolution
  // (capped here) so panning is pure CSS with no re-fetch. True 1:1 for images
  // up to this size; larger files (e.g. 100MP) are rendered slightly soft.
  const CAP = 5000;

  let el: HTMLDivElement;
  let src = "";
  let vpW = 0, vpH = 0;
  let scale = 0;        // display px per image px (0 = uninitialised → Fit)
  let cx = 0, cy = 0;   // image-space point centred in the viewport
  let prevId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Only treat dimensions as usable once both image AND viewport are measured;
  // otherwise `fit` would be a bogus 1.0 (=100%) and the first frame magnifies.
  $: ready = imgW > 0 && imgH > 0 && vpW > 0 && vpH > 0;
  $: fit = ready ? Math.min(vpW / imgW, vpH / imgH) : 0;
  $: eff = interactive ? (scale > 0 ? scale : fit) : fit; // effective display scale
  $: zoomed = interactive && eff > fit + 1e-6;
  $: label = eff <= fit + 1e-6 ? "Fit" : Math.round(eff * 100) + "%";

  // Keep (cx,cy) so the image always covers the viewport when zoomed in.
  function clampCenter() {
    const halfW = vpW / 2 / eff, halfH = vpH / 2 / eff;
    cx = imgW * eff <= vpW ? imgW / 2 : Math.max(halfW, Math.min(imgW - halfW, cx));
    cy = imgH * eff <= vpH ? imgH / 2 : Math.max(halfH, Math.min(imgH - halfH, cy));
  }

  // Bitmap = the whole image at `eff` scale; position it so (cx,cy) is centred.
  $: dispW = imgW * eff;
  $: dispH = imgH * eff;
  $: left = vpW / 2 - cx * eff;
  $: top = vpH / 2 - cy * eff;

  function measure() {
    if (!el) return;
    vpW = el.clientWidth; vpH = el.clientHeight;
  }
  onMount(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (el) ro.observe(el);
    return () => ro.disconnect();
  });

  // Reset to Fit when the image changes — but only once `fit` is known, so the
  // first frame is never accidentally magnified to 100%.
  $: if (id !== prevId) { prevId = id; scale = 0; cx = imgW / 2; cy = imgH / 2; }
  $: if (interactive && scale === 0 && fit > 0) scale = fit;

  // Render the WHOLE image at the effective scale (capped). Pan does NOT call
  // this — only image/params/zoom-level/viewport changes do.
  async function render() {
    if (!id || !imgW || !vpW) { src = ""; return; }
    const rscale = Math.min(eff, CAP / Math.max(imgW, imgH));
    const out_w = Math.max(1, Math.round(imgW * rscale));
    const out_h = Math.max(1, Math.round(imgH * rscale));
    try {
      src = await api.renderView(id, params, { crop: [0, 0, imgW, imgH], out_w, out_h, raw });
    } catch { /* keep previous frame */ }
  }
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(render, 80); }
  function scheduleIfReady() { if (id && vpW && imgW) { clampCenter(); schedule(); } }

  // Re-render on image / params / zoom-level / viewport changes (NOT on pan).
  $: id, vpW, vpH, imgW, imgH, params, raw, eff, scheduleIfReady();

  function imgPoint(e: { clientX: number; clientY: number }): [number, number] {
    const rect = el.getBoundingClientRect();
    return [(e.clientX - rect.left - left) / eff, (e.clientY - rect.top - top) / eff];
  }

  function onWheel(e: WheelEvent) {
    if (!interactive) return;
    e.preventDefault();
    const [ix, iy] = imgPoint(e);
    const ns = Math.min(8, Math.max(fit, eff * Math.exp(-e.deltaY * 0.0015)));
    cx = ix + (cx - ix) * (eff / ns);
    cy = iy + (cy - iy) * (eff / ns);
    scale = ns;
  }

  // Tap toggles Fit↔100%; drag pans (only when zoomed). Pan moves (cx,cy) which
  // repositions the bitmap via CSS instantly — no re-render.
  let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false, panning = false;
  function onDown(e: PointerEvent) {
    if (!interactive) return;
    downX = lastX = e.clientX; downY = lastY = e.clientY; moved = false;
    panning = zoomed;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!interactive || !(e.buttons & 1)) return;
    if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true;
    if (panning && moved) {
      cx -= (e.clientX - lastX) / eff;
      cy -= (e.clientY - lastY) / eff;
      clampCenter();
    }
    lastX = e.clientX; lastY = e.clientY;
  }
  function onUp(e: PointerEvent) {
    if (interactive && !moved) {
      const [ix, iy] = imgPoint(e);
      if (zoomed) { scale = fit; cx = imgW / 2; cy = imgH / 2; }
      else { scale = 1.0; cx = ix; cy = iy; }
    }
    panning = false; moved = false;
  }
  function onCancel() { panning = false; moved = false; }
</script>

<div
  class="vp" class:interactive class:zoomed
  bind:this={el}
  on:wheel={onWheel}
  on:pointerdown={onDown} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onCancel}
>
  {#if src}
    <img
      {src} alt="preview" draggable="false"
      style="position:absolute; width:{dispW}px; height:{dispH}px; left:{left}px; top:{top}px;"
    />
  {:else}<div class="hint">…</div>{/if}
  {#if id && interactive}<div class="zoom">{label}</div>{/if}
</div>

<style>
  .vp { position: relative; width: 100%; height: 100%; overflow: hidden; user-select: none;
    border-radius: 10px; }
  .vp.interactive { cursor: zoom-in; }
  .vp.zoomed { cursor: grab; }
  .vp.zoomed:active { cursor: grabbing; }
  img { display: block; will-change: left, top, width, height; }
  .hint { color: var(--text-dim); position: absolute; inset: 0; display: grid; place-items: center; }
  .zoom { position: absolute; bottom: 8px; right: 10px; font-size: 11px; color: var(--text-dim);
    background: rgba(0,0,0,0.45); padding: 2px 8px; border-radius: 6px; z-index: 2; }
</style>
