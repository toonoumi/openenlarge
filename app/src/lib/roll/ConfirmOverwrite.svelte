<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { t } from "$lib/i18n";
  export let count: number;
  const dispatch = createEventDispatcher();
  let dontAsk = false;
</script>

<div class="scrim" on:click|self={() => dispatch("cancel")} transition:fade={{ duration: 150 }}>
  <div class="card" transition:scale={{ duration: 160, start: 0.96, opacity: 0 }}>
    <div class="title">{$t('confirmOverwrite.title', { count, plural: count === 1 ? '' : 's' })}</div>
    <div class="sub">{$t('confirmOverwrite.sub')}</div>
    <label class="dont-ask">
      <input type="checkbox" bind:checked={dontAsk} />
      {$t('confirmOverwrite.dontAsk')}
    </label>
    <div class="row">
      <button class="ghost" on:click={() => dispatch("cancel")}>{$t('confirmOverwrite.cancel')}</button>
      <button class="go" on:click={() => dispatch("confirm", { dontAsk })}>{$t('confirmOverwrite.overwrite')}</button>
    </div>
  </div>
</div>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape') dispatch('cancel'); }} />

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 60; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px; min-width: 320px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .title { font-weight: 600; margin-bottom: 6px; }
  .sub { color: var(--text-dim); margin-bottom: 14px; font-size: 12px; }
  .dont-ask { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim);
    margin-bottom: 16px; cursor: pointer; user-select: none; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  button { padding: 8px 14px; border-radius: 9px; border: 1px solid var(--glass-brd); background: transparent; }
  .go { background: var(--accent-grad); color: white; border: 0; font-weight: 600; }
</style>
