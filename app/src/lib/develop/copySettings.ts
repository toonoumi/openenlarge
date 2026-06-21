// Copy/paste of develop settings between images (⌘/Ctrl+C / +V) and the shared
// "apply selected settings" routine reused by Develop's "apply to whole roll".
// Copy grabs a full snapshot of the source frame; the paste/roll dialog picks
// which groups (tone/color, crop, film base, exposure, white point) travel.

import { get } from "svelte/store";
import {
  activeId, editsById, cropById, settingsClipboard, applySettingsTarget,
  deleteSelectionIds, invalidatePreview,
} from "../store";
import { defaultParams } from "../api";
import {
  applyToneColorToAll, applyCropToAll, applyBaseToAll,
  applyExposureToAll, applyWhitePointToAll,
  type GroupSelection, type SettingsSnapshot,
} from "../roll/apply";
import { commitActive } from "./historyStore";
import { showToast } from "../toast";
import { translate } from "../i18n";

/** Detach from live store objects so later edits can't mutate the snapshot. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Default picker state for a paste: only the tone/color look travels (the
 *  historical behavior); the other groups are opt-in via the dialog. */
export const PASTE_DEFAULT_GROUPS: GroupSelection = {
  toneColor: true, crop: false, base: false, exposure: false, whitePoint: false,
};

/** Copy the active image's settings to the in-app clipboard (full snapshot). */
export function copyDevelopSettings(): void {
  const id = get(activeId);
  if (!id) return;
  const cur = get(editsById)[id] ?? defaultParams();
  const crop = get(cropById)[id] ?? null;
  settingsClipboard.set({ params: clone(cur), crop: clone(crop) });
  showToast(translate("toast.settingsCopied"));
}

/** Paste the clipboard onto the selection (or the active image when nothing is
 *  multi-selected). More than one target shows the picker dialog first. */
export function pasteDevelopSettings(): void {
  if (!get(settingsClipboard)) { showToast(translate("toast.copyFirst")); return; }
  const ids = deleteSelectionIds();
  if (!ids.length) return;
  applySettingsTarget.set(ids); // open the picker dialog (single or multi target)
}

/** Merge the selected groups of a source snapshot onto every target, preserving
 *  each target's other settings. Used by both paste and apply-to-whole-roll. */
export function applySelectedTo(
  ids: string[], src: SettingsSnapshot, groups: GroupSelection,
): void {
  if (!ids.length) return;
  const active = get(activeId);
  let nextEdits = get(editsById);
  if (groups.toneColor)  nextEdits = applyToneColorToAll(nextEdits, ids, src.params);
  if (groups.base)       nextEdits = applyBaseToAll(nextEdits, ids, src.params.base_override);
  if (groups.whitePoint) nextEdits = applyWhitePointToAll(nextEdits, ids, src.params.d_max_override);
  if (groups.exposure)   nextEdits = applyExposureToAll(nextEdits, ids, src.params.exposure);
  editsById.set(nextEdits);
  if (groups.crop) cropById.set(applyCropToAll(get(cropById), ids, src.crop));

  // The active image gets a real undo step; background targets re-baseline the
  // applied state the next time they're opened.
  if (active && ids.includes(active)) commitActive();
  // Drop any cached previews for the touched images so the new look isn't shown
  // stale on the next click (the active image re-caches as the canvas redraws).
  for (const id of ids) invalidatePreview(id);
  const n = ids.length;
  showToast(n === 1
    ? translate("toast.settingsApplied")
    : translate("toast.settingsAppliedN", { count: n }));
}

/** Apply the clipboard's selected groups onto each target image. */
export function applyClipboardTo(
  ids: string[], groups: GroupSelection = PASTE_DEFAULT_GROUPS,
): void {
  const clip = get(settingsClipboard);
  if (!clip || !ids.length) return;
  applySelectedTo(ids, clip, groups);
}
