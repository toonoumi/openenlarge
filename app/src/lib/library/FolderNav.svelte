<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { images, selectedFolder, selectFolder, omitPreviewJpgs } from "../store";
  import { importPaths, deleteImage, IMPORT_EXTENSIONS, omitPreviewSidecars } from "../workflow";
  import { buildTree, countImages, type FolderNode } from "./folderTree";
  import { scopeToFolder } from "./folderScope";
  import TreeNode from "./TreeNode.svelte";
  import FolderContextMenu from "../overlay/FolderContextMenu.svelte";
  import ConfirmRemoveFolder from "../overlay/ConfirmRemoveFolder.svelte";
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
    let paths = (Array.isArray(sel) ? sel : [sel]) as string[];
    if ($omitPreviewJpgs) paths = omitPreviewSidecars(paths);
    importing = true;
    await importPaths(paths);
    importing = false;
  }

  // Right-click a folder → context menu → confirm popup → remove its images.
  let folderMenu: { x: number; y: number; node: FolderNode } | null = null;
  let removeTarget: FolderNode | null = null;
  function onFolderMenu(e: CustomEvent<{ x: number; y: number; node: FolderNode }>) {
    folderMenu = e.detail;
  }
  async function removeFolder(deleteFile: boolean) {
    const node = removeTarget;
    removeTarget = null;
    if (!node) return;
    const ids = scopeToFolder($images, node.fullPath).map((i) => i.id);
    for (const id of ids) await deleteImage(id, deleteFile);
    selectedFolder.set(null); // the tree just lost this folder; let it re-select
  }
</script>

<GlassPanel shadow={false}>
  <div class="wrap">
    <div class="ttl">{$t('folderNav.imported')}</div>
    <div class="tree">
      {#each tree as root}<TreeNode node={root} isRoot={true} on:menu={onFolderMenu} />{/each}
      {#if $images.length === 0}<div class="empty">{$t('folderNav.noImages')}</div>{/if}
    </div>
    <label class="omit">
      <input type="checkbox" bind:checked={$omitPreviewJpgs} />
      <span>{$t('folderNav.omitPreviewJpgs')}</span>
    </label>
    <button class="import" on:click={pickAndImport} disabled={importing}>
      <Icon name="plus" /> {importing ? $t('folderNav.importing') : $t('folderNav.import')}
    </button>
    <TetherPanel />
  </div>
</GlassPanel>

{#if folderMenu}
  <FolderContextMenu x={folderMenu.x} y={folderMenu.y}
    on:remove={() => { if (folderMenu) { removeTarget = folderMenu.node; folderMenu = null; } }}
    on:close={() => (folderMenu = null)} />
{/if}
{#if removeTarget}
  <ConfirmRemoveFolder name={removeTarget.name} count={countImages(removeTarget)}
    on:remove={() => removeFolder(false)}
    on:trash={() => removeFolder(true)}
    on:cancel={() => (removeTarget = null)} />
{/if}

<style>
  .wrap { display: flex; flex-direction: column; height: 100%; }
  .ttl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.7px; color: var(--text-faint); padding: 2px 6px 10px; }
  .tree { flex: 1; overflow: auto; }
  .empty { color: var(--text-faint); padding: 8px; }
  .omit { display: flex; align-items: center; gap: 7px; margin-top: 10px; padding: 2px 4px;
    color: var(--text-dim); font-size: 12px; cursor: pointer; user-select: none; }
  .omit input { cursor: pointer; accent-color: #bf6d3a; margin: 0; }
  .import { margin-top: 8px; width: 100%; padding: 10px; border-radius: 9px;
    border: 1px solid rgba(244,157,78,0.5);
    background: rgba(244,157,78,0.18); color: #fff; font: inherit; font-weight: 600; cursor: pointer;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: background 0.14s ease, border-color 0.14s ease; }
  .import:hover:not(:disabled) { background: rgba(244,157,78,0.30); border-color: rgba(244,157,78,0.75); }
  .import:active:not(:disabled) { background: rgba(244,157,78,0.30); }
  .import:disabled { opacity: 0.55; cursor: default; }
  @media (prefers-reduced-motion: reduce) {
    .import { transition: background 0.14s ease; }
    .import:hover:not(:disabled), .import:active:not(:disabled) { transform: none; }
  }
</style>
