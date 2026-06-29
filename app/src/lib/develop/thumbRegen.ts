// View-independent thumbnail-regeneration worker. `thumb_stale` is the single
// "needs rebake" flag (engine-version bump OR look change); edits mark frames stale
// and this worker bakes them in the background, regardless of which tab is mounted.
// Replaces Grid.svelte's local regenStale/sweepStale and copySettings' regenAppliedThumbs.

import { get } from "svelte/store";
import { images, editsById, cropById, dustById } from "../store";
import { api, defaultParams, type ImageEntry } from "../api";
import { withEffectiveBase } from "./base";
import { applyAsShotWb } from "./wb";
import { imageDir } from "../library/folderScope";
import { gridThumbView, GRID_STATIC_EDGE } from "../library/gridHiRes";

const POOL = 3;
const inFlight = new Set<string>();
let pumping = false;

/** Rebake one developed frame's catalog thumbnail and clear its thumb_stale flag.
 *  Reuses saved edits if present, else the develop-time auto-WB seed (matching the
 *  look the frame opens with). saveThumbnail stamps the current engine version. */
export async function regenOne(img: ImageEntry): Promise<void> {
  if (!img.developed || inFlight.has(img.id)) return;
  inFlight.add(img.id);
  try {
    // Ensure the decoded working buffer is resident (rehydrates from the .oecache
    // sidecar if it was evicted). Cheap when already cached.
    await api.ensureDeveloped(img.id);
    const dir = imageDir(img);
    const saved = get(editsById)[img.id];
    let params;
    if (saved) {
      params = withEffectiveBase(saved, dir);
    } else {
      const seed = withEffectiveBase({ ...defaultParams(), positive: img.positive }, dir);
      const wb = await api.asShotWb(img.id, seed, null, { rot90: 0, flip_h: false, flip_v: false, angle: 0 });
      params = applyAsShotWb(seed, wb);
      try {
        const pz = await api.perZoneWb(img.id, params, null, { rot90: 0, flip_h: false, flip_v: false, angle: 0 });
        params = { ...params, pz_sh: pz.sh, pz_mid: pz.mid, pz_hi: pz.hi };
      } catch { /* keep identity pz on failure */ }
    }
    const view = gridThumbView(get(cropById)[img.id], get(dustById)[img.id], GRID_STATIC_EDGE);
    const url = await api.thumbnail(img.id, params, view);
    await api.saveThumbnail(img.id, url);
    images.update((list) =>
      list.map((i) => (i.id === img.id ? { ...i, thumbnail: url, thumb_stale: false } : i)));
  } catch (e) {
    // Leave thumb_stale set so the frame is retried on the next pump / next session.
    console.warn(`thumbRegen: regenOne failed for ${img.id}`, e);
  } finally {
    inFlight.delete(img.id);
  }
}

/** Drain every developed+stale frame with bounded concurrency. Singleton: a second
 *  call while running is a no-op; marks added mid-drain are picked up by the re-read. */
export function pump(): void {
  if (pumping) return;
  pumping = true;
  const worker = async () => {
    for (;;) {
      const next = get(images).find((i) => i.developed && i.thumb_stale && !inFlight.has(i.id));
      if (!next) return;
      await regenOne(next);
    }
  };
  void Promise.all(Array.from({ length: POOL }, worker)).finally(() => { pumping = false; });
}

/** Mark frames as needing a rebake (look change) and kick the worker. When persist,
 *  also invalidate the DB thumb_version so the mark survives a crash mid-regen. */
export function markThumbsStale(ids: string[], opts: { persist?: boolean } = {}): void {
  if (!ids.length) return;
  const set = new Set(ids);
  images.update((list) =>
    list.map((i) => (set.has(i.id) && i.developed ? { ...i, thumb_stale: true } : i)));
  if (opts.persist) api.invalidateThumbnails(ids).catch(() => { /* best-effort durability */ });
  pump();
}

let swept = false;
/** Once-per-session initial sweep, kicked after the catalog loads — rebakes every
 *  developed+stale thumbnail (e.g. after an ENGINE_VERSION bump). */
export function startThumbRegen(): void {
  if (swept) return;
  swept = true;
  pump();
}
