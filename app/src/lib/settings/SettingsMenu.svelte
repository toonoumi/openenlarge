<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade } from "svelte/transition";
  import { locale, LOCALES, t } from "../i18n";
  import { openaiApiKey, telemetryEnabled } from "../store";
  import { setTelemetryChoice } from "../telemetry";
  import { runManualCheck } from "../update/updater";
  import { openUrl } from "@tauri-apps/plugin-opener";
  const dispatch = createEventDispatcher();
  const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";
  const PRIVACY_URL = "https://github.com/mohaelder/openenlarge#telemetry";
  // Aptabase has no public dashboard link; access is by manual invite, so point
  // interested users at a pre-filled access request.
  const DASHBOARD_REQUEST_URL =
    "mailto:calen0909@hotmail.com?subject=OpenEnlarge%20analytics%20dashboard%20access" +
    "&body=Hi%2C%20I%27d%20like%20access%20to%20the%20OpenEnlarge%20analytics%20dashboard.%0A%0A" +
    "Name%20%2F%20GitHub%3A%0AReason%3A%0AEmail%20to%20invite%20%28Aptabase%20account%29%3A%0A%0AThanks%21";
</script>

<div class="backdrop" on:click={() => dispatch("close")} transition:fade={{ duration: 120 }}></div>
<div class="menu" role="dialog" aria-label={$t("settings.dialogAriaLabel")} transition:fade={{ duration: 120 }}>
  <div class="grp">
    <div class="head">{$t("settings.language.heading")}</div>
    <div class="seg">
      {#each LOCALES as l}
        <button class:on={$locale === l.id} on:click={() => locale.set(l.id)}>{l.label}</button>
      {/each}
    </div>
  </div>
  <div class="grp">
    <button type="button" class="head head-link"
            on:click={() => openUrl(OPENAI_KEYS_URL).catch(() => {})}>
      {$t("settings.ai.heading")} ↗
    </button>
    <input
      class="key" type="password" autocomplete="off" spellcheck="false"
      placeholder={$t("settings.ai.keyPlaceholder")}
      value={$openaiApiKey}
      on:input={(e) => openaiApiKey.set((e.target as HTMLInputElement).value)} />
    <div class="hint">{$t("settings.ai.hint")}</div>
  </div>
  <div class="grp">
    <button type="button" class="head head-link"
            on:click={() => openUrl(PRIVACY_URL).catch(() => {})}>
      {$t("settings.telemetry.heading")} ↗
    </button>
    <div class="seg">
      <button class:on={!$telemetryEnabled} on:click={() => setTelemetryChoice(false)}>{$t("settings.telemetry.off")}</button>
      <button class:on={$telemetryEnabled} on:click={() => setTelemetryChoice(true)}>{$t("settings.telemetry.on")}</button>
    </div>
    <div class="hint">{$t("settings.telemetry.hint")}</div>
    <button type="button" class="req-link"
            on:click={() => openUrl(DASHBOARD_REQUEST_URL).catch(() => {})}>
      {$t("settings.telemetry.requestAccess")} ↗
    </button>
  </div>
  <button class="shortcuts" on:click={() => dispatch("shortcuts")}>
    <span class="kbd-icon" aria-hidden="true">⌨</span>
    {$t("settings.shortcuts.button")}
  </button>
  <button class="shortcuts" on:click={() => { dispatch("close"); runManualCheck(); }}>
    <span class="kbd-icon" aria-hidden="true">↑</span>
    {$t("settings.checkUpdates")}
  </button>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.5);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .menu { position: fixed; top: 52px; right: 16px; z-index: 61; min-width: 224px;
    background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 12px;
    padding: 12px; backdrop-filter: blur(20px) saturate(140%); -webkit-backdrop-filter: blur(20px) saturate(140%);
    box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  .head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin-bottom: 8px; }
  /* Clickable heading → opens the OpenAI API-keys page. Dashed underline cues the link. */
  .head-link { display: inline-flex; align-items: center; gap: 4px; padding: 0;
    background: none; border: none; cursor: pointer; font: inherit;
    text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px;
    text-decoration: underline; text-decoration-style: dashed; text-underline-offset: 3px; }
  .head-link:hover, .head-link:focus-visible { color: var(--accent); outline: none; }
  .seg { display: flex; gap: 6px; }
  .seg button { flex: 1; padding: 7px; border-radius: 8px; font-size: 12px; cursor: pointer;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text-dim);
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
  .seg button:not(.on):hover { background: var(--glass-hi); color: var(--text); }
  .seg button.on { color: #fff; background: rgba(244,157,78,0.18); border-color: rgba(244,157,78,0.5); }
  .seg button.on:hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
  .shortcuts { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 12px;
    padding: 9px 10px; border-radius: 8px; font-size: 12px; text-align: left;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text); }
  .shortcuts:hover { background: var(--glass-hi); }
  .kbd-icon { font-size: 14px; color: var(--text-dim); }
  .grp + .grp { margin-top: 12px; }
  .key { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
    font-size: 12px; border: 1px solid var(--glass-brd); background: transparent;
    color: var(--text); }
  .key::placeholder { color: var(--text-dim); }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 6px; line-height: 1.4; }
  .req-link { display: inline-block; margin-top: 8px; padding: 0; background: none; border: 0;
    cursor: pointer; font: inherit; font-size: 11px; color: var(--text-dim);
    text-decoration: underline; text-decoration-style: dashed; text-underline-offset: 3px; }
  .req-link:hover, .req-link:focus-visible { color: var(--accent); outline: none; }
</style>
