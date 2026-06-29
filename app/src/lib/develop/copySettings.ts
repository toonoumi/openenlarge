// Copy/paste of develop settings between images (⌘/Ctrl+C / +V) and the shared
// "apply selected settings" routine reused by Develop's "apply to whole roll".
// Copy opens the picker (tone/color, crop, film base, exposure) and records the
// chosen groups in the clipboard; paste applies exactly those, no second dialog.

import { get } from "svelte/store";
import {
  activeId, editsById, cropById, settingsClipboard, copySettingsOpen,
  deleteSelectionIds, invalidatePreview,
} from "../store";
import { defaultParams } from "../api";
import {
  applyToneColorToAll, applyCropToAll, applyBaseToAll,
  applyExposureToAll,
  type GroupSelection, type SettingsSnapshot,
} from "../roll/apply";
import { commitActive } from "./historyStore";
import { showToast } from "../toast";
import { translate } from "../i18n";
import { markThumbsStale } from "./thumbRegen";

// Phase 1 re-zero: temp=5500 is the universal neutral on every image.
// Each image's actual auto-WB correction lives in the hidden wb_baseline gains
// param, so tempOffset is always relative to this fixed constant — no per-image
// as-shot fetch needed.
const TEMP_NEUTRAL = 5500;

/** Detach from live store objects so later edits can't mutate the snapshot. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Default picker state: only the tone/color look travels; the other groups are
 *  opt-in. Used as the copy dialog's initial state and the paste fallback. */
export const PASTE_DEFAULT_GROUPS: GroupSelection = {
  toneColor: true, crop: false, base: false, exposure: false,
};

/** Copy (⌘C): open the group picker so the user chooses what to carry. The
 *  snapshot is captured on confirm (confirmCopyDevelopSettings). */
export function copyDevelopSettings(): void {
  if (!get(activeId)) return;
  copySettingsOpen.set(true);
}

/** Confirm of the copy picker: snapshot the active frame + the chosen groups into
 *  the clipboard. Paste then applies exactly these groups (no second dialog). */
export function confirmCopyDevelopSettings(groups: GroupSelection): void {
  copySettingsOpen.set(false);
  const id = get(activeId);
  if (!id) return;
  const cur = get(editsById)[id] ?? defaultParams();
  const crop = get(cropById)[id] ?? null;
  // Capture Temp as a signed offset from TEMP_NEUTRAL (5500 K). Since re-zero,
  // cur.temp IS always relative to this fixed neutral — no per-image baseline fetch.
  const tempOffset = cur.temp - TEMP_NEUTRAL;
  settingsClipboard.set({ params: clone(cur), crop: clone(crop), tempOffset, groups: { ...groups } });
  showToast(translate("toast.settingsCopied"));
}

/** Paste (⌘V): apply the copied groups onto the selection (or the active image).
 *  The group choice was made at copy time, so this never opens a dialog. */
export function pasteDevelopSettings(): void {
  const clip = get(settingsClipboard);
  if (!clip) { showToast(translate("toast.copyFirst")); return; }
  const ids = deleteSelectionIds();
  if (!ids.length) return;
  void applySelectedTo(ids, clip, clip.groups ?? PASTE_DEFAULT_GROUPS);
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
  if (groups.exposure)   nextEdits = applyExposureToAll(nextEdits, ids, src.params.exposure);
  // Re-base the copied Temp onto TEMP_NEUTRAL (not a per-image as-shot fetch) so
  // a "+500K warmer" look lands the same relative warmth on every target frame.
  if (groups.toneColor && src.tempOffset != null) {
    for (const id of ids) {
      nextEdits = { ...nextEdits, [id]: { ...nextEdits[id], temp: TEMP_NEUTRAL + src.tempOffset } };
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

  // Mark the applied background frames stale; the shared worker rebakes them (bounded
  // concurrency, persisted, retried). The active frame rebakes via Develop.refreshThumb.
  const others = ids.filter((id) => id !== active);
  if (others.length) markThumbsStale(others, { persist: true });
}
