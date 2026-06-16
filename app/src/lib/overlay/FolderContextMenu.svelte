<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { scale } from "svelte/transition";
  import { t } from "$lib/i18n";
  import { anchorMenu } from "./anchorMenu";
  export let x = 0;
  export let y = 0;
  const dispatch = createEventDispatcher<{ remove: void; close: void }>();
</script>

<div class="backdrop"
     on:pointerdown={() => dispatch("close")}
     on:contextmenu|preventDefault={() => dispatch("close")}></div>
<div class="menu" use:anchorMenu={{ x, y }} role="menu"
     transition:scale={{ duration: 120, start: 0.94, opacity: 0 }}>
  <button class="del" on:click={() => dispatch("remove")}>{$t('folderMenu.remove')}</button>
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
</style>
