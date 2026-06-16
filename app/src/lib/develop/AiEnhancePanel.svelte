<script lang="ts">
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { previewSrc, openaiApiKey, activeId, params } from "../store";
  import { commitActive } from "./historyStore";
  import { api, type MatchedParams } from "../api";
  import { open } from "@tauri-apps/plugin-dialog";

  let busy = false;
  let error = "";
  /** Enhanced result as a PNG data URL, or "" when none yet. */
  let result = "";
  /** The source preview captured at enhance time, for the before/after toggle. */
  let source = "";
  let showBefore = false;
  let enlarged = false;

  // --- Match Reference (local color-toning match) ---
  let refPath = "";
  let refSrc = "";       // base64 thumbnail data URL from Rust
  let strength = 60;     // 0..100
  let matchBusy = false;
  let matchError = "";
  /** The full-strength match (100%) and the pre-match scoped values, captured at
   *  "Match toning" time so the Strength slider can blend live without a backend
   *  round-trip per frame. Null until a match has been computed. */
  let matchedFull: MatchedParams | null = null;
  let origScoped: MatchedParams | null = null;

  async function pickReference() {
    matchError = "";
    const sel = await open({ multiple: false, filters: [
      { name: "Images", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "webp"] },
    ] });
    if (typeof sel === "string") {
      refPath = sel;
      matchedFull = null; origScoped = null; // new reference → require a fresh match
      try { refSrc = await api.referenceThumb(sel); }
      catch { refSrc = ""; }
    }
  }

  /** Blend the stored full-strength match toward the pre-match values by the
   *  current strength and apply to params. Does NOT commit (live preview). */
  function applyStrength() {
    if (!matchedFull || !origScoped) return;
    const s = strength / 100;
    const blended: Partial<MatchedParams> = {};
    for (const k of Object.keys(matchedFull) as (keyof MatchedParams)[]) {
      blended[k] = origScoped[k] + (matchedFull[k] - origScoped[k]) * s;
    }
    params.update((p) => ({ ...p, ...blended }));
  }

  async function matchToning() {
    matchError = "";
    const id = get(activeId);
    if (!id) { matchError = $t("aiEnhance.noImage"); return; }
    if (!refPath) { matchError = $t("colorMatch.noRef"); return; }
    matchBusy = true;
    try {
      const cur = get(params);
      // Compute the full-strength match once; the slider blends it live after.
      const full = await api.colorMatchParams(id, cur, refPath, 100);
      const orig = {} as MatchedParams;
      for (const k of Object.keys(full) as (keyof MatchedParams)[]) {
        orig[k] = cur[k] as number;
      }
      matchedFull = full; origScoped = orig;
      applyStrength();   // apply at the current strength…
      commitActive();    // …as a single undoable step.
    } catch (e) {
      matchError = String(e);
    } finally {
      matchBusy = false;
    }
  }

  /** Restore the pre-match values and clear the match (one undo step). */
  function resetMatch() {
    if (origScoped) {
      const orig = origScoped;
      params.update((p) => ({ ...p, ...orig }));
      commitActive();
    }
    matchedFull = null; origScoped = null;
    strength = 60;
  }

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
  <div class="head">
    <span>{$t("aiEnhance.title")}</span>
    <span class="exp">{$t("aiEnhance.experimental")}</span>
    <button type="button" class="help" aria-label={$t("aiEnhance.hint")}>?<span class="tip">{$t("aiEnhance.hint")}</span></button>
  </div>

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

  <div class="match">
    <div class="head">
      <span>{$t("colorMatch.title")}</span>
      <button type="button" class="help" aria-label={$t("colorMatch.hint")}>?<span class="tip">{$t("colorMatch.hint")}</span></button>
    </div>

    {#if refPath}
      <button class="ref-box" on:click={pickReference} title={$t("colorMatch.changeRef")}>
        <img src={refSrc} alt="" />
      </button>
    {:else}
      <button class="ref-pick" on:click={pickReference}>{$t("colorMatch.import")}</button>
    {/if}

    {#if refPath}
      <button class="go" class:busy={matchBusy} disabled={matchBusy} on:click={matchToning}>
        {#if matchBusy}<span class="spinner" aria-hidden="true"></span>{/if}
        <span>{matchBusy ? $t("colorMatch.matching") : $t("colorMatch.match")}</span>
      </button>
    {/if}

    {#if matchedFull}
      <label class="strength">
        <span>{$t("colorMatch.strength")}</span>
        <input type="range" min="0" max="100" bind:value={strength}
               on:input={applyStrength} on:change={() => commitActive()} />
        <span class="val">{strength}%</span>
      </label>
      <button class="reset" on:click={resetMatch}>{$t("colorMatch.reset")}</button>
    {/if}

    {#if matchError}<div class="err">{matchError}</div>{/if}
  </div>
</div>

{#if enlarged}
  <div class="lightbox" role="button" tabindex="0"
       on:click={() => (enlarged = false)} on:keydown={(e) => e.key === "Escape" && (enlarged = false)}>
    <img src={result} alt={$t("aiEnhance.title")} />
  </div>
{/if}

<style>
  .section { margin-bottom: 12px; }
  .head { position: relative; display: flex; align-items: center; gap: 8px;
    color: var(--text); font-weight: 600; padding: 4px 0; }
  .exp { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid rgba(244,157,78,0.5); color: var(--accent);
    border-radius: 4px; padding: 0 5px; }
  /* "?" help chip with a hover/focus tooltip (replaces the inline hint text). */
  .help { display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; padding: 0; border-radius: 50%;
    border: 1px solid var(--glass-brd); background: transparent;
    color: var(--text-dim); font-size: 10px; font-weight: 600; line-height: 1;
    cursor: help; user-select: none; }
  .help:hover, .help:focus-visible { color: var(--text); border-color: var(--accent); outline: none; }
  .tip { position: absolute; left: 0; top: calc(100% + 4px); width: 100%; z-index: 30;
    padding: 8px 10px; border-radius: 8px; background: var(--bg-1);
    border: 1px solid var(--glass-brd); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    color: var(--text-dim); font-size: 11px; font-weight: 400; line-height: 1.5;
    opacity: 0; visibility: hidden; transition: opacity 0.14s ease; pointer-events: none; }
  .help:hover .tip, .help:focus-visible .tip { opacity: 1; visibility: visible; }
  .go { width: 100%; padding: 9px 10px; margin: 6px 0; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18);
    color: #fff; cursor: pointer; font-size: 13px; }
  .go:not(:disabled):hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
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
  .toggle:hover { background: var(--glass-hi); }
  .lightbox { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center;
    background: rgba(0,0,0,0.8); cursor: zoom-out; }
  .lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
  .match { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--glass-brd); }
  .ref-pick { width: 100%; padding: 8px 10px; margin: 6px 0; border-radius: 8px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text);
    cursor: pointer; font-size: 13px; }
  .ref-pick:hover { background: var(--glass-hi); border-color: rgba(255,255,255,0.18); }
  /* Reference preview: large, tap to change. */
  .ref-box { display: block; width: 100%; padding: 0; margin: 6px 0; border-radius: 8px;
    overflow: hidden; border: 1px solid var(--glass-brd); background: transparent;
    cursor: pointer; }
  .ref-box img { display: block; width: 100%; height: 132px; object-fit: cover; }
  .ref-box:hover { border-color: var(--accent); }
  .reset { width: 100%; margin: 2px 0 0; padding: 6px 10px; border-radius: 8px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text-dim);
    cursor: pointer; font-size: 12px; }
  .reset:hover { background: var(--glass-hi); color: var(--text); }
  .strength { display: flex; align-items: center; gap: 8px; margin: 8px 0;
    font-size: 12px; color: var(--text); }
  /* Match the app's design-system slider (see develop/Slider.svelte). */
  .strength input[type="range"] { flex: 1; height: 3px; border-radius: 3px;
    -webkit-appearance: none; appearance: none; background: var(--glass-brd);
    accent-color: var(--accent); }
  .strength input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none;
    width: 12px; height: 12px; border-radius: 50%; background: #fff;
    border: 1px solid rgba(0,0,0,0.3); box-shadow: 0 1px 3px rgba(0,0,0,0.4); cursor: grab; }
  .strength input[type="range"]:active::-webkit-slider-thumb { cursor: grabbing; }
  .strength .val { width: 34px; text-align: right; color: var(--text-dim); }
</style>
