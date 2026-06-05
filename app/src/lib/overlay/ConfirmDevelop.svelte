<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { t } from "$lib/i18n";
  export let count = 0;
  const dispatch = createEventDispatcher();
  let stock = "none";
</script>

<div class="scrim" on:click|self={() => dispatch("cancel")} transition:fade={{ duration: 150 }}>
  <div class="card" transition:scale={{ duration: 160, start: 0.96, opacity: 0 }}>
    <div class="title">{$t('confirmDevelop.title', { count, plural: count === 1 ? '' : 's' })}</div>
    <div class="sub">{$t('confirmDevelop.sub')}</div>
    <div class="stock">
      <label for="cd-stock">{$t('confirmDevelop.filmStock')} <span class="opt">({$t('confirmDevelop.filmStockOptional')})</span></label>
      <select id="cd-stock" bind:value={stock}>
        <option value="none">{$t('basic.noFilmProfile')}</option>
        <option value="portra400">{$t('basic.stock.portra400')}</option>
        <option value="fujic200">{$t('basic.stock.fujic200')}</option>
        <option value="portra160">{$t('basic.stock.portra160')}</option>
        <option value="portra800">{$t('basic.stock.portra800')}</option>
        <option value="ektar100">{$t('basic.stock.ektar100')}</option>
        <option value="gold200">{$t('basic.stock.gold200')}</option>
        <option value="ultramax400">{$t('basic.stock.ultramax400')}</option>
        <option value="fujipro400h">{$t('basic.stock.fujipro400h')}</option>
        <option value="fujixtra400">{$t('basic.stock.fujixtra400')}</option>
        <option value="vision350d">{$t('basic.stock.vision350d')}</option>
        <option value="vision3200t">{$t('basic.stock.vision3200t')}</option>
        <option value="vision3250d">{$t('basic.stock.vision3250d')}</option>
        <option value="vision3500t">{$t('basic.stock.vision3500t')}</option>
      </select>
    </div>
    <div class="row">
      <button class="ghost" on:click={() => dispatch("cancel")}>{$t('confirmDevelop.cancel')}</button>
      <button class="go" on:click={() => dispatch("confirm", { stock })}>{$t('confirmDevelop.confirm')}</button>
    </div>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 60; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px; min-width: 320px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .title { font-weight: 600; margin-bottom: 6px; }
  .sub { color: var(--text-dim); margin-bottom: 18px; font-size: 12px; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  button { padding: 8px 14px; border-radius: 9px; border: 1px solid var(--glass-brd); background: transparent; }
  .go { background: var(--accent-grad); color: white; border: 0; font-weight: 600; }
  .stock { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .stock label { font-size: 12px; color: var(--text-dim); }
  .stock .opt { color: var(--text-faint); }
  .stock select { width: 100%; padding: 8px 10px; border-radius: 9px; background: var(--bg-1);
    color: var(--text); border: 1px solid var(--glass-brd); font-size: 13px; }
</style>
