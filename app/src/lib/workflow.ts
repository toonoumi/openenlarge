import { get } from "svelte/store";
import { images, activeId, module, developProgress, editsById, cropById, dustById, folderImages, invalidatePreview, undevelopableIds } from "./store";
import { api, defaultParams, type ImageEntry } from "./api";
import { dropHistory, reseedActive } from "./develop/historyStore";
import { track } from "./telemetry";
import { showToast } from "./toast";
import { translate } from "./i18n";
import { developedFolderImages } from "./export/eligible";
import { withEffectiveBase } from "./develop/base";
import { imageDir } from "./library/folderScope";

/** Ids of images not yet developed, in order. Pure helper (testable). */
export function undevelopedIds(list: ImageEntry[]): string[] {
  return list.filter((i) => !i.developed).map((i) => i.id);
}

/**
 * Fold a freshly `ensure_developed`'d entry back into the existing one. Takes the
 * refreshed status/metadata from `updated`, but KEEPS the frontend's live thumbnail.
 *
 * `ensure_developed` always returns the develop-time, DEFAULT-params thumbnail (the
 * backend never sees the user's edits — `refreshThumb` re-renders the edited look on
 * the frontend only). Letting it overwrite the live thumbnail made the filmstrip flash
 * the un-adjusted "base" look for ~400ms on every navigation before refreshThumb caught
 * up. The backend thumbnail is only a fallback for when the frontend has none yet.
 */
export function mergeEnsured(existing: ImageEntry, updated: ImageEntry): ImageEntry {
  return { ...updated, thumbnail: existing.thumbnail || updated.thumbnail };
}

/** Extensions we accept on import (file dialog filter + drag-drop). */
export const IMPORT_EXTENSIONS = [
  "jpg", "jpeg", "png", "dng", "tif", "tiff", "raf", "rw2", "nef", "arw", "cr2", "cr3", "3fr", "orf", "raw",
];

/** Keep only paths whose extension we can import (case-insensitive). */
export function filterImportable(paths: string[]): string[] {
  return paths.filter((p) => {
    const ext = p.split(".").pop()?.toLowerCase();
    return !!ext && IMPORT_EXTENSIONS.includes(ext);
  });
}

/** Extensions cameras emit as embedded previews of a raw/master file. */
const PREVIEW_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);

/** Lowercased "directory/stem" key, so a preview only pairs with a master in the
 *  same folder. Handles Windows separators and multi-dot names. */
function dirStemKey(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const dir = slash >= 0 ? norm.slice(0, slash) : "";
  const file = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return (dir + "/" + stem).toLowerCase();
}

const extOf = (path: string): string => path.split(".").pop()?.toLowerCase() ?? "";

/**
 * Drop jpg/jpeg/png paths that are just camera previews of a raw/master file —
 * i.e. a same-folder, same-base-name non-preview sibling exists in the batch.
 * Standalone jpgs (no raw twin) are kept. Pure + order-preserving.
 */
export function omitPreviewSidecars(paths: string[]): string[] {
  const masters = new Set<string>();
  for (const p of paths) {
    if (!PREVIEW_EXTENSIONS.has(extOf(p))) masters.add(dirStemKey(p));
  }
  return paths.filter((p) => !(PREVIEW_EXTENSIONS.has(extOf(p)) && masters.has(dirStemKey(p))));
}

/** Reduce a raw list of folder file paths to the ones we'll actually import:
 * keep importable extensions, then optionally drop camera preview sidecars.
 * Pure + order-preserving — shared by the folder picker (and testable). */
export function selectImportPaths(paths: string[], omitPreviews: boolean): string[] {
  const importable = filterImportable(paths);
  return omitPreviews ? omitPreviewSidecars(importable) : importable;
}

/** Import each path into the catalog, upserting into `images` and making the
 * first import active if nothing is. Shared by the file dialog and drag-drop. */
export async function importPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      const entry = await api.importImage(path);
      images.update((xs) =>
        xs.some((i) => i.id === entry.id)
          ? xs.map((i) => (i.id === entry.id ? entry : i))
          : [...xs, entry]);
      activeId.update((id) => id ?? entry.id);
    } catch (e) { console.error("import failed", path, e); }
  }
}

/** Resolve after the browser has had a chance to paint (two rAFs). Falls back to a
 * macrotask in non-DOM contexts (tests). */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame === "undefined") return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/** Auto-brightness the WHOLE ROLL: every DEVELOPED image in the folder gets its OWN
 * solved exposure (highlight-preserving filmic lift), applied in one atomic store
 * write with the progress overlay. Per-image values — never a single shared
 * brightness — so it must write editsById directly (the Roll look-mirror would
 * otherwise flatten them, since exposure isn't an excluded field). */
export async function autoBrightnessRoll(): Promise<void> {
  const frames = get(developedFolderImages);
  if (frames.length === 0) return;
  developProgress.set({ active: true, done: 0, total: frames.length });
  await nextPaint();
  const solved: Record<string, number> = {};
  for (const img of frames) {
    try {
      const p = withEffectiveBase(get(editsById)[img.id] ?? defaultParams(), imageDir(img));
      const c = get(cropById)[img.id] ?? null;
      const crop = c
        ? ([c.rect.x, c.rect.y, c.rect.w, c.rect.h] as [number, number, number, number])
        : null;
      const geom = c ? { rot90: c.rot90, flip_h: c.flipH, flip_v: c.flipV, angle: c.angle } : {};
      const { exposure } = await api.autoBrightness(img.id, p, crop, geom);
      solved[img.id] = exposure;
    } catch (e) {
      console.error("auto-brightness failed", img.id, e);
    }
    developProgress.update((s) => ({ ...s, done: s.done + 1 }));
  }
  // One atomic write; each frame keeps its OWN exposure.
  editsById.update((m) => {
    const next = { ...m };
    for (const id of Object.keys(solved)) {
      next[id] = { ...(next[id] ?? defaultParams()), exposure: solved[id] };
    }
    return next;
  });
  for (const img of frames) invalidatePreview(img.id);
  reseedActive(); // fold the active image's new exposure into its per-image undo baseline
  await nextPaint();
  developProgress.set({ active: false, done: frames.length, total: frames.length });
  showToast(translate("toast.autoBrightnessDone", { count: Object.keys(solved).length }));
}

