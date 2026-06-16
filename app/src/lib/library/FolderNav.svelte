<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { images, selectedFolder, selectFolder } from "../store";
  import { importPaths, IMPORT_EXTENSIONS } from "../workflow";
  import { buildTree } from "./folderTree";
  import TreeNode from "./TreeNode.svelte";
  import Icon from "../icons/Icon.svelte";
  import GlassPanel from "../glass/GlassPanel.svelte";
  import TetherPanel from "../tether/TetherPanel.svelte";
  import { t } from "$lib/i18n";

  let importing = false;
  $: filterFilmScans = $t("folderNav.filterFilmScans");
  $: tree = buildTree($images);
  $: if (!$selectedFolder && $images.length) {
    const last = $images[$images.length - 1];
    const dir = last.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    selectFolder(dir);
  }

  async function pickAndImport() {
    const sel = await openDialog({ multiple: true, filters: [{ name: filterFilmScans, extensions: IMPORT_EXTENSIONS }] });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    importing = true;
    await importPaths(paths as string[]);
    importing = false;
  }
</script>

<GlassPanel shadow={false}>
  <div class="wrap">
    <div class="ttl">{$t('folderNav.imported')}</div>
    <div class="tree">
      {#each tree as root}<TreeNode node={root} isRoot={true} />{/each}
      {#if $images.length === 0}<div class="empty">{$t('folderNav.noImages')}</div>{/if}
    </div>
    <button class="import" on:click={pickAndImport} disabled={importing}>
      <Icon name="plus" /> {importing ? $t('folderNav.importing') : $t('folderNav.import')}
    </button>
    <TetherPanel />
  </div>
</GlassPanel>

<style>
  .wrap { display: flex; flex-direction: column; height: 100%; }
  .ttl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.7px; color: var(--text-faint); padding: 2px 6px 10px; }
  .tree { flex: 1; overflow: auto; }
  .empty { color: var(--text-faint); padding: 8px; }
  .import { margin-top: 10px; width: 100%; padding: 10px; border-radius: 9px;
    border: 1px solid rgba(0,0,0,0.25);
    background: #bf6d3a; color: #f3ece6; font: inherit; font-weight: 600; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: transform 0.14s ease, background 0.14s ease; }
  .import:hover:not(:disabled) { transform: scale(1.02); background: #cd7842; }
  .import:active:not(:disabled) { transform: scale(0.99); background: #bf6d3a; }
  .import:disabled { opacity: 0.55; cursor: default; }
  @media (prefers-reduced-motion: reduce) {
    .import { transition: background 0.14s ease; }
    .import:hover:not(:disabled), .import:active:not(:disabled) { transform: none; }
  }
</style>
