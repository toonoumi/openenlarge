import { get } from "svelte/store";
import { folderBaseByPath } from "../store";
import { api, type InvertParams } from "../api";

/** Resolve the effective base for a frame and inject it into a throwaway params
 * object: per-image override -> folder default -> null (backend uses dev.base).
 * Never mutates the persisted per-image base_override. */
export function withEffectiveBase(params: InvertParams, dir: string): InvertParams {
  const base = params.base_override ?? get(folderBaseByPath)[dir] ?? null;
  return { ...params, base_override: base };
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
