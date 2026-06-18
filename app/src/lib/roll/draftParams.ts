import { derived, get } from "svelte/store";
import type { InvertParams } from "../api";
import type { ParamsStore } from "../perImage";
import { rollDraft } from "./draft";

/** A ParamsStore view over rollDraft.params, so the editing panels (which take a
 * ParamsStore) can drive the roll draft. Each write stores a fresh params object. */
export function draftParamsStore(): ParamsStore {
  const view = derived(rollDraft, (d) => d.params);
  return {
    subscribe: view.subscribe,
    set: (p: InvertParams) => rollDraft.update((d) => ({ ...d, params: { ...p } })),
    update: (fn) => rollDraft.update((d) => ({ ...d, params: { ...fn(get(rollDraft).params) } })),
  };
}
