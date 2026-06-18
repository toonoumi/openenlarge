<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Icon from "../icons/Icon.svelte";
  import { selectedFolder, selectFolder } from "../store";
  import { countImages, type FolderNode } from "./folderTree";
  export let node: FolderNode;
  export let depth = 0;
  export let isRoot = false;
  let open = true;
  $: hasChildren = node.children.length > 0;
  $: count = countImages(node);
  const dispatch = createEventDispatcher<{ menu: { x: number; y: number; node: FolderNode } }>();
</script>

<div class="row" class:sel={$selectedFolder === node.fullPath}
  style="padding-left:{8 + depth * 16}px"
  on:click={() => { selectFolder(node.fullPath); if (hasChildren) open = !open; }}
  on:contextmenu|preventDefault={(e) => dispatch("menu", { x: e.clientX, y: e.clientY, node })}>
  <span class="chev">
    {#if hasChildren}<Icon name={open ? "chevron-down" : "chevron-right"} size={12} />{/if}
  </span>
  <Icon name={isRoot ? "hard-drive" : "folder"} />
  <span class="lbl">{node.name}</span>
  {#if count > 0}<span class="ct">{count}</span>{/if}
</div>
{#if open}
  {#each node.children as child}
    <svelte:self node={child} depth={depth + 1} on:menu />
  {/each}
{/if}

<style>
  /* Rows grow to fit their full label (no ellipsis) and stay at least panel-wide, so the
     tree can scroll horizontally to reveal clipped subfolder names while highlights still
     span the full row. */
  .row { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 8px;
    color: var(--text-dim); cursor: pointer; white-space: nowrap; width: max-content; min-width: 100%; }
  .row:hover { background: rgba(255,255,255,0.04); }
  .row.sel { background: rgba(255,255,255,0.07); color: var(--text); }
  .chev { color: var(--text-faint); display: inline-flex; width: 12px; }
  .lbl { white-space: nowrap; }
  .ct { margin-left: auto; font-size: 11px; color: var(--text-faint); padding-left: 8px; }
</style>
