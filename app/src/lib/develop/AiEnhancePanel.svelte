<script lang="ts">
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { previewSrc, openaiApiKey } from "../store";
  import { api } from "../api";

  let busy = false;
  let error = "";
  /** Enhanced result as a PNG data URL, or "" when none yet. */
  let result = "";
  /** The source preview captured at enhance time, for the before/after toggle. */
  let source = "";
  let showBefore = false;
  let enlarged = false;

  async function enhance() {
    error = "";
    result = "";
    source = "";
    const key = get(openaiApiKey).trim();
    if (!key) { error = $t("aiEnhance.noKey"); return; }

    const preview = get(previewSrc);
    const comma = preview.indexOf(",");
    if (!preview || comma < 0) { error = $t("aiEnhance.noImage"); return; }
    const b64 = preview.slice(comma + 1);

    busy = true;
    source = preview;
    try {
      result = await api.aiEnhanceImage(b64, key);
      showBefore = false;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="section">
  <div class="head"><span>{$t("aiEnhance.title")}</span><span class="exp">{$t("aiEnhance.experimental")}</span></div>

  <button class="go" class:busy disabled={busy} on:click={enhance}>
    {#if busy}<span class="spinner" aria-hidden="true"></span>{/if}
    <span>{busy ? $t("aiEnhance.working") : $t("aiEnhance.button")}</span>
  </button>

  {#if error}
    <div class="err">{error}</div>
  {/if}

  {#if result}
    <div class="result">
      <button class="img" on:click={() => (enlarged = true)} title={$t("aiEnhance.enlarge")}>
        <img src={showBefore ? source : result} alt={$t("aiEnhance.title")} />
      </button>
      <button class="toggle" on:mousedown={() => (showBefore = true)}
              on:mouseup={() => (showBefore = false)} on:mouseleave={() => (showBefore = false)}>
        {$t("aiEnhance.holdBefore")}
      </button>
    </div>
  {/if}

  <div class="hint">{$t("aiEnhance.hint")}</div>
</div>

{#if enlarged}
  <div class="lightbox" role="button" tabindex="0"
       on:click={() => (enlarged = false)} on:keydown={(e) => e.key === "Escape" && (enlarged = false)}>
    <img src={result} alt={$t("aiEnhance.title")} />
  </div>
{/if}

<style>
  .section { margin-bottom: 12px; }
  .head { display: flex; align-items: center; gap: 8px; color: var(--text);
    font-weight: 600; padding: 4px 0; }
  .exp { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid rgba(244,157,78,0.5); color: var(--accent);
    border-radius: 4px; padding: 0 5px; }
  .go { width: 100%; padding: 9px 10px; margin: 6px 0; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18);
    color: #fff; cursor: pointer; font-size: 13px; }
  .go:disabled { cursor: default; }
  /* While enhancing, dim slightly and softly pulse the accent fill. */
  .go.busy { animation: pulse 1.4s ease-in-out infinite; }
  .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
    animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse {
    0%, 100% { background: rgba(244,157,78,0.18); }
    50% { background: rgba(244,157,78,0.34); }
  }
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
  .result { margin-top: 8px; }
  .img { display: block; width: 100%; padding: 0; border: 1px solid var(--glass-brd);
    border-radius: 8px; overflow: hidden; background: transparent; cursor: zoom-in; }
  .img img { display: block; width: 100%; }
  .toggle { width: 100%; margin-top: 6px; padding: 6px 10px; border-radius: 8px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text);
    cursor: pointer; font-size: 12px; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
  .lightbox { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center;
    background: rgba(0,0,0,0.8); cursor: zoom-out; }
  .lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
</style>
