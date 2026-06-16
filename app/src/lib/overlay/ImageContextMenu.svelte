<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { scale } from "svelte/transition";
  import { t } from "$lib/i18n";
  import { anchorMenu } from "./anchorMenu";
  export let x = 0;
  export let y = 0;
  export let count = 1;
  /** When true, offer Flip horizontal/vertical (single-image develop context). */
  export let showFlip = false;
  /** When true, offer "Open in folder" (reveals the right-clicked file). */
  export let showReveal = false;
  const dispatch = createEventDispatcher<{ delete: void; flipH: void; flipV: void; reveal: void; close: void }>();
  $: label = count > 1 ? $t('contextMenu.deleteCount', { count }) : $t('contextMenu.delete');
</script>

<div class="backdrop"
     on:pointerdown={() => dispatch("close")}
     on:contextmenu|preventDefault={() => dispatch("close")}></div>
<div class="menu" use:anchorMenu={{ x, y }} role="menu"
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
  <button class="del" on:click={() => dispatch("delete")}>{label}</button>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 75; }
  .menu { position: fixed; z-index: 76; min-width: 160px; padding: 6px;
    background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 10px;
    backdrop-filter: blur(20px); box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  button { display: block; width: 100%; text-align: left; padding: 7px 8px; border: 0;
    background: transparent; border-radius: 7px; color: var(--text);
    transition: background 0.12s ease, color 0.12s ease; }
  button:hover { background: var(--glass-hi); }
  .divider { height: 1px; margin: 5px 6px; background: var(--glass-brd); }
</style>
