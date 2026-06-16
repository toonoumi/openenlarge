<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { scale } from "svelte/transition";
  import { get } from "svelte/store";
  import { anchorMenu } from "../overlay/anchorMenu";
  import { quality, activeId, images, developRev } from "../store";
  import { api, type Quality } from "../api";
  import { t } from "$lib/i18n";
  export let x = 0;
  export let y = 0;
  /** When true, offer Flip horizontal/vertical (single selected image). */
  export let showFlip = false;
  /** When true, offer "Open in folder" (reveals the active image's file). */
  export let showReveal = false;
  const dispatch = createEventDispatcher();

  async function pick(q: Quality) {
    if (q !== $quality) {
      quality.set(q);
      await api.setQuality(q);
      dispatch("close");
      // Only the image on screen needs the new quality now; others upgrade lazily
      // when navigated to (see Develop.svelte). ensure_developed is a no-op when the
      // resident buffer already satisfies the new quality (e.g. switching to Performance).
      const id = get(activeId);
      if (id) {
        try {
          const updated = await api.ensureDeveloped(id);
          images.update((list) => list.map((i) => (i.id === id ? updated : i)));
          developRev.update((n) => n + 1);
        } catch (e) {
          console.error("ensureDeveloped failed", id, e);
        }
      }
    } else {
      dispatch("close");
    }
  }
</script>

<div class="menu" use:anchorMenu={{ x, y }} on:pointerleave={() => dispatch("close")}
     transition:scale={{ duration: 120, start: 0.94, opacity: 0 }}>
  <div class="head">{$t('quality.menuHeading')}</div>
  <button class:on={$quality === "performance"} on:click={() => pick("performance")}>{$t('quality.performance')}</button>
  <button class:on={$quality === "quality"} on:click={() => pick("quality")}>{$t('quality.quality')}</button>
  <div class="divider"></div>
  {#if showFlip}
    <button on:click={() => dispatch("flipH")}>{$t('contextMenu.flipH')}</button>
    <button on:click={() => dispatch("flipV")}>{$t('contextMenu.flipV')}</button>
    <div class="divider"></div>
  {/if}
  {#if showReveal}
    <button on:click={() => dispatch("reveal")}>{$t('contextMenu.reveal')}</button>
    <div class="divider"></div>
  {/if}
  <button on:click={() => dispatch("delete")}>{$t('quality.deleteImage')}</button>
</div>

<style>
  .menu { position: fixed; z-index: 70; background: var(--glass-bg); border: 1px solid var(--glass-brd);
    border-radius: 10px; padding: 6px; min-width: 180px; backdrop-filter: blur(20px);
    box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  .head { font-size: 11px; color: var(--text-dim); padding: 4px 8px; }
  .divider { height: 1px; margin: 5px 6px; background: var(--glass-brd); }
  button { display: block; width: 100%; text-align: left; padding: 7px 8px; border: 0;
    background: transparent; border-radius: 7px; color: var(--text-dim);
    transition: background 0.12s ease, color 0.12s ease; }
  button:not(.on):hover { color: var(--text); background: var(--glass-hi); }
  button.on { color: var(--text); background: rgba(244,157,78,0.16); }
  button.on:hover { background: rgba(244,157,78,0.22); }
</style>