/** Develop every not-yet-developed image IN THE SELECTED FOLDER sequentially,
 * updating progress, then switch to the target module. Resolves when done. */
export async function developAll(target: "develop" | "roll" = "develop"): Promise<void> {
  const ids = undevelopedIds(get(folderImages));
  if (ids.length === 0) { module.set(target); return; }
  developProgress.set({ active: true, done: 0, total: ids.length });
  // Let the overlay paint (and fade in) before kicking off the first develop call.
  await nextPaint();
  // Collect per-image failures so a stuck "undeveloped" frame (which otherwise just
  // leaves a permanent badge with no feedback) surfaces to the user.
  const failures: string[] = [];
  const nameOf = (id: string) => get(images).find((i) => i.id === id)?.file_name ?? id;
  for (const id of ids) {
    let ok = false;
    try {
      const updated = await api.developImage(id);
      images.update((list) => list.map((i) => (i.id === id ? updated : i)));
      // First-develop seed: adopt the classifier's verdict AND the auto white balance
      // only when the image has no stored edits yet (re-develop / existing manual
      // overrides are untouched). The frame is resident right after developing, so
      // as_shot_wb is cheap here — seeding it for every frame means the WHOLE roll
      // opens in Develop already balanced, instead of each frame rendering on neutral
      // WB (a blue cast) until it's individually activated and its own seed runs.
      if (!get(editsById)[id]) {
        const seed = { ...defaultParams(), positive: updated.positive };
        try {
          const wb = await api.asShotWb(id, withEffectiveBase(seed, imageDir(updated)));
          seed.temp = wb.temp;
          seed.tint = wb.tint;
        } catch { /* not resident yet — Develop's per-image seed retries on activation */ }
        // Seed exposure ONCE here too (the frame is resident, so auto_brightness is cheap),
        // measured on the WB-seeded look — so the whole roll opens correctly exposed in
        // Develop/Roll/Tune without each frame needing to be individually activated. Persists
        // via editsById; never re-runs (later entries see a non-default exposure and skip).
        try {
          const { exposure } = await api.autoBrightness(id, withEffectiveBase(seed, imageDir(updated)));
          seed.exposure = exposure;
        } catch { /* not resident yet — the per-image / folder seed retries on activation */ }
        editsById.update((m) => (m[id] ? m : { ...m, [id]: seed }));
      }
      if (updated.developed) {
        ok = true;
      } else {
        // Developed without throwing but still not flagged developed → a different bug
        // (e.g. the backend couldn't write/confirm the cache). Surface it too.
        failures.push(`${nameOf(id)}: develop returned but not marked developed`);
        console.error("develop returned developed=false", id, nameOf(id));
      }
    } catch (e) {
      failures.push(`${nameOf(id)}: ${e}`);
      console.error("develop failed", id, nameOf(id), e);
    }
    // Track undevelopable frames so a corrupt/undecodable file stops pinning the
    // badge: mark on failure, clear on success (so a fixed/replaced file recovers).
    undevelopableIds.update((s) => {
      const has = s.has(id);
      if (ok && has) { const n = new Set(s); n.delete(id); return n; }
      if (!ok && !has) { const n = new Set(s); n.add(id); return n; }
      return s;
    });
    developProgress.update((p) => ({ ...p, done: p.done + 1 }));
  }
  if (failures.length > 0) {
    showToast(translate("toast.developFailed", { count: failures.length, detail: failures[0] }), 8000);
  }
  if (!get(activeId)) {
    const first = get(folderImages)[0];
    if (first) activeId.set(first.id);
  }
  track("images_developed", { count: ids.length });
  module.set(target);
  // Keep the overlay up while the (heavy) Develop view mounts, then fade it out on
  // a free main thread so the dismiss animates instead of snapping.
  await nextPaint();
  developProgress.set({ active: false, done: ids.length, total: ids.length });
}


/**
 * Delete an image: forget it in the backend (optionally trashing the file), then
 * drop it from every per-image store. If it was the active image, select the next
 * neighbour (or the previous one if it was last). Falls back to Library when empty.
 */
export async function deleteImage(id: string, deleteFile: boolean): Promise<void> {
  const list = get(images);
  const idx = list.findIndex((i) => i.id === id);
  if (idx < 0) return;
  try {
    await api.deleteImage(id, deleteFile);
  } catch (e) {
    console.error("delete failed", id, e);
    return; // leave app state untouched if the backend/trash step failed
  }
  const wasActive = get(activeId) === id;
  const neighbour = list[idx + 1] ?? list[idx - 1] ?? null;

  images.update((xs) => xs.filter((i) => i.id !== id));
  const drop = <T,>(m: Record<string, T>): Record<string, T> => {
    const n = { ...m }; delete n[id]; return n;
  };
  editsById.update(drop);
  cropById.update(drop);
  dustById.update(drop);
  dropHistory(id);
  invalidatePreview(id);

  if (wasActive) activeId.set(neighbour ? neighbour.id : null);
  if (get(images).length === 0) module.set("library");
}
