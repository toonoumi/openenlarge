import { derived } from "svelte/store";
import type { InvertParams } from "../api";
import type { ParamsStore } from "../perImage";
import { rollDraft, rollDraftTouched } from "./draft";

/** A ParamsStore view over rollDraft.params, so the editing panels (which take a
 * ParamsStore) can drive the roll draft. Each write stores a fresh params object
 * and marks the draft as touched so the preview+persist passes activate. */
export function draftParamsStore(): ParamsStore {
  const view = derived(rollDraft, (d) => d.params);
  return {
    subscribe: view.subscribe,
    set: (p: InvertParams) => {
      rollDraft.update((d) => ({ ...d, params: { ...p } }));
      rollDraftTouched.set(true);
    },
    update: (fn) => {
      rollDraft.update((d) => ({ ...d, params: { ...fn(d.params) } }));
      rollDraftTouched.set(true);
    },
  };
}
