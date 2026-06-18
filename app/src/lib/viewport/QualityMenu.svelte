<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { scale } from "svelte/transition";
  import { anchorMenu } from "../overlay/anchorMenu";
  import { t } from "$lib/i18n";
  export let x = 0;
  export let y = 0;
  /** When true, offer Flip horizontal/vertical (single selected image). */
  export let showFlip = false;
  /** When true, offer "Open in folder" (reveals the active image's file). */
  export let showReveal = false;
  const dispatch = createEventDispatcher();
</script>

<div class="menu" use:anchorMenu={{ x, y }} on:pointerleave={() => dispatch("close")}
     transition:scale={{ duration: 120, start: 0.94, opacity: 0 }}>
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
  .divider { height: 1px; margin: 5px 6px; background: var(--glass-brd); }
  button { display: block; width: 100%; text-align: left; padding: 7px 8px; border: 0;
    background: transparent; border-radius: 7px; color: var(--text-dim);
    transition: background 0.12s ease, color 0.12s ease; }
  button:hover { color: var(--text); background: var(--glass-hi); }
</style>
