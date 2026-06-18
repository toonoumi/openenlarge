<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { images, selectedFolder, selectFolder, omitPreviewJpgs } from "../store";
  import { importPaths, deleteImage, IMPORT_EXTENSIONS, omitPreviewSidecars, selectImportPaths } from "../workflow";
  import { api } from "../api";
  import { buildTree, countImages, type FolderNode } from "./folderTree";
  import { scopeToFolder } from "./folderScope";
  import TreeNode from "./TreeNode.svelte";
  import FolderContextMenu from "../overlay/FolderContextMenu.svelte";
  import ConfirmRemoveFolder from "../overlay/ConfirmRemoveFolder.svelte";
  import Icon from "../icons/Icon.svelte";
  import GlassPanel from "../glass/GlassPanel.svelte";
  import TetherPanel from "../tether/TetherPanel.svelte";
  import { t } from "$lib/i18n";
  import { scale } from "svelte/transition";

  let importing = false;
  let menuOpen = false;
  $: filterFilmScans = $t("folderNav.filterFilmScans");
  $: tree = buildTree($images);
  $: if (!$selectedFolder && $images.length) {
    const last = $images[$images.length - 1];
    const dir = last.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    selectFolder(dir);
  }

  async function pickFilesAndImport() {
    menuOpen = false;
    const sel = await openDialog({ multiple: true, filters: [{ name: filterFilmScans, extensions: IMPORT_EXTENSIONS }] });
    if (!sel) return;
    let paths = (Array.isArray(sel) ? sel : [sel]) as string[];
    if ($omitPreviewJpgs) paths = omitPreviewSidecars(paths);
    importing = true;
    await importPaths(paths);
    importing = false;
  }

  async function pickFolderAndImport() {
    menuOpen = false;
    const dir = await openDialog({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    importing = true;
    try {
      const files = await api.listDirFiles(dir);
      await importPaths(selectImportPaths(files, $omitPreviewJpgs));
    } catch (e) {
      console.error("folder import failed", dir, e);
    }
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
    <div class="omit-row">
      <label class="omit">
        <input type="checkbox" bind:checked={$omitPreviewJpgs} />
        <span>{$t('folderNav.omitPreviewJpgs')}</span>
      </label>
      <button type="button" class="help" aria-label={$t('folderNav.omitPreviewJpgsHelp')}>?<span class="tip">{$t('folderNav.omitPreviewJpgsHelp')}</span></button>
    </div>
    <div class="import-wrap">
      <button class="import" on:click={() => (menuOpen = !menuOpen)} disabled={importing} aria-haspopup="menu" aria-expanded={menuOpen}>
        <Icon name="plus" /> {importing ? $t('folderNav.importing') : $t('folderNav.import')}
        <span class="caret">▾</span>
      </button>
      {#if menuOpen && !importing}
        <button type="button" class="menu-backdrop" aria-label="close" on:click={() => (menuOpen = false)}></button>
        <div class="import-menu" role="menu" transition:scale={{ duration: 130, start: 0.94, opacity: 0 }}>
          <button type="button" role="menuitem" on:click={pickFilesAndImport}>{$t('folderNav.importFiles')}</button>
          <button type="button" role="menuitem" on:click={pickFolderAndImport}>{$t('folderNav.importFolder')}</button>
        </div>
      {/if}
    </div>
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
  .omit-row { position: relative; display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .omit { display: flex; align-items: center; gap: 7px; padding: 2px 4px;
    color: var(--text-dim); font-size: 12px; cursor: pointer; user-select: none; }
  .omit input { cursor: pointer; accent-color: #bf6d3a; margin: 0; }
  /* "?" help chip with a hover/focus tooltip. */
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
  .import-wrap { position: relative; }
  .caret { font-size: 10px; opacity: 0.85; margin-left: -2px;
    transition: transform 0.14s ease; }
  .import[aria-expanded="true"] .caret { transform: rotate(180deg); }
  .menu-backdrop { position: fixed; inset: 0; z-index: 39; background: transparent;
    border: 0; padding: 0; cursor: default; }
  .import-menu { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 40;
    transform-origin: bottom center;
    display: flex; flex-direction: column; padding: 4px;
    border-radius: 9px; background: var(--bg-1); border: 1px solid var(--glass-brd);
    box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .import-menu button { text-align: left; padding: 8px 10px; border: 0; border-radius: 6px;
    background: transparent; color: var(--text); font: inherit; cursor: pointer; }
  .import-menu button:hover { background: rgba(244,157,78,0.18); }
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
