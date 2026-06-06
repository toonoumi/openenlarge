<script lang="ts">
  import Icon from "../icons/Icon.svelte";
  import { t } from "$lib/i18n";
  import { tool, type Tool } from "../store";

  const tools: { id: Tool; icon: string; labelKey: string; enabled: boolean }[] = [
    { id: "edit", icon: "sliders", labelKey: "toolbar.edit", enabled: true },
    { id: "crop", icon: "crop", labelKey: "toolbar.crop", enabled: true },
    { id: "eraser", icon: "eraser", labelKey: "toolbar.eraser", enabled: true },
  ];
  $: activeIndex = Math.max(0, tools.findIndex((tl) => tl.id === $tool));
</script>

<div class="toolbar" style="--n:{tools.length}; --i:{activeIndex}">
  <span class="ind" aria-hidden="true"></span>
  {#each tools as tl}
    <button
      class:on={$tool === tl.id} disabled={!tl.enabled} title={$t(tl.labelKey)}
      on:click={() => tl.enabled && tool.set(tl.id)}
    >
      <Icon name={tl.icon} size={17} />
    </button>
  {/each}
</div>

<style>
  .toolbar { position: relative; display: flex; gap: 4px; margin-bottom: 12px;
    padding-bottom: 10px; border-bottom: 1px solid var(--glass-brd); }
  /* Accent pill that slides to the active tool. Width/offset derive from --n
     buttons separated by 4px gaps, so it stays aligned for any tool count. */
  .ind { position: absolute; z-index: 0; top: 0; left: 0; height: calc(100% - 10px);
    width: calc((100% - (var(--n) - 1) * 4px) / var(--n));
    transform: translateX(calc(var(--i) * (100% + 4px)));
    border-radius: 8px; background: rgba(244,157,78,0.18);
    border: 1px solid rgba(244,157,78,0.5);
    transition: transform 0.28s cubic-bezier(0.34, 1.3, 0.5, 1); }
  button { position: relative; z-index: 1; flex: 1; display: grid; place-items: center; padding: 7px 0;
    border-radius: 8px; border: 1px solid transparent; background: transparent;
    color: var(--text-dim); cursor: pointer; transition: color 0.2s ease; }
  button.on { color: #fff; }
  button:disabled { opacity: 0.35; cursor: default; }
</style>
