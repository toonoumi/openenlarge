import type { InvertParams, MetaOverride } from "../api";
import type { CropRect } from "../crop/types";
import type { DustEdits } from "./dust";

/** A point-in-time snapshot of one image's complete editable state. */
export interface EditSnapshot {
  params: InvertParams;
  crop: CropRect | null;
  dust: DustEdits;
  meta: MetaOverride;
}

/** Undo/redo stacks for a single image. `present` is the live committed state. */
export interface ImageHistory {
  past: EditSnapshot[];     // states before present (undo targets, oldest first)
  future: EditSnapshot[];   // states undone (redo targets, next-redo first)
  present: EditSnapshot;
}

/** Max undo steps kept per image (in-memory only). */
export const HISTORY_CAP = 50;

/** Value equality for snapshots. Snapshots are plain JSON-safe data. */
// Assumes snapshot fields are present-with-value or absent — never explicitly `undefined`
// (so JSON.stringify equality is faithful for the optional MetaOverride fields).
export function snapEqual(a: EditSnapshot, b: EditSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function seeded(present: EditSnapshot): ImageHistory {
  return { past: [], future: [], present };
}

/** Record `snap` as the new present. No-op (returns same ref) if unchanged. */
export function pushed(h: ImageHistory, snap: EditSnapshot, cap = HISTORY_CAP): ImageHistory {
  if (snapEqual(snap, h.present)) return h;
  let past = [...h.past, h.present];
  if (past.length > cap) past = past.slice(past.length - cap);
  return { past, future: [], present: snap };
}

/** Step back. `snapshot` is the state to apply, or null if nothing to undo. */
export function undone(h: ImageHistory): { history: ImageHistory; snapshot: EditSnapshot | null } {
  if (h.past.length === 0) return { history: h, snapshot: null };
  const present = h.past[h.past.length - 1];
  return {
    history: { past: h.past.slice(0, -1), future: [h.present, ...h.future], present },
    snapshot: present,
  };
}

/** Step forward. `snapshot` is the state to apply, or null if nothing to redo. */
export function redone(h: ImageHistory): { history: ImageHistory; snapshot: EditSnapshot | null } {
  if (h.future.length === 0) return { history: h, snapshot: null };
  const present = h.future[0];
  return {
    history: { past: [...h.past, h.present], future: h.future.slice(1), present },
    snapshot: present,
  };
}

/** Per-field i18n label keys for the standalone Basic sliders. */
const PARAM_LABELS: Record<string, string> = {
  exposure: "basic.exposure",
  brightness: "basic.brightness",
  contrast: "basic.contrast",
  highlights: "basic.highlights",
  shadows: "basic.shadows",
  whites: "basic.whites",
  blacks: "basic.blacks",
  texture: "basic.texture",
  vibrance: "basic.vibrance",
  saturation: "basic.saturation",
};

/** i18n label key for a changed param field, collapsing related params (WB,
 *  film profile, each color panel) onto one panel-level label. */
function paramLabelKey(field: string): string {
  if (field === "temp" || field === "tint" || field === "auto_wb" || field === "wb_manual")
    return "basic.whiteBalance";
  if (field === "black" || field === "gamma") return "basic.tone";
  if (field === "stock" || field === "mode" || field === "base_override" || field === "d_max_override")
    return "basic.filmProfile";
  if (field === "hdr") return "basic.hdr";
  if (field === "positive") return "label.positive";
  if (field.startsWith("tc_")) return "curve.title";
  if (field.startsWith("cg_")) return "colorGrading.title";
  if (field.startsWith("cm_")) return "colorMixer.title";
  if (field.startsWith("pc_")) return "colorMixer.tab.point";
  return PARAM_LABELS[field] ?? "label.edit";
}

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * i18n key naming the control that differs between two snapshots, for an
 * undo/redo toast. Collapses related params onto one panel label, so e.g. an
 * auto-WB step (temp+tint+auto_wb) reads as "White Balance". Returns
 * "label.multiple" when several distinct controls changed at once, or
 * "label.edit" as a generic fallback when nothing meaningful differs.
 */
export function changeLabel(a: EditSnapshot, b: EditSnapshot): string {
  const keys = new Set<string>();
  if (!jsonEqual(a.crop, b.crop)) keys.add("crop.title");
  if (!jsonEqual(a.dust, b.dust)) keys.add("label.dustRemoval");
  if (!jsonEqual(a.meta, b.meta)) keys.add("label.metadata");
  const pa = (a.params ?? {}) as unknown as Record<string, unknown>;
  const pb = (b.params ?? {}) as unknown as Record<string, unknown>;
  for (const field of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    if (!jsonEqual(pa[field], pb[field])) keys.add(paramLabelKey(field));
  }
  if (keys.size === 0) return "label.edit";
  if (keys.size === 1) return [...keys][0];
  return "label.multiple";
}

export const canUndo = (h: ImageHistory): boolean => h.past.length > 0;
export const canRedo = (h: ImageHistory): boolean => h.future.length > 0;

export type UndoRedo = "undo" | "redo" | null;

/** Classify a keyboard event: ⌘Z/Ctrl+Z = undo, ⌘⇧Z/Ctrl+⇧Z/Ctrl+Y = redo. */
export function matchUndoRedo(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
): UndoRedo {
  if (!e.metaKey && !e.ctrlKey) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && e.ctrlKey) return "redo";
  return null;
}
