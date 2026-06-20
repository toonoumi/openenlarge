<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { createEventDispatcher } from "svelte";
  import { fade, scale } from "svelte/transition";
  import {
    groupedActions, effectiveDefs, bindingTokens, captureBinding, findConflict,
    type HotkeyAction, type Binding,
  } from "./hotkeys";
  import { hotkeyBindings } from "../store";
  import { t } from "$lib/i18n";

  const dispatch = createEventDispatcher<{ close: void }>();
  const groups = groupedActions();

  // Which (action, binding slot) is currently capturing a keystroke, if any.
  let listening: { action: HotkeyAction; slot: number } | null = null;
  // A rejected rebind: the candidate collides with another action.
  let conflict: { tokens: string[]; withLabel: string } | null = null;

  function startListen(action: HotkeyAction, slot: number) {
    if (!action.rebindable) return;
    conflict = null;
    listening = { action, slot };
  }

  function applyBinding(action: HotkeyAction, slot: number, cand: Binding) {
    const cur = effectiveDefs(action, get(hotkeyBindings)).slice();
    cur[slot] = cand;
    hotkeyBindings.update((m) => ({ ...m, [action.id]: cur }));
  }

  function resetAll() {
    hotkeyBindings.set({});
    listening = null;
    conflict = null;
  }

  // Single capture-phase handler so a captured keystroke never leaks to the app's
  // own shortcut handlers underneath the modal.
  function onCapture(e: KeyboardEvent) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!listening) {
      if (e.key === "Escape") dispatch("close");
      return;
    }
    if (e.key === "Escape") { listening = null; conflict = null; return; }
    const cand = captureBinding(e, listening.action.kind === "chord");
    if (!cand) return; // modifier-only press — keep waiting for the real key
    const other = findConflict(listening.action, cand, get(hotkeyBindings));
    if (other) {
      conflict = { tokens: bindingTokens(cand), withLabel: $t(other.label) };
      return; // keep listening so the user can pick a different key
    }
    applyBinding(listening.action, listening.slot, cand);
    listening = null;
    conflict = null;
  }

  onMount(() => {
    window.addEventListener("keydown", onCapture, true);
    return () => window.removeEventListener("keydown", onCapture, true);
  });
</script>

<div class="scrim" on:click|self={() => dispatch("close")} transition:fade={{ duration: 150 }}>
  <div class="card" role="dialog" aria-label={$t('keymap.title')} transition:scale={{ duration: 160, start: 0.96, opacity: 0 }}>
    <div class="head">
      <div class="title">{$t('keymap.title')}</div>
      <button class="reset" on:click={resetAll}>{$t('keymap.reset')}</button>
    </div>
    <div class="subtitle">{$t('keymap.subtitle')}</div>

    {#if conflict}
      <div class="conflict" role="alert">
        <span class="combo warn">{#each conflict.tokens as tk}<kbd>{tk}</kbd>{/each}</span>
        {$t('keymap.conflict', { action: conflict.withLabel })}
      </div>
    {/if}

    <div class="groups">
      {#each groups as group}
        <div class="grp">{$t(group.heading)}</div>
        {#each group.items as action}
          <div class="row">
            <span class="label">{$t(action.label)}</span>
            <span class="keys">
              {#each effectiveDefs(action, $hotkeyBindings) as binding, slot}
                {#if slot > 0}<span class="sep">/</span>{/if}
                {#if action.rebindable}
                  <button
                    class="combo edit"
                    class:listening={listening && listening.action.id === action.id && listening.slot === slot}
                    on:click={() => startListen(action, slot)}>
                    {#if listening && listening.action.id === action.id && listening.slot === slot}
                      <span class="prompt">{$t('keymap.listening')}</span>
                    {:else}
                      {#each bindingTokens(binding) as tk}<kbd>{tk}</kbd>{/each}
                    {/if}
                  </button>
                {:else}
                  <span class="combo">{#each bindingTokens(binding) as tk}<kbd>{tk}</kbd>{/each}</span>
                {/if}
              {/each}
              <!-- Chord adjustments are held while tapping the arrows: spell that out
                   inline (the held key is rebindable, the ←/→ are fixed). -->
              {#if action.kind === "chord"}
                <span class="plus">+</span>
                <span class="combo"><kbd>←</kbd><kbd>→</kbd></span>
              {/if}
            </span>
          </div>
        {/each}
      {/each}
    </div>
    <div class="foot">
      <div class="spacer"></div>
      <button class="go" on:click={() => dispatch("close")}>{$t('keymap.close')}</button>
    </div>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 80; }
  .card { background: var(--glass-bg); border: 1px solid var(--glass-brd); border-radius: 14px;
    padding: 22px; min-width: 420px; max-width: 480px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .title { font-weight: 600; }
  .reset { background: transparent; border: 1px solid var(--glass-brd); color: var(--text-dim);
    border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .reset:hover { color: var(--text); border-color: var(--accent); }
  .subtitle { font-size: 11px; color: var(--text-dim); margin-bottom: 10px; line-height: 1.4; }
  .conflict { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #fff;
    background: rgba(244,157,78,0.18); border: 1px solid rgba(244,157,78,0.5);
    border-radius: 8px; padding: 8px 10px; margin-bottom: 12px; }
  .groups { max-height: 56vh; overflow-y: auto; margin-bottom: 16px; }
  .grp { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim);
    margin: 14px 2px 6px; }
  .grp:first-child { margin-top: 6px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 6px 2px; }
  .label { font-size: 13px; color: var(--text); }
  .keys { display: flex; align-items: center; gap: 6px; flex: none; }
  .sep { color: var(--text-dim); font-size: 12px; }
  .plus { color: var(--text-dim); font-size: 12px; margin: 0 -1px; }
  .combo { display: flex; gap: 2px; align-items: center; }
  /* Editable chips look pressable; the listening one glows like the accent buttons. */
  .combo.edit { background: transparent; border: 1px solid transparent; border-radius: 7px;
    padding: 2px 4px; cursor: pointer; }
  .combo.edit:hover { border-color: var(--glass-brd); background: var(--glass-hi); }
  .combo.edit.listening { border-color: rgba(244,157,78,0.7); background: rgba(244,157,78,0.18); }
  .prompt { font-size: 11px; color: #fff; padding: 2px 6px; }
  kbd { display: inline-block; min-width: 20px; text-align: center; padding: 2px 6px;
    font-family: inherit; font-size: 12px; line-height: 1.3; color: var(--text);
    background: var(--glass-hi); border: 1px solid var(--glass-brd); border-radius: 6px;
    box-shadow: 0 1px 0 rgba(0,0,0,0.3); }
  .combo.warn kbd { background: rgba(255,255,255,0.18); border-color: rgba(255,255,255,0.35); }
  .foot { display: flex; align-items: center; gap: 10px; }
  .spacer { flex: 1; }
  .go { padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18); color: #fff;
    transition: background 0.12s ease, border-color 0.12s ease; }
  .go:hover { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
</style>
