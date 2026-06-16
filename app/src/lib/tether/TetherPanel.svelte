<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { t } from "$lib/i18n";
  import Icon from "../icons/Icon.svelte";
  import { selectedFolder } from "../store";
  import { startTether, stopTether } from "./controller";
  import { tetherWatching, tetherDir, tetherAutoAdvance, tetherLast } from "./store";

  let error = "";
  let busy = false;

  async function toggle() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      if ($tetherWatching) {
        await stopTether();
        return;
      }
      const dir = await open({ directory: true, defaultPath: $selectedFolder ?? undefined });
      if (!dir || Array.isArray(dir)) return;
      await startTether(dir);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="tether">
  <button class="toggle" class:on={$tetherWatching} on:click={toggle} disabled={busy}>
    {#if !$tetherWatching}<Icon name="camera" size={15} />{/if}
    {$tetherWatching ? $t("tether.stop") : $t("tether.start")}
  </button>

  {#if $tetherWatching}
    <div class="status">{$t("tether.watching", { dir: $tetherDir ?? "" })}</div>
    <label class="adv">
      <input type="checkbox" bind:checked={$tetherAutoAdvance} />
      {$t("tether.autoAdvance")}
    </label>
    <div class="hint">{$t("tether.hint")}</div>
    {#if $tetherLast}
      <div class="last" class:err={!$tetherLast.ok}>
        {$tetherLast.ok
          ? $t("tether.lastOk", { name: $tetherLast.name })
          : $t("tether.lastErr", { name: $tetherLast.name })}
      </div>
    {/if}
  {/if}
  {#if error}<div class="err-msg">{error}</div>{/if}
</div>

<style>
  .tether { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .toggle { width: 100%; padding: 9px; border-radius: 9px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.06);
    color: var(--text); font-weight: 600; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease; }
  .toggle:hover:not(:disabled) { transform: scale(1.02);
    background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.16); }
  .toggle:active:not(:disabled) { transform: scale(0.99); }
  .toggle:disabled { opacity: 0.55; cursor: default; }
  .toggle.on { color: #f3ece6; border-color: rgba(176,106,66,0.55);
    background: rgba(176,106,66,0.20); }
  .toggle.on:hover:not(:disabled) { background: rgba(176,106,66,0.28); border-color: rgba(176,106,66,0.65); }
  @media (prefers-reduced-motion: reduce) {
    .toggle { transition: background 0.14s ease, border-color 0.14s ease; }
    .toggle:hover:not(:disabled), .toggle:active:not(:disabled) { transform: none; }
  }
  .status { font-size: 12px; opacity: 0.8; }
  .adv { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.9; }
  .hint { font-size: 11px; opacity: 0.6; }
  .last { font-size: 12px; opacity: 0.85; }
  .last.err { color: #ff8a8a; }
  .err-msg { font-size: 12px; color: #ff8a8a; }
</style>
