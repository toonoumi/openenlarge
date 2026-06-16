<script lang="ts">
  import FolderNav from "../library/FolderNav.svelte";
  import Grid from "../library/Grid.svelte";
  import Metadata from "../panels/Metadata.svelte";
  import Filmstrip from "../panels/Filmstrip.svelte";
  import ImageContextMenu from "../overlay/ImageContextMenu.svelte";
  import Icon from "../icons/Icon.svelte";
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { activeId, images, folderImages, deleteTarget, selectAll, deleteSelectionIds, setActive, omitPreviewJpgs } from "../store";
  import { importPaths, filterImportable, omitPreviewSidecars } from "../workflow";
  import { get } from "svelte/store";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { t } from "$lib/i18n";

  // Drag-and-drop import. Tauri intercepts OS file drops at the window level (HTML5
  // dnd is disabled), so we listen to the webview drag-drop event and only act while
  // the Library tab is mounted. `dragging` drives the drop indicator overlay.
  let dragging = false;
  let importing = false;
  onMount(() => {
    let unlisten = () => {};
    let disposed = false;
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") dragging = true;
      else if (p.type === "leave") dragging = false;
      else if (p.type === "drop") {
        dragging = false;
        let paths = filterImportable(p.paths);
        if (get(omitPreviewJpgs)) paths = omitPreviewSidecars(paths);
        if (paths.length) { importing = true; importPaths(paths).finally(() => (importing = false)); }
      }
    }).then((u) => { if (disposed) u(); else unlisten = u; });
    return () => { disposed = true; unlisten(); };
  });

  // Skip nav while a form control (e.g. the thumb-size slider) is focused, so its
  // own arrow-key behaviour wins.
  function formFocused(): boolean {
    const tag = document.activeElement?.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  }

  // Right-click a thumbnail (grid cell or filmstrip button — both carry data-id)
  // to open the context menu. Delete acts on the whole current selection (its label
  // shows the count), so right-click doesn't alter the selection; "Open in folder"
  // reveals the specific file that was right-clicked (tracked via ctxMenu.id).
  let ctxMenu: { x: number; y: number; id: string } | null = null;
  function onContext(e: MouseEvent) {
    e.preventDefault();
    const id = (e.target as HTMLElement).closest("[data-id]")?.getAttribute("data-id");
    if (!id) { ctxMenu = null; return; }
    ctxMenu = { x: e.clientX, y: e.clientY, id };
  }

  async function revealImage(id: string) {
    const img = $images.find((i) => i.id === id);
    if (img) { try { await revealItemInDir(img.path); } catch (e) { console.error("reveal failed", e); } }
  }

  // Arrow keys navigate images within the selected folder (grid or filmstrip), no
  // focus required: ←/→ step, ↑ first, ↓ last. Scoped to the folder — switch folders
  // via the tree on the left.
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      if (formFocused()) return;
      e.preventDefault();
      selectAll();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      e.preventDefault();
      if (!formFocused()) {
        const ids = deleteSelectionIds();
        if (ids.length) deleteTarget.set(ids);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!arrows.includes(e.key) || formFocused()) return;
    const list = $folderImages;
    if (list.length === 0) return;
    let idx = list.findIndex((i) => i.id === $activeId);
    if (idx < 0) idx = 0;
    if (e.key === "ArrowLeft") idx = Math.max(0, idx - 1);
    else if (e.key === "ArrowRight") idx = Math.min(list.length - 1, idx + 1);
    else if (e.key === "ArrowUp") idx = 0;
    else idx = list.length - 1;
    e.preventDefault();
    setActive(list[idx].id);
  }
</script>

<svelte:window on:keydown={onKey} />

<div class="layout" on:contextmenu={onContext}>
  <aside class="left"><FolderNav /></aside>
  <section class="center"><div class="pad"><Grid /></div></section>
  <aside class="right"><Metadata /></aside>
  <footer class="bottom"><Filmstrip /></footer>
</div>

{#if ctxMenu}
  <ImageContextMenu x={ctxMenu.x} y={ctxMenu.y} count={deleteSelectionIds().length} showReveal={true}
    on:reveal={() => { if (ctxMenu) revealImage(ctxMenu.id); ctxMenu = null; }}
    on:delete={() => { const ids = deleteSelectionIds(); if (ids.length) deleteTarget.set(ids); ctxMenu = null; }}
    on:close={() => (ctxMenu = null)} />
{/if}

{#if dragging || importing}
  <div class="dropzone" transition:fade={{ duration: 120 }}>
    <div class="dropcard">
      <Icon name="plus" size={26} />
      <div class="dt">{importing ? $t('library.dropImporting') : $t('library.dropToImport')}</div>
      <div class="df">{$t('library.dropFormats')}</div>
    </div>
  </div>
{/if}

<style>
  .layout { display: grid; height: 100%; gap: 14px;
    grid-template-columns: 232px 1fr 268px; grid-template-rows: 1fr 88px;
    grid-template-areas: "left center right" "bottom bottom bottom"; }
  .left { grid-area: left; } .right { grid-area: right; }
  .left, .right { min-height: 0; }
  .center { grid-area: center; min-height: 0; background: #181818; border: 1px solid var(--glass-brd);
    border-radius: 14px; }
  .pad { padding: 14px; height: 100%; }
  .bottom { grid-area: bottom; }

  /* Full-window drop indicator shown while files are dragged over the app. */
  .dropzone { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center;
    pointer-events: none; background: rgba(8, 8, 11, 0.55); backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px); }
  .dropcard { display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 34px 46px; border-radius: 18px; color: var(--text);
    border: 2px dashed rgba(191, 109, 58, 0.7); background: rgba(191, 109, 58, 0.08); }
  .dropcard :global(svg) { color: #bf6d3a; }
  .dt { font-size: 15px; font-weight: 650; }
  .df { font-size: 12px; color: var(--text-dim); }
</style>
