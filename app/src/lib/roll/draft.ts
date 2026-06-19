import { writable, type Writable } from "svelte/store";
import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";

/** The roll-wide draft: one set of params (tone/color/wb + base_override +
 * d_max_override) plus a crop geometry. Changes are live-mirrored to every frame
 * as you edit — there is no "Apply" button; mirroring is continuous and immediate. */
export interface RollDraft {
  params: InvertParams;
  crop: CropRect | null;
}

export const rollDraft: Writable<RollDraft> = writable({ params: defaultParams(), crop: null });

/** True once the user has actually touched a control (slider, crop, base, wp).
 * False on fresh entry / after resetRollDraft(). The preview + persist passes
 * are inert while this is false, so re-entering Develop never reverts the
 * per-frame look or crop. */
export const rollDraftTouched: Writable<boolean> = writable(false);

/** Id of the frame open in the full-screen overlay (reference frame / preview).
 * null = the contact-sheet grid is showing. */
export const rollReferenceId: Writable<string | null> = writable<string | null>(null);

/** Reset the draft to a fresh default look (called on entering Develop). */
export function resetRollDraft(): void {
  rollDraft.set({ params: defaultParams(), crop: null });
  rollDraftTouched.set(false);
}
