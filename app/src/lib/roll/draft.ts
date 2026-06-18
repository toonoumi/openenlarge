import { writable, type Writable } from "svelte/store";
import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";

/** The roll-wide draft: one set of params (tone/color/wb + base_override +
 * d_max_override) plus a crop geometry, previewed live across the contact sheet
 * and bulk-written into every frame on "Apply to roll". Non-destructive until applied. */
export interface RollDraft {
  params: InvertParams;
  crop: CropRect | null;
}

export const rollDraft: Writable<RollDraft> = writable({ params: defaultParams(), crop: null });

/** Id of the frame open in the full-screen overlay (reference frame / preview).
 * null = the contact-sheet grid is showing. */
export const rollReferenceId: Writable<string | null> = writable<string | null>(null);

/** Reset the draft to a fresh default look (called on entering Develop). */
export function resetRollDraft(): void {
  rollDraft.set({ params: defaultParams(), crop: null });
}
