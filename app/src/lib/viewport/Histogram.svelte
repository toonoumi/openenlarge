<script lang="ts">
  import { previewSrc, clipWarn } from "../store";
  import { t } from "$lib/i18n";
  import { binPixels, channelPath } from "./histogram";

  const W = 256, H = 76;
  let rPath = "", gPath = "", bPath = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cv = typeof document !== "undefined" ? document.createElement("canvas") : null;

  function compute(src: string) {
    if (!src || !cv) { rPath = gPath = bPath = ""; return; }
    const img = new Image();
    img.onload = () => {
      const w = 256, h = Math.max(1, Math.round((img.height / img.width) * 256));
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const bins = binPixels(data);
      rPath = channelPath(bins.r, W, H);
      gPath = channelPath(bins.g, W, H);
      bPath = channelPath(bins.b, W, H);
    };
    img.src = src;
  }
  $: { const s = $previewSrc; if (timer) clearTimeout(timer); timer = setTimeout(() => compute(s), 120); }

  const toggleHigh = () => clipWarn.update((c) => ({ ...c, high: !c.high }));
  const toggleLow = () => clipWarn.update((c) => ({ ...c, low: !c.low }));
  const toggleStrict = () => clipWarn.update((c) => ({ ...c, strict: !c.strict }));
</script>

<div class="hist">
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none">
    <polyline points={rPath} class="r" />
    <polyline points={gPath} class="g" />
    <polyline points={bPath} class="b" />
  </svg>
  <button
    class="clip tl" class:on={$clipWarn.low} class:strict={$clipWarn.strict}
    title={$t("histogram.clipLow")} aria-label={$t("histogram.clipLow")}
    on:click={toggleLow} on:contextmenu|preventDefault={toggleStrict}
  ></button>
  <button
    class="clip tr" class:on={$clipWarn.high} class:strict={$clipWarn.strict}
    title={$t("histogram.clipHigh")} aria-label={$t("histogram.clipHigh")}
    on:click={toggleHigh} on:contextmenu|preventDefault={toggleStrict}
  ></button>
</div>

<style>
  .hist { position: relative; height: 76px; border-radius: 8px; background: rgba(0,0,0,0.35);
    padding: 4px; margin-bottom: 10px; }
  .clip { position: absolute; top: 4px; width: 0; height: 0; padding: 0; border: none;
    background: none; cursor: pointer; opacity: 0.5; z-index: 1; }
  .clip:hover { opacity: 0.85; }
  .clip.on { opacity: 1; }
  /* Triangles pointing into the histogram from each top corner. */
  .clip.tl { left: 4px; border-top: 9px solid #5a9cff; border-right: 9px solid transparent; }
  .clip.tr { right: 4px; border-top: 9px solid #ff5a5a; border-left: 9px solid transparent; }
  /* Strict (253) mode: outline the active triangle's corner. */
  .clip.on.strict { filter: drop-shadow(0 0 0 #fff) drop-shadow(0 0 2px #fff); }
  svg { width: 100%; height: 100%; display: block; }
  polyline { fill: none; stroke-width: 1; mix-blend-mode: screen; }
  .r { stroke: #ff5a5a; } .g { stroke: #5aff7a; } .b { stroke: #5a9cff; }
</style>
