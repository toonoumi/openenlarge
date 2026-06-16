<script lang="ts">
  import FolderNav from "../library/FolderNav.svelte";
  import Grid from "../library/Grid.svelte";
  import Metadata from "../panels/Metadata.svelte";
  import Filmstrip from "../panels/Filmstrip.svelte";
  import ImageContextMenu from "../overlay/ImageContextMenu.svelte";
  import { activeId, images, folderImages, deleteTarget, selectAll, deleteSelectionIds, setActive } from "../store";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";

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
</style>
