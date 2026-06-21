// Copy/paste of develop settings between images (⌘/Ctrl+C / +V) and the shared
// "apply selected settings" routine reused by Develop's "apply to whole roll".
// Copy grabs a full snapshot of the source frame; the paste/roll dialog picks
// which groups (tone/color, crop, film base, exposure, white point) travel.

import { get } from "svelte/store";
import {
  activeId, editsById, cropById, images, settingsClipboard, applySettingsTarget,
  deleteSelectionIds, invalidatePreview,
} from "../store";
import { api, defaultParams } from "../api";
import {
  applyToneColorToAll, applyCropToAll, applyBaseToAll,
  applyExposureToAll, applyWhitePointToAll,
  type GroupSelection, type SettingsSnapshot,
} from "../roll/apply";
import { withEffectiveBase } from "./base";
import { imageDir } from "../library/folderScope";
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

/** A frame's as-shot neutral Temp (Kelvin) — the baseline the Temp slider is shown
 *  relative to. Crop/orient-aware to match Basic.svelte's readout. null on failure. */
async function asShotTemp(id: string): Promise<number | null> {
  const img = get(images).find((i) => i.id === id);
  if (!img) return null;
  const p = get(editsById)[id] ?? defaultParams();
  const c = get(cropById)[id] ?? null;
  const crop = c
    ? ([c.rect.x, c.rect.y, c.rect.w, c.rect.h] as [number, number, number, number])
    : null;
  const geom = c ? { rot90: c.rot90, flip_h: c.flipH, flip_v: c.flipV, angle: c.angle } : {};
  try {
    const wb = await api.asShotWb(id, withEffectiveBase(p, imageDir(img)), crop, geom);
    return wb.temp;
  } catch {
    return null;
  }
}

/** Copy the active image's settings to the in-app clipboard (full snapshot). */
export async function copyDevelopSettings(): Promise<void> {
  const id = get(activeId);
  if (!id) return;
  const cur = get(editsById)[id] ?? defaultParams();
  const crop = get(cropById)[id] ?? null;
  // Capture Temp as an offset from the source's as-shot neutral, so a pasted "+1000"
  // lands "+1000" on a target with a different baseline (see SettingsSnapshot.tempOffset).
  const baseline = await asShotTemp(id);
  const tempOffset = baseline != null ? cur.temp - baseline : undefined;
  settingsClipboard.set({ params: clone(cur), crop: clone(crop), tempOffset });
  showToast(translate("toast.settingsCopied"));
}

/** Paste the clipboard onto the selection (or the active image when nothing is
 *  multi-selected). More than one target shows the picker dialog first. */
export function pasteDevelopSettings(): void {
  if (!get(settingsClipboard)) { showToast(translate("toast.copyFirst")); return; }
  const ids = deleteSelectionIds();
  if (!ids.length) return;
  if (ids.length === 1) void applyClipboardTo(ids);
  else applySettingsTarget.set(ids); // open ConfirmApplySettings
}

/** Merge the selected groups of a source snapshot onto every target, preserving
 *  each target's other settings. Used by both paste and apply-to-whole-roll. */
export async function applySelectedTo(
  ids: string[], src: SettingsSnapshot, groups: GroupSelection,
): Promise<void> {
  if (!ids.length) return;
  const active = get(activeId);
  let nextEdits = get(editsById);
  if (groups.toneColor)  nextEdits = applyToneColorToAll(nextEdits, ids, src.params);
  if (groups.base)       nextEdits = applyBaseToAll(nextEdits, ids, src.params.base_override);
  if (groups.whitePoint) nextEdits = applyWhitePointToAll(nextEdits, ids, src.params.d_max_override);
  if (groups.exposure)   nextEdits = applyExposureToAll(nextEdits, ids, src.params.exposure);
  // Re-base the copied Temp onto each target's own as-shot neutral so the relative
  // offset (not the absolute Kelvin) is what carries over. Temp is the only param
  // shown relative to a per-image baseline, so it's the only one re-based here.
  if (groups.toneColor && src.tempOffset != null) {
    for (const id of ids) {
      const tb = await asShotTemp(id);
      if (tb != null) nextEdits = { ...nextEdits, [id]: { ...nextEdits[id], temp: tb + src.tempOffset } };
    }
  }
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
export async function applyClipboardTo(
  ids: string[], groups: GroupSelection = PASTE_DEFAULT_GROUPS,
): Promise<void> {
  const clip = get(settingsClipboard);
  if (!clip || !ids.length) return;
  await applySelectedTo(ids, clip, groups);
}
