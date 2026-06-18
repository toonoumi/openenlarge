<script lang="ts">
  import { onMount, createEventDispatcher } from "svelte";
  import { api, type InvertParams } from "../api";
  import type { IrRemoval } from "../api";
  import { previewSrc, previewById, cachePreview } from "../store";
  import { FinishRenderer, webgl2Available, float16RenderTargetSupported } from "./gl/renderer";
  import { finishUniforms } from "./gl/uniforms";
  import { toInversionUniforms } from "./gl/invert";
  import { clipUniforms } from "./gl/clip";
  import { toneLutBytes, colorGrade, colorMix } from "../develop/finish";
  import { screenRadius, type DustStroke } from "../develop/dust";
  import { marqueeZoom } from "./marquee";
  import { readCanvasPixel } from "../develop/colorPick";
  import { orientUVMatrix, displayToSourceUV } from "../crop/transforms";
  import { t } from "$lib/i18n";

  export let id: string | null;
  export let params: InvertParams;
  export let imgW = 0;
  export let imgH = 0;
  export let raw = false;
  export let interactive = true;
  export let imageCrop: [number, number, number, number] | null = null;
  export let rot90 = 0;
  export let flipH = false;
  export let flipV = false;
  export let angle = 0;
  export let eraser = false;
  /** Marquee-zoom armed: the next drag draws a zoom rectangle instead of painting. */
  export let marquee = false;
  export let pointPick = false;
  /** Brush radius normalized to image width. */
  export let brush = 0.03;
  /** Committed strokes for this image (rendered by the backend). */
  export let dust: DustStroke[] = [];
  /** Bumped by the parent on any dust change to force a re-render. */
  export let dustRev = 0;
  export let developRev = 0;
  export let irRemoval: IrRemoval = { enabled: false, sensitivity: 50 };
  /** AI-fill mode: show strokes as a red mask overlay (unhealed) until applied. */
  export let brushMigan = false;
  /** Whether the strokes have been MI-GAN-applied (heal baked) vs shown as overlay. */
  export let aiApplied = false;
  /** AI auto-dust: detector-driven defect heal, live on the main display. */
  export let autoDustEnabled = false;
  export let autoDustSensitivity = 50;
  /** Clipping-warning overlay toggles (GPU path only). */
  export let clipHigh = false;
  export let clipLow = false;
  export let clipStrict = false;
  /** Catalog thumbnail data-URL for the active image — shown as the switch-gap
   *  overlay when this image has no cached fit-view preview yet (first view). */
  export let fallbackThumb = "";

  const dispatch = createEventDispatcher<{ stroke: DustStroke; brush: number; pointpick: { r: number; g: number; b: number; u: number; v: number }; aierased: void; autodusted: void; zoomchange: boolean; marqueedone: void }>();

  const CAP = 5000;
  const PAD = 60;

  let el: HTMLDivElement;
  let canvas: HTMLCanvasElement | null = null;
  let renderer: FinishRenderer | null = null;
  // GPU path: only the interactive, non-raw develop canvas, when WebGL2 exists.
  const useGL = interactive && !raw && webgl2Available();

  let src = "";
  let vpW = 0, vpH = 0;
  let scale = 0;
  let cx = 0, cy = 0;
  let prevId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let histTimer: ReturnType<typeof setTimeout> | null = null;
  let animating = false;
  let animTimer: ReturnType<typeof setTimeout> | null = null;

  // GPU upload state. The working buffer is uploaded to the GPU as a float texture;
  // inversion + geometry then update via uniforms. In bake mode the upload re-fires
  // when strokes/geometry change (keyed by uploadKey); otherwise once per image.
  let uploadKey = "";
  let texW = 0, texH = 0;
  // True once the NEW image's texture + inversion are uploaded and a correct frame
  // has been drawn. Reset on image switch so the stale-frame draws (finishKey below,
  // and geomKey/invKey via the texW===0 guard) are suppressed until that single
  // correct draw — `preserveDrawingBuffer` keeps the prior frame visible meanwhile.
  // Also gates hiding the per-image preview overlay.
  let frameReady = false;

  $: ready = imgW > 0 && imgH > 0 && vpW > 0 && vpH > 0;
  $: pad = interactive ? PAD : 0;
  $: avW = Math.max(1, vpW - 2 * pad);
  $: avH = Math.max(1, vpH - 2 * pad);
  $: fit = ready ? Math.min(avW / imgW, avH / imgH) : 0;
  $: eff = interactive ? (scale > 0 ? scale : fit) : fit;
  $: zoomed = interactive && eff > fit + 1e-6;
  $: label = eff <= fit + 1e-6 ? $t("viewport.fit") : $t("viewport.zoomPercent", { percent: Math.round(eff * 100) });

  // Deep-zoom tier: when the on-screen (device-pixel) long edge exceeds the proxy's
  // native pixels AND the source has more resolution to offer, request the high-res
  // texture. Hysteresis (enter > PROXY_EDGE, leave < 0.9×) avoids thrash at the edge.
  const PROXY_EDGE = 2560;
  let hiTier = false;
  $: {
    const srcLong = Math.max(imgW, imgH);
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const dispDevice = eff * srcLong * dpr;
    if (srcLong <= PROXY_EDGE) hiTier = false; // nothing sharper than the proxy to fetch
    else if (!hiTier && dispDevice > PROXY_EDGE) hiTier = true;
    else if (hiTier && dispDevice < PROXY_EDGE * 0.9) hiTier = false;
  }

  // `e` defaults to the current effective scale, but callers that have just
  // reassigned `scale` must pass the new value: `eff` is a reactive derived
  // value that hasn't recomputed yet within the same tick, so clamping against
  // the stale `eff` (still fit) would wrongly re-center the view.
  function clampCenter(e = eff) {
    const halfW = avW / 2 / e, halfH = avH / 2 / e;
    cx = imgW * e <= avW ? imgW / 2 : Math.max(halfW, Math.min(imgW - halfW, cx));
    cy = imgH * e <= avH ? imgH / 2 : Math.max(halfH, Math.min(imgH - halfH, cy));
  }

  $: dispW = imgW * eff;
  $: dispH = imgH * eff;
  $: left = vpW / 2 - cx * eff;
  $: top = vpH / 2 - cy * eff;

  function measure() {
    if (!el) return;
    vpW = el.clientWidth; vpH = el.clientHeight;
  }
  onMount(() => {
    const v = float16RenderTargetSupported();
    console.log(`[SPIKE float16] ok=${v.ok} reason="${v.reason}"`);
    measure();
    if (useGL && canvas) {
      const r = new FinishRenderer(canvas);
      if (r.available) renderer = r;
    }
    const ro = new ResizeObserver(measure);
    if (el) ro.observe(el);
    return () => {
      ro.disconnect();
      // Free the WebGL context on unmount — otherwise every remount leaks one and
      // WebKit stalls the app once it caps out (~16 contexts).
      renderer?.dispose();
      renderer = null;
    };
  });

  $: if (id !== prevId) {
    prevId = id; scale = 0; cx = imgW / 2; cy = imgH / 2;
    // Invalidate GPU readiness synchronously so this flush's stale-texture redraws
    // (geomKey/invKey/finishKey, fired by the new image's params) are blocked until
    // uploadWorking binds the new texture and draws once. uploadKey reset forces the
    // re-upload (its key includes id, but resetting is explicit).
    texW = 0; texH = 0; uploadKey = ""; frameReady = false;
  }
  $: if (interactive && scale === 0 && fit > 0) scale = fit;

  // Decode a JPEG data-URL to an <img> we can upload as a texture.
  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
  }

  // Fetch the source preview. With GL, request the PRE-FINISH image (finish:false)
  // and apply finishing in the shader; otherwise fetch the finished image.
  async function render() {
    if (gpuEligible) return; // GPU path owns eligible images; this is the CPU fallback only
    if (!id || !imgW || !vpW) { src = ""; return; }
    const rscale = Math.min(eff, CAP / Math.max(imgW, imgH));
    const out_w = Math.max(1, Math.round(imgW * rscale));
    const out_h = Math.max(1, Math.round(imgH * rscale));
    try {
      const data = await api.renderView(id, params, {
        crop: [0, 0, imgW, imgH], out_w, out_h, raw, finish: !(useGL && renderer),
        image_crop: imageCrop, rot90, flip_h: flipH, flip_v: flipV, angle, dust, ir_removal: irRemoval,
      });
      if (useGL && renderer) {
        const im = await loadImage(data);
        renderer.setSource(im, out_w, out_h);
        drawGL();
      } else {
        src = data;
        if (interactive && !raw) previewSrc.set(src);
      }
    } catch (e) {
      // "not developed" is expected for thumbnails of not-yet-developed images;
      // anything else is a real error worth surfacing (don't swallow silently).
      if (!(typeof e === "string" && e === "not developed")) console.error("renderView failed", e);
      /* keep previous frame */
    }
  }

  function drawGL() {
    if (!renderer) return;
    renderer.setUniforms(finishUniforms(params));
    renderer.setLut(toneLutBytes(params));
    renderer.setColorGrade(colorGrade(params));
    renderer.setColorMix(colorMix(params));
    renderer.setClip(clipUniforms({ high: clipHigh, low: clipLow, strict: clipStrict }));
    renderer.draw();
    // Publish a snapshot for the histogram (debounced; toDataURL is cheap-ish). Also
    // stash it as this image's fit-view preview so a later switch back shows it
    // instantly (skip while zoomed — a zoomed crop is a poor switch-in preview).
    if (canvas) {
      if (histTimer) clearTimeout(histTimer);
      const cv = canvas;
      const capId = id;
      const cache = gpuEligible && !zoomed;
      histTimer = setTimeout(() => {
        const url = cv.toDataURL("image/jpeg", 0.8);
        previewSrc.set(url);
        if (cache && capId) cachePreview(capId, url);
      }, 120);
    }
  }

  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(render, 80); }
  function scheduleIfReady() { if (id && vpW && imgW) { clampCenter(); schedule(); } }

  // ---- HDR gain-map overlay (settle mode) ----------------------------------
  // When params.hdr is on we render a gain-map JPEG via api.encodeHdr and crossfade
  // it in over the live SDR canvas once an edit settles. During an active gesture
  // (any params/geometry change) the overlay fades out so the live SDR is visible.
  let hdrSrc = "";
  let hdrShown = false;
  let hdrTimer: ReturnType<typeof setTimeout> | null = null;
  let hdrPrevId: string | null = null;

  // Build the SAME ViewSpec the live render uses for the current frame (geometry,
  // persistent crop, dust/IR). HDR is a settled full-frame preview, so we render at
  // the fit-scaled image dims (capped) like render() does — no zoom/pan view crop.
  function hdrViewSpec(): import("../api").ViewSpec {
    const rscale = Math.min(eff, CAP / Math.max(imgW, imgH));
    const out_w = Math.max(1, Math.round(imgW * rscale));
    const out_h = Math.max(1, Math.round(imgH * rscale));
    return {
      crop: [0, 0, imgW, imgH], out_w, out_h, raw, finish: true,
      image_crop: imageCrop, rot90, flip_h: flipH, flip_v: flipV, angle, dust, ir_removal: irRemoval,
    };
  }

  async function encodeHdr() {
    if (!params.hdr || !id || !imgW || !vpW) return;
    const curId = id;
    try {
      const data = await api.encodeHdr(id, params, hdrViewSpec());
      if (id !== curId || !params.hdr) return; // image switched or toggled off mid-encode
      hdrSrc = data;
      hdrShown = true;
    } catch (e) {
      // "not developed" etc. are expected; swallow like seed()/reanalyze().
      if (!(typeof e === "string" && e === "not developed")) console.error("encodeHdr failed", e);
    }
  }

  // Any edit (params/geometry change) hides the overlay immediately (live SDR shows
  // through), then debounces an encode that fades HDR back in once things settle.
  function scheduleHdr() {
    hdrShown = false; // live SDR while dragging
    if (hdrTimer) clearTimeout(hdrTimer);
    if (!params.hdr || !id) return;
    hdrTimer = setTimeout(encodeHdr, 200);
  }

  // Clear the overlay on image switch so a stale HDR frame never shows for the wrong photo.
  $: if (id !== hdrPrevId) { hdrPrevId = id; hdrSrc = ""; hdrShown = false; if (hdrTimer) clearTimeout(hdrTimer); }

  // Re-run on any input that changes the rendered frame, plus the HDR toggle itself.
  $: hdrKey = `${id}|${params.hdr}|${developRev}|${invKey}|${finishKey}|${geomKey}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${vpW > 0}`;
  $: if (params.hdr) { hdrKey; if (id && vpW && imgW) scheduleHdr(); }
  $: if (!params.hdr) { hdrShown = false; if (hdrTimer) clearTimeout(hdrTimer); }

  // GPU path: WebGL2 available + non-raw. Dust/IR now stay on the GPU via a baked
  // (geometry + pre-invert heal) working texture; only raw/no-WebGL2 fall to CPU.
  $: gpuEligible = !!(useGL && renderer && !raw);
  // Bake mode: dust/IR active → request the baked working texture + identity geometry.
  $: bakeMode = dust.length > 0 || irRemoval.enabled || autoDustEnabled;

  // Key the uploaded working texture. In bake mode it depends on dust strokes + the
  // baked geometry (re-bake on commit/geometry change); else just the image id.
  // Contract: the parent must bump `dustRev` on any change to `dust` (it's the proxy
  // for stroke changes here — the dust array itself is not in the key).
  function currentUploadKey(): string {
    const tier = hiTier ? 'hi' : 'lo';
    if (bakeMode) {
      return `bake|${tier}|${id}|${developRev}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${brushMigan}|${aiApplied}|${autoDustEnabled}|${autoDustSensitivity}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}`;
    }
    return `raw|${tier}|${id}|${developRev}`;
  }

  // Upload the working float texture to the GPU. In bake mode, fetch the BAKED
  // (geometry + pre-invert heal) buffer; else the raw working buffer. Sets uniforms
  // + draws after upload. Re-fetches only when the upload key changes.
  async function uploadWorking() {
    if (!gpuEligible || !id || !renderer) return;
    const key = currentUploadKey();
    if (uploadKey === key) return; // already on the GPU for these inputs
    const k = key;
    try {
      if (bakeMode) {
        const spec = {
          rot90, flip_h: flipH, flip_v: flipV, angle,
          image_crop: imageCrop, dust, ir_removal: irRemoval,
          migan: brushMigan && aiApplied,
          skip_dust_heal: brushMigan && !aiApplied,
          auto_dust: { enabled: autoDustEnabled, sensitivity: autoDustSensitivity },
        };
        const info = await api.workingBakedInfo(id, spec, hiTier);
        const buf = await api.workingBakedPixels(id, spec, params, hiTier);
        if (!renderer || currentUploadKey() !== k) return; // stale (params changed mid-fetch)
        renderer.setSourceFloat(new Uint16Array(buf), info.w, info.h);
        texW = info.w; texH = info.h;
        if (spec.migan) dispatch("aierased"); // MI-GAN apply bake finished → clear the button spinner
        if (spec.auto_dust.enabled) dispatch("autodusted"); // auto-dust heal bake finished → clear toggle spinner
      } else {
        const info = await api.workingInfo(id, hiTier);
        const buf = await api.workingPixels(id, hiTier);
        if (!renderer || currentUploadKey() !== k) return; // image changed mid-fetch
        renderer.setSourceFloat(new Uint16Array(buf), info.w, info.h);
        texW = info.w; texH = info.h;
      }
      uploadKey = k;
      await refreshInversion();
      applyGeometryAndDraw();
    } catch (e) {
      // Expected when the target image isn't developed/cached yet (matches render()'s
      // CPU-path handling). Leave uploadKey unset so a later trigger (developRev bump,
      // or any structural change) retries; frameReady stays false so the cached-preview
      // / thumbnail overlay keeps covering the canvas instead of a stuck stale frame.
      if (!(typeof e === "string" && e === "not developed")) console.error("uploadWorking failed", e);
    }
  }

  // Resolve inversion params (+ sampled base) into GPU uniforms — no fetch of pixels.
  async function refreshInversion() {
    if (!gpuEligible || !id || !renderer) return;
    const curId = id;
    const res = await api.resolvedInversion(id, params);
    if (id !== curId || !renderer) return;
    renderer.setInversion(toInversionUniforms(res));
  }

  // Map orient/flip/straighten/persistent-crop into GPU geometry uniforms, then draw.
  function applyGeometryAndDraw() {
    if (!gpuEligible || !renderer || texW === 0) return; // no texture uploaded yet
    // Bake mode: geometry is already baked into the texture → identity + baked dims.
    if (bakeMode) {
      renderer.setGeometry({
        crop_off: [0, 0], crop_scale: [1, 1], angle: 0, aspect: 1,
        orient: [1, 0, 0, 1], raw, outW: texW, outH: texH,
      });
      drawGL();
      frameReady = true; // correct frame for the current image is now on screen
      return;
    }
    // u_orient: oriented-UV → source-UV (undoes rot90/flip). Crop is in oriented UV.
    const o = orientUVMatrix(rot90, flipH, flipV);
    const [cropX, cropY, cropW, cropH] = imageCrop ?? [0, 0, 1, 1];
    // Oriented (pre-crop) pixel dims; for odd rot90 the source dims swap.
    const swap = (rot90 % 2) === 1;
    const oW = swap ? texH : texW, oH = swap ? texW : texH;
    // Output canvas = the crop window of the oriented image.
    const outW = Math.max(1, Math.round(oW * cropW));
    const outH = Math.max(1, Math.round(oH * cropH));
    renderer.setGeometry({
      crop_off: [cropX, cropY], crop_scale: [cropW, cropH],
      angle: (angle * Math.PI) / 180, aspect: oH / oW, orient: o,
      raw, outW, outH,
    });
    drawGL();
    frameReady = true; // correct frame for the current image is now on screen
  }

  // Upload the working float texture. Re-fires when the image changes or, in bake
  // mode, when strokes/IR/geometry change (currentUploadKey dedupes redundant runs).
  $: if (gpuEligible) { id; developRev; dustRev; irRemoval.enabled; irRemoval.sensitivity; brushMigan; aiApplied; autoDustEnabled; autoDustSensitivity; imageCrop; rot90; flipH; flipV; angle; hiTier; uploadWorking(); }
  $: if (!gpuEligible) uploadKey = "";

  // Inversion params now drive GPU uniforms (no backend pixel fetch) when eligible.
  $: invKey = `${params.mode}|${params.stock}|${params.exposure}|${params.temp}|${params.tint}|${params.black}|${params.gamma}|${params.positive}|${JSON.stringify(params.base_override)}`;
  $: if (gpuEligible) { invKey; refreshInversion().then(applyGeometryAndDraw).catch((e) => {
    if (!(typeof e === "string" && e === "not developed")) console.error("refreshInversion failed", e);
  }); }

  // Geometry also drives GPU uniforms (no fetch) when eligible.
  $: geomKey = `${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}`;
  // Raw-mode GPU geometry only: in bake mode geometry is baked into the texture and
  // the upload trigger handles re-draws, so this would otherwise double-draw.
  $: if (gpuEligible && !bakeMode) { geomKey; applyGeometryAndDraw(); }

  // CPU fallback path: re-fetch the SOURCE from the backend only when NOT eligible
  // (dust/IR active, raw view, or no WebGL2). Reuses the existing render()/schedule.
  $: cpuKey = gpuEligible ? '' :
    `${id}|${developRev}|${raw}|${eff}|${vpW}|${vpH}|${params.mode}|${params.stock}|${params.exposure}|${params.temp}|${params.tint}|${imageCrop ? imageCrop.join(',') : 'full'}|${rot90}|${flipH}|${flipV}|${angle}|${dustRev}|${irRemoval.enabled}|${irRemoval.sensitivity}|${JSON.stringify(params.base_override)}`;
  $: cpuKey, imgW, imgH, scheduleIfReady();

  // Finishing-only change → GPU redraw, no backend fetch. Tone curve + color
  // grading are all finishing-layer controls, so they live here too.
  $: finishKey = [
    params.contrast, params.highlights, params.shadows, params.whites, params.blacks,
    params.texture, params.vibrance, params.saturation,
    params.tc_highlights, params.tc_lights, params.tc_darks, params.tc_shadows,
    JSON.stringify(params.tc_curve), JSON.stringify(params.tc_red),
    JSON.stringify(params.tc_green), JSON.stringify(params.tc_blue),
    params.cg_sh_hue, params.cg_sh_sat, params.cg_sh_lum,
    params.cg_mid_hue, params.cg_mid_sat, params.cg_mid_lum,
    params.cg_hi_hue, params.cg_hi_sat, params.cg_hi_lum,
    params.cg_glob_hue, params.cg_glob_sat, params.cg_glob_lum,
    params.cg_blending, params.cg_balance,
    params.cm_red_hue, params.cm_red_sat, params.cm_red_lum,
    params.cm_orange_hue, params.cm_orange_sat, params.cm_orange_lum,
    params.cm_yellow_hue, params.cm_yellow_sat, params.cm_yellow_lum,
    params.cm_green_hue, params.cm_green_sat, params.cm_green_lum,
    params.cm_aqua_hue, params.cm_aqua_sat, params.cm_aqua_lum,
    params.cm_blue_hue, params.cm_blue_sat, params.cm_blue_lum,
    params.cm_purple_hue, params.cm_purple_sat, params.cm_purple_lum,
    params.cm_magenta_hue, params.cm_magenta_sat, params.cm_magenta_lum,
    JSON.stringify(params.pc_samples),
    clipHigh, clipLow, clipStrict,
  ].join("|");
  // On the GPU develop path, suppress finishing redraws until the new image's frame
  // is ready (else this fires synchronously on switch with the OLD texture bound —
  // the worst flash). Raw/CPU-with-GL keeps its prior behavior (render() drives it).
  $: if (useGL) { finishKey; if (renderer && (!gpuEligible || frameReady)) drawGL(); }

  function imgPoint(e: { clientX: number; clientY: number }): [number, number] {
    const rect = el.getBoundingClientRect();
    return [(e.clientX - rect.left - left) / eff, (e.clientY - rect.top - top) / eff];
  }

  // ---- RGB densitometer ----------------------------------------------------
  // Read the displayed pixel under the cursor as sRGB 8-bit (0..255) — what the
  // eye sees and what exports. GPU path only: readCanvasPixel needs the WebGL2
  // backbuffer (preserveDrawingBuffer). On the CPU <img> fallback it returns null
  // and the badge stays hidden. Suppressed in eraser/point-pick modes (own overlays).
  let hoverRGB: [number, number, number] | null = null;
  $: readoutActive = interactive && useGL && !!id && !eraser && !pointPick;

  // This image's cached fit-view preview, shown as an overlay during the switch gap
  // (until frameReady) so the NEW image appears instantly instead of holding the old.
  // Cached previews (prefetched render_view / viewed-canvas snapshots) are always
  // oriented to the committed geometry, so they're safe to show as-is.
  $: cachedPreview = useGL && id ? ($previewById[id] ?? "") : "";
  // The raw catalog thumbnail is at the image's NATIVE orientation and is the FULL
  // frame, so it only matches the developed view when there's no committed crop /
  // rotation / flip / straighten. Otherwise showing it would flash a wrong-oriented
  // or wrongly-framed image, so fall back to holding the previous frame instead.
  $: thumbMatchesView = !imageCrop && rot90 === 0 && !flipH && !flipV && (angle ?? 0) === 0;
  $: switchPreview = !frameReady ? (cachedPreview || (thumbMatchesView ? fallbackThumb : "")) : "";
  function sampleHover(e: { clientX: number; clientY: number }) {
    if (!readoutActive || !canvas) { hoverRGB = null; return; }
    const rect = canvas.getBoundingClientRect();
    hoverRGB = readCanvasPixel(canvas, e.clientX - rect.left, e.clientY - rect.top);
  }

  // Notify the parent whenever the zoom state flips so it can swap the toolbar button.
  // Push the zoom state to the parent on every flip — and once the viewport is
  // ready, even if it matches the initial `false`. A fresh Viewport instance
  // (e.g. remounted after a trip through the crop tool, which swaps in CropView)
  // starts un-zoomed; without this first emit the parent would keep a stale
  // `viewZoomed = true` from the previous instance and the button would stick.
  let prevZoomed: boolean | null = null;
  $: if (ready && zoomed !== prevZoomed) { prevZoomed = zoomed; dispatch("zoomchange", zoomed); }

  /** Animate back to fit-to-view. Called by the parent via bind:this. */
  export function resetZoom() {
    startAnim();
    scale = fit; cx = imgW / 2; cy = imgH / 2;
  }

  /** Animate to 1:1 (100%), centered. Crosses the hi-res zoom threshold so
   *  resolution-dependent effects (Texture) preview truthfully. Parent via bind:this. */
  export function zoomTo100() {
    startAnim();
    scale = 1.0; cx = imgW / 2; cy = imgH / 2;
  }

  function startAnim() {
    animating = true;
    if (animTimer) clearTimeout(animTimer);
    animTimer = setTimeout(() => (animating = false), 200);
  }
  function stopAnim() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    animating = false;
  }

  function onWheel(e: WheelEvent) {
    if (!interactive) return;
    // Eraser mode: the wheel resizes the brush; a trackpad PINCH (ctrlKey) still zooms.
    if (eraser && !e.ctrlKey) {
      e.preventDefault();
      const next = Math.min(0.2, Math.max(0.005, brush * Math.exp(-e.deltaY * 0.0015)));
      dispatch("brush", next);
      return;
    }
    stopAnim();
    e.preventDefault();
    const [ix, iy] = imgPoint(e);
    const ns = Math.min(8, Math.max(fit, eff * Math.exp(-e.deltaY * 0.0015)));
    cx = ix + (cx - ix) * (eff / ns);
    cy = iy + (cy - iy) * (eff / ns);
    scale = ns;
  }

  let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false, panning = false;

  // Eraser: live cursor position (element coords) + the in-progress stroke (normalized).
  let curX = -100, curY = -100, hovering = false;
  let painting = false;
  let pending: { x: number; y: number }[] = [];
  // Marquee zoom: drag-in-progress flag, start corner in element coords (for drawing)
  // and image coords (for the zoom math), and the live corner in element coords.
  let mqActive = false;
  let mqSX = 0, mqSY = 0;
  let mqStartImg: [number, number] = [0, 0];
  let mqCX = 0, mqCY = 0;
  $: cursorR = screenRadius(brush, imgW, eff);

  // SVG path for a stroke's polyline in display px (normalized → dispW/dispH).
  // A single dab becomes "M p L p" so a round cap renders it as a dot.
  function strokeD(pts: { x: number; y: number }[], w: number, h: number): string {
    if (!pts.length) return "";
    const p = (q: { x: number; y: number }) => `${(q.x * w).toFixed(1)} ${(q.y * h).toFixed(1)}`;
    if (pts.length === 1) return `M ${p(pts[0])} L ${p(pts[0])}`;
    return "M " + pts.map(p).join(" L ");
  }
  // Show committed + in-progress strokes as a mask while AI-fill is pending.
  $: showMask = eraser && brushMigan && !aiApplied;

  function normPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const [ix, iy] = imgPoint(e);
    return { x: ix / imgW, y: iy / imgH };
  }
  function onEraserMove(e: PointerEvent) {
    const rect = el.getBoundingClientRect();
    curX = e.clientX - rect.left;
    curY = e.clientY - rect.top;
    if (painting) pending = [...pending, normPoint(e)];
  }
  function onEnter() { if (eraser) hovering = true; }
  function onLeave() { hovering = false; painting = false; pending = []; mqActive = false; hoverRGB = null; }

  function onDown(e: PointerEvent) {
    if (!interactive) return;
    if (e.button !== 0) return; // ignore right/middle click — let the context menu open
    if (pointPick) {
      // Mark as "moved" so the upcoming pointerup is not treated as a tap-to-zoom.
      // The pick dispatch flips pointPick off synchronously (the parent clears its
      // picking flag), so onUp can't rely on `pointPick` still being true.
      moved = true;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        // Working-image UV of the click: the canvas is the crop window of the
        // oriented image, so map the normalized click back through crop+orient.
        const [u, v] = displayToSourceUV(px / rect.width, py / rect.height, imageCrop, rot90, flipH, flipV);
        const rgb = readCanvasPixel(canvas, px, py);
        if (rgb) dispatch("pointpick", { r: rgb[0], g: rgb[1], b: rgb[2], u, v });
      }
      return;
    }
    if (eraser && marquee) {
      const rect = el.getBoundingClientRect();
      mqActive = true;
      mqSX = mqCX = e.clientX - rect.left;
      mqSY = mqCY = e.clientY - rect.top;
      mqStartImg = imgPoint(e);
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (eraser) {
      painting = true;
      pending = [normPoint(e)];
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    stopAnim();
    downX = lastX = e.clientX; downY = lastY = e.clientY; moved = false;
    panning = zoomed;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!interactive) return;
    sampleHover(e);
    if (eraser && marquee) {
      if (mqActive) {
        const rect = el.getBoundingClientRect();
        mqCX = e.clientX - rect.left;
        mqCY = e.clientY - rect.top;
      }
      return;
    }
    if (eraser) { onEraserMove(e); return; }
    if (!(e.buttons & 1)) return;
    if (Math.abs(e.clientX - downX) > 3 || Math.abs(e.clientY - downY) > 3) moved = true;
    if (panning && moved) {
      cx -= (e.clientX - lastX) / eff;
      cy -= (e.clientY - lastY) / eff;
      clampCenter();
    }
    lastX = e.clientX; lastY = e.clientY;
  }
  function onUp(e: PointerEvent) {
    if (e.button !== 0) return; // right/middle click never triggers tap-to-zoom
    if (pointPick) return;
    if (eraser && marquee) {
      if (mqActive) {
        const dist = Math.hypot(mqCX - mqSX, mqCY - mqSY);
        if (dist >= 8) {
          const [bx, by] = imgPoint(e);
          const z = marqueeZoom(mqStartImg[0], mqStartImg[1], bx, by, avW, avH, fit, 8);
          startAnim();
          scale = z.scale; cx = z.cx; cy = z.cy;
          clampCenter(z.scale);
          dispatch("marqueedone");
        }
        mqActive = false;
      }
      return;
    }
    if (eraser) {
      if (painting && pending.length > 0) dispatch("stroke", { points: pending, r: brush });
      painting = false; pending = [];
      return;
    }
    if (interactive && !moved) {
      const [ix, iy] = imgPoint(e);
      startAnim();
      if (zoomed) { scale = fit; cx = imgW / 2; cy = imgH / 2; }
      else { scale = 1.0; cx = ix; cy = iy; }
    }
    panning = false; moved = false;
  }
  function onCancel() { painting = false; pending = []; panning = false; moved = false; mqActive = false; }
