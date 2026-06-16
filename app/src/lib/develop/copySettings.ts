// Copy/paste of tone & color develop settings between images (⌘/Ctrl+C / +V).
// Film profile and per-image calibration never travel; geometry, eraser/dust and
// AI-enhance live in other stores and are untouched.

import { get } from "svelte/store";
import {
  activeId, editsById, settingsClipboard, applySettingsTarget, deleteSelectionIds,
} from "../store";
import { defaultParams, type InvertParams } from "../api";
import { commitActive } from "./historyStore";
import { showToast } from "../toast";
import { translate } from "../i18n";

/** Per-image film/calibration fields that must NOT be cloned between images. */
const EXCLUDE = new Set<keyof InvertParams>([
  "mode", "stock", "base_override", "d_max_override", "hdr",
]);

/** The tone/color subset of a params object (everything except EXCLUDE). */
function toneColorOf(p: InvertParams): Partial<InvertParams> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(p) as (keyof InvertParams)[]) {
    if (!EXCLUDE.has(k)) out[k] = p[k];
  }
  return out as Partial<InvertParams>;
}

/** Detach from live store objects so later edits can't mutate the snapshot. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Copy the active image's tone/color settings to the in-app clipboard. */
export function copyDevelopSettings(): void {
  const id = get(activeId);
  if (!id) return;
  const cur = get(editsById)[id] ?? defaultParams();
  settingsClipboard.set(clone(toneColorOf(cur)));
  showToast(translate("toast.settingsCopied"));
}

/** Paste the clipboard onto the selection (or the active image when nothing is
 *  multi-selected). More than one target shows a confirm dialog first. */
export function pasteDevelopSettings(): void {
  if (!get(settingsClipboard)) { showToast(translate("toast.copyFirst")); return; }
  const ids = deleteSelectionIds();
  if (!ids.length) return;
  if (ids.length === 1) applyClipboardTo(ids);
  else applySettingsTarget.set(ids); // open ConfirmApplySettings
}

/** Merge the clipboard's tone/color fields onto each target image, preserving
 *  each target's own film profile/calibration. */
export function applyClipboardTo(ids: string[]): void {
  const clip = get(settingsClipboard);
  if (!clip || !ids.length) return;
  const active = get(activeId);
  editsById.update((m) => {
    const next = { ...m };
    for (const id of ids) {
      const base = next[id] ?? defaultParams();
      // Clone per target so nested arrays (curves) aren't shared across images.
      next[id] = { ...base, ...clone(clip) };
    }
    return next;
  });
  // The active image gets a real undo step; background targets re-baseline the
  // pasted state the next time they're opened.
  if (active && ids.includes(active)) commitActive();
  const n = ids.length;
  showToast(n === 1
    ? translate("toast.settingsApplied")
    : translate("toast.settingsAppliedN", { count: n }));
}
