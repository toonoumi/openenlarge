<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { t } from "$lib/i18n";
  import { ALL_GROUPS, type SettingGroup, type GroupSelection } from "$lib/roll/apply";

  /** Dialog heading + supporting copy — supplied by each entry point so the same
   *  component serves both clipboard-paste and apply-to-whole-roll. */
  export let title = "";
  export let sub = "";
  /** Optional confirm-button label (defaults to the generic "Apply"). */
  export let confirmLabel = "";
  /** Initial checkbox state per group. */
  export let defaults: GroupSelection = {
    toneColor: true, crop: false, base: false, exposure: false, whitePoint: false,
  };

  const dispatch = createEventDispatcher();
  // Local working copy so toggling never mutates the parent's object.
  let sel: GroupSelection = { ...defaults };

  const LABEL: Record<SettingGroup, string> = {
    toneColor: "applyGroups.toneColor",
    crop: "applyGroups.crop",
    base: "applyGroups.base",
    exposure: "applyGroups.exposure",
    whitePoint: "applyGroups.whitePoint",
  };

  $: anySelected = ALL_GROUPS.some((g) => sel[g]);
</script>

<div class="scrim" on:click|self={() => dispatch("cancel")} transition:fade={{ duration: 150 }}>
  <div class="card" transition:scale={{ duration: 160, start: 0.96, opacity: 0 }}>
    <div class="title">{title}</div>
    <div class="sub">{sub}</div>
    <div class="groups">
      {#each ALL_GROUPS as g}
        <label class="grp">
          <input type="checkbox" bind:checked={sel[g]} />
          <span>{$t(LABEL[g])}</span>
        </label>
      {/each}
    </div>
    <div class="row">
      <button class="ghost" on:click={() => dispatch("cancel")}>{$t('confirmApply.cancel')}</button>
      <button class="go" disabled={!anySelected}
              on:click={() => dispatch("confirm", { groups: { ...sel } })}>
        {confirmLabel || $t('confirmApply.confirm')}
      </button>
    </div>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 60; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px; min-width: 320px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .title { font-weight: 600; margin-bottom: 6px; }
  .sub { color: var(--text-dim); margin-bottom: 16px; font-size: 12px; }
  .groups { display: flex; flex-direction: column; gap: 2px; margin-bottom: 18px; }
  .grp { display: flex; align-items: center; gap: 9px; padding: 6px 6px; border-radius: 8px;
    cursor: pointer; font-size: 13px; }
  .grp:hover { background: var(--glass-hi); }
  .grp input { accent-color: var(--accent, #f49d4e); width: 15px; height: 15px; cursor: pointer; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  button { padding: 8px 14px; border-radius: 9px; border: 1px solid var(--glass-brd); background: transparent; }
  .go { background: var(--accent-grad); color: white; border: 0; font-weight: 600; }
  .go:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
