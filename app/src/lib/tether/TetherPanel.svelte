<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { t } from "$lib/i18n";
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
  .toggle { width: 100%; padding: 9px; border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.12);
    background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.045));
    color: var(--text); font-weight: 600; letter-spacing: 0.2px; cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.22);
    transition: transform 0.16s cubic-bezier(0.2,0.7,0.3,1), box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease; }
  .toggle:hover:not(:disabled) { transform: scale(1.03);
    border-color: rgba(255,255,255,0.2);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 6px 16px rgba(0,0,0,0.3); }
  .toggle:active:not(:disabled) { transform: scale(0.985);
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.28); }
  .toggle:disabled { opacity: 0.6; cursor: default; }
  .toggle.on { color: #fff; border-color: rgba(244,157,78,0.55);
    background: linear-gradient(180deg, rgba(244,157,78,0.30), rgba(223,113,54,0.20));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 3px 12px rgba(223,113,54,0.28); }
  .toggle.on:hover:not(:disabled) {
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 7px 18px rgba(223,113,54,0.38); }
  @media (prefers-reduced-motion: reduce) {
    .toggle { transition: box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease; }
    .toggle:hover:not(:disabled), .toggle:active:not(:disabled) { transform: none; }
  }
  .status { font-size: 12px; opacity: 0.8; }
  .adv { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.9; }
  .hint { font-size: 11px; opacity: 0.6; }
  .last { font-size: 12px; opacity: 0.85; }
  .last.err { color: #ff8a8a; }
  .err-msg { font-size: 12px; color: #ff8a8a; }
</style>
