import { get, derived } from "svelte/store";
import type { ImageEntry } from "../api";
import { api } from "../api";
import { setFolderBase } from "../develop/base";
import { folderBaseByPath, editsById, selectedFolder, folderImages, developProgress } from "../store";
import { seedFrame } from "../workflow";

/** A frame is protected from a roll-base reseed if the user set its base explicitly
 * (base_override) or picked its WB by hand (wb_manual). */
function isProtected(id: string): boolean {
  const e = get(editsById)[id];
  return !!e && (e.base_override != null || e.wb_manual === true);
}

/** Reseed every protected-free developed frame against the current effective base,
 * WB-only (keep each frame's existing exposure — only the base changed). */
export async function reseedRollProtectedFree(imgs: ImageEntry[]): Promise<void> {
  for (const img of imgs) {
    if (!img.developed || isProtected(img.id)) continue;
    await seedFrame(img.id, img, false);
  }
}

/** One-time migration for an existing roll: if the folder has no stored base yet,
 * compute the roll base, set it, and reseed protected-free frames. A folder that
 * already has a base (auto or manual) is left untouched, so this never recomputes. */
export async function ensureRollBase(dir: string, imgs: ImageEntry[]): Promise<void> {
  if (get(folderBaseByPath)[dir]) return;
  const developed = imgs.filter((i) => i.developed);
  if (developed.length === 0) return;
  let rb: { base: [number, number, number]; frames_used: number } | null = null;
  try { rb = await api.rollBase(developed.map((i) => i.id)); } catch { return; }
  if (!rb) return; // rebate-less roll → keep per-image auto fallback
  setFolderBase(dir, rb.base);
  await reseedRollProtectedFree(developed);
}

/** Wire the migration to fire once per folder on entry (mirrors previewPrefetch's
 * module-level subscription). Guards: skip while a develop pass is active (developAll
 * owns the base then), skip folders already based, and run once per dir. */
export function initRollBaseMigration(): void {
  let lastDir: string | null = null;
  derived([selectedFolder, folderImages], (v) => v).subscribe(([dir, imgs]) => {
    if (!dir || dir === lastDir) return;
    if (get(developProgress).active) return;            // developAll is handling it
    if (get(folderBaseByPath)[dir]) { lastDir = dir; return; }
    const list = imgs as ImageEntry[];
    if (!list.some((i) => i.developed)) return;          // wait until something is developed
    lastDir = dir;
    void ensureRollBase(dir, list);
  });
}
