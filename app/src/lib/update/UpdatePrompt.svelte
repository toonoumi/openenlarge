<script lang="ts">
  import { t } from "$lib/i18n";
  import { fade } from "svelte/transition";
  import { updateState, startUpdate, restart, skipVersion, dismiss } from "./updater";
</script>

{#if $updateState.kind !== "idle"}
  <div class="backdrop" on:click={dismiss} transition:fade={{ duration: 120 }}></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label={$t("update.title")} transition:fade={{ duration: 120 }}>
    <h2>{$t("update.title")}</h2>

    {#if $updateState.kind === "available"}
      <p class="ver">{$t("update.available", { version: $updateState.version })}</p>
      {#if $updateState.notes}
        <div class="notes-label">{$t("update.notesLabel")}</div>
        <pre class="notes">{$updateState.notes}</pre>
      {/if}
      <div class="row">
        <button class="ghost" on:click={() => skipVersion($updateState.kind === "available" ? $updateState.version : "")}>{$t("update.skip")}</button>
        <button class="ghost" on:click={dismiss}>{$t("update.later")}</button>
        <button class="primary" on:click={startUpdate}>{$t("update.update")}</button>
      </div>

    {:else if $updateState.kind === "downloading"}
      <p>{$t("update.downloading")}</p>
      <div class="bar"><div class="fill" style="width:{Math.round($updateState.pct * 100)}%"></div></div>

    {:else if $updateState.kind === "restartReady"}
      <div class="row">
        <button class="ghost" on:click={dismiss}>{$t("update.later")}</button>
        <button class="primary" on:click={restart}>{$t("update.restartNow")}</button>
      </div>

    {:else if $updateState.kind === "upToDate"}
      <p>{$t("update.upToDate")}</p>
      <div class="row"><button class="primary" on:click={dismiss}>{$t("update.dismiss")}</button></div>

    {:else if $updateState.kind === "error"}
      <p class="err">{$t("update.error")}</p>
      <div class="row"><button class="primary" on:click={dismiss}>{$t("update.dismiss")}</button></div>
    {/if}
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,0.45); }
  .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
    width: min(440px, 90vw); background: var(--glass-bg); border: 1px solid var(--glass-brd);
    border-radius: 14px; padding: 20px; backdrop-filter: blur(20px);
    box-shadow: 0 16px 50px rgba(0,0,0,0.55); color: var(--text); }
  h2 { margin: 0 0 10px; font-size: 16px; }
  .ver { color: var(--text-dim); font-size: 13px; margin: 0 0 12px; }
  .notes-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 8px 0 4px; }
  .notes { max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 12px;
    background: var(--bg-1); border: 1px solid var(--glass-brd); border-radius: 8px;
    padding: 10px; margin: 0 0 12px; }
  .err { color: var(--accent); }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .row button { padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
    border: 1px solid var(--glass-brd); }
  .ghost { background: transparent; color: var(--text-dim); }
  .ghost:hover { color: var(--text); background: var(--glass-hi); }
  .primary { background: rgba(244,157,78,0.18); border-color: rgba(244,157,78,0.5); color: #fff; }
  .bar { height: 6px; border-radius: 3px; background: var(--glass-brd); overflow: hidden; margin-top: 10px; }
  .fill { height: 100%; background: var(--accent); transition: width 0.15s; }
</style>
