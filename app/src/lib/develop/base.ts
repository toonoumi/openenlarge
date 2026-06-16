import { get } from "svelte/store";
import { folderBaseByPath, folderDmaxByPath } from "../store";
import { api, type InvertParams } from "../api";

/** Resolve the effective base + D_max for a frame and inject them into a throwaway
 * params object: per-image override -> folder default -> null (backend falls back).
 * Never mutates the persisted per-image base_override / d_max_override. */
export function withEffectiveBase(params: InvertParams, dir: string): InvertParams {
  const base = params.base_override ?? get(folderBaseByPath)[dir] ?? null;
  const dMax = params.d_max_override ?? get(folderDmaxByPath)[dir] ?? null;
  return { ...params, base_override: base, d_max_override: dMax };
}

/** Set the roll/folder default and persist it via app_state. */
export function setFolderBase(dir: string, base: [number, number, number]): void {
  folderBaseByPath.update((m) => ({ ...m, [dir]: base }));
  api.saveAppState(`folder_base:${dir}`, JSON.stringify(base)).catch(() => {});
}

/** Clear the roll/folder default (persists an empty string = removed). */
export function clearFolderBase(dir: string): void {
  folderBaseByPath.update((m) => { const n = { ...m }; delete n[dir]; return n; });
  api.saveAppState(`folder_base:${dir}`, "").catch(() => {});
}

/** Set the roll/folder default D_max and persist it via app_state. */
export function setFolderDmax(dir: string, dMax: number): void {
  folderDmaxByPath.update((m) => ({ ...m, [dir]: dMax }));
  api.saveAppState(`folder_dmax:${dir}`, JSON.stringify(dMax)).catch(() => {});
}

/** Clear the roll/folder default D_max (persists an empty string = removed). */
export function clearFolderDmax(dir: string): void {
  folderDmaxByPath.update((m) => { const n = { ...m }; delete n[dir]; return n; });
  api.saveAppState(`folder_dmax:${dir}`, "").catch(() => {});
}