</script>

<div
  class="vp" class:interactive class:zoomed class:erasing={eraser} class:picking={pointPick} class:marqueearm={eraser && marquee}
  bind:this={el}
  on:wheel={onWheel}
  on:pointerdown={onDown} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onCancel}
  on:pointerenter={onEnter} on:pointerleave={onLeave}
>
  {#if useGL}
    <canvas
      bind:this={canvas} class:anim={animating}
      style="position:absolute; width:{dispW}px; height:{dispH}px; left:{left}px; top:{top}px;"
    ></canvas>
    {#if switchPreview}
      <img
        class="preview-cache" src={switchPreview} alt="" draggable="false" aria-hidden="true"
        style="position:absolute; width:{dispW}px; height:{dispH}px; left:{left}px; top:{top}px;"
      />
    {/if}
    {#if !id}<div class="hint">…</div>{/if}
  {:else if src}
    <img
      {src} alt="preview" draggable="false" class:anim={animating}
      style="position:absolute; width:{dispW}px; height:{dispH}px; left:{left}px; top:{top}px;"
    />
  {:else}<div class="hint">…</div>{/if}
  {#if params.hdr && hdrSrc}
    <img
      class="hdr-overlay" src={hdrSrc} alt="" draggable="false" aria-hidden="true"
      style="position:absolute; width:{dispW}px; height:{dispH}px; left:{left}px; top:{top}px; opacity:{hdrShown ? 1 : 0};"
    />
  {/if}
  {#if showMask}
    <svg class="maskov" aria-hidden="true"
         style="left:{left}px; top:{top}px; width:{dispW}px; height:{dispH}px;"
         viewBox="0 0 {Math.max(dispW, 1)} {Math.max(dispH, 1)}">
      {#each dust as s}
        <path d={strokeD(s.points, dispW, dispH)} stroke-width={s.r * 2 * dispW}
              fill="none" stroke-linecap="round" stroke-linejoin="round" />
      {/each}
      {#if painting && pending.length}
        <path d={strokeD(pending, dispW, dispH)} stroke-width={brush * 2 * dispW}
              fill="none" stroke-linecap="round" stroke-linejoin="round" />
      {/if}
    </svg>
  {/if}
  {#if eraser && hovering && !marquee}
    <div class="brush" style="left:{curX}px; top:{curY}px; width:{cursorR * 2}px; height:{cursorR * 2}px;"></div>
  {/if}
  {#if eraser && marquee && mqActive}
    <div class="marquee" style="left:{Math.min(mqSX, mqCX)}px; top:{Math.min(mqSY, mqCY)}px; width:{Math.abs(mqCX - mqSX)}px; height:{Math.abs(mqCY - mqSY)}px;"></div>
  {/if}
  {#if id && interactive}<div class="zoom">{label}</div>{/if}
  {#if readoutActive && hoverRGB}
    <div class="readout" title={$t("viewport.rgbReadout")}>
      <span class="sw" style="background:rgb({hoverRGB[0]},{hoverRGB[1]},{hoverRGB[2]})"></span>
      <span>R {hoverRGB[0]}</span><span>G {hoverRGB[1]}</span><span>B {hoverRGB[2]}</span>
    </div>
  {/if}
</div>

<style>
  .vp { position: relative; width: 100%; height: 100%; overflow: hidden; user-select: none;
    border-radius: 10px; }
  .vp.interactive { cursor: zoom-in; }
  .vp.zoomed { cursor: grab; }
  .vp.zoomed:active { cursor: grabbing; }
  /* contain (not the default fill) so that during an image switch — when the canvas
     box is already sized to the NEW image but its buffer still holds the previous
     frame at a different aspect (e.g. a 90° rotation flips portrait↔landscape) — the
     stale frame is letterboxed rather than stretched. Once the correct frame draws,
     buffer and box share the same aspect, so contain fills exactly (a no-op). */
  img, canvas { display: block; object-fit: contain; will-change: left, top, width, height; }
  img.anim, canvas.anim { transition: left 180ms cubic-bezier(0.22, 0.61, 0.36, 1),
    top 180ms cubic-bezier(0.22, 0.61, 0.36, 1),
    width 180ms cubic-bezier(0.22, 0.61, 0.36, 1),
    height 180ms cubic-bezier(0.22, 0.61, 0.36, 1); }
  .preview-cache { object-fit: contain; pointer-events: none; z-index: 1; }
  .hdr-overlay { object-fit: contain; pointer-events: none; z-index: 1;
    /* Lift the HDR headroom clamp so the gain-map JPEG can exceed SDR white. */
    dynamic-range-limit: no-limit; transition: opacity 150ms; }
  .hint { color: var(--text-dim); position: absolute; inset: 0; display: grid; place-items: center; }
  .zoom { position: absolute; bottom: 8px; right: 10px; font-size: 11px; color: var(--text-dim);
    background: rgba(0,0,0,0.45); padding: 2px 8px; border-radius: 6px; z-index: 2; }
  .readout { position: absolute; bottom: 32px; right: 10px; font-size: 11px; color: var(--text);
    background: rgba(0,0,0,0.45); padding: 2px 8px; border-radius: 6px; z-index: 2;
    display: flex; align-items: center; gap: 6px; pointer-events: none;
    font-variant-numeric: tabular-nums; }
  .readout .sw { width: 10px; height: 10px; border-radius: 2px; flex: none;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.35); }
  .vp.erasing { cursor: none; }
  .vp.picking { cursor: crosshair; }
  .maskov { position: absolute; pointer-events: none; z-index: 2; overflow: visible; }
  .maskov path { stroke: rgba(244,70,70,0.55); }
  .brush { position: absolute; border-radius: 50%; pointer-events: none; z-index: 3;
    transform: translate(-50%, -50%); border: 1.5px solid rgba(255,255,255,0.9);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.4); }
  .vp.marqueearm { cursor: crosshair; }
  .marquee { position: absolute; z-index: 5; pointer-events: none;
    border: 1px solid #fff; background: rgba(244,157,78,0.15);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.4); }
</style>
