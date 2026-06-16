<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { t } from "$lib/i18n";
  import { setTelemetryChoice, track } from "$lib/telemetry";

  const PRIVACY_URL = "https://github.com/mohaelder/openenlarge#telemetry";

  function choose(enabled: boolean) {
    setTelemetryChoice(enabled);
    // Count this session: the gate is now open, so app_launched fires for the
    // first opted-in run too (track() is a no-op when they decline).
    track("app_launched");
  }
</script>

<div class="scrim" transition:fade={{ duration: 150 }}>
  <div class="card" role="dialog" aria-label={$t("telemetry.title")}
       transition:scale={{ duration: 160, start: 0.96, opacity: 0 }}>
    <div class="title">{$t("telemetry.title")}</div>
    <div class="sub">{$t("telemetry.body")}</div>
    <button type="button" class="learn"
            on:click={() => openUrl(PRIVACY_URL).catch(() => {})}>
      {$t("telemetry.learnMore")} ↗
    </button>
    <div class="row">
      <button class="ghost" on:click={() => choose(false)}>{$t("telemetry.decline")}</button>
      <button class="go" on:click={() => choose(true)}>{$t("telemetry.accept")}</button>
    </div>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 70; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px; max-width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .title { font-weight: 600; margin-bottom: 8px; }
  .sub { color: var(--text-dim); margin-bottom: 12px; font-size: 12px; line-height: 1.5; }
  .learn { display: inline-block; margin-bottom: 18px; padding: 0; background: none; border: 0;
    cursor: pointer; font: inherit; font-size: 12px; color: var(--text-dim);
    text-decoration: underline; text-decoration-style: dashed; text-underline-offset: 3px; }
  .learn:hover, .learn:focus-visible { color: var(--accent); outline: none; }
  .row { display: flex; gap: 10px; justify-content: flex-end; }
  button { padding: 8px 14px; border-radius: 9px; border: 1px solid var(--glass-brd); background: transparent; }
  /* Matches the Library import button: accent-translucent fill, accent border. */
  .go { border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18);
    color: #fff; font-weight: 600; cursor: pointer;
    transition: background 0.14s ease, border-color 0.14s ease; }
  .go:hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
  .go:active { background: rgba(244,157,78,0.30); }
</style>
