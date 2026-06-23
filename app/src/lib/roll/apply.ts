import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** The selectable setting groups, mirroring the per-group apply helpers below.
 *  Shared by the "apply settings" picker dialog and both of its entry points
 *  (clipboard paste + Develop's "apply to whole roll"). */
export type SettingGroup = "toneColor" | "crop" | "base" | "exposure" | "whitePoint";
export type GroupSelection = Record<SettingGroup, boolean>;

/** Render/iteration order for the picker. */
export const ALL_GROUPS: readonly SettingGroup[] = [
  "toneColor", "crop", "base", "exposure", "whitePoint",
];

/** A self-contained source of settings to apply (the active frame, or a clipboard
 *  snapshot). `params` carries every group's fields; `crop` lives in its own store. */
export interface SettingsSnapshot {
  params: InvertParams;
  crop: CropRect | null;
  /** The source's Temp as an offset from its own as-shot neutral (Kelvin). Temp is
   *  shown relative to each image's as-shot baseline, so to make a copied "+1000"
   *  land "+1000" on a target (not shift by the baseline difference) we re-base it:
   *  target.temp = target_as_shot + tempOffset. Undefined → apply temp absolutely. */
  tempOffset?: number;
}

/** Per-image film/calibration fields that are NOT part of the shared "look".
 *  `exposure` is here because Auto-Brightness solves a DISTINCT value per frame;
 *  a deliberate roll-wide exposure is re-applied separately (null-guarded) so it
 *  can't silently flatten those per-image values.
 *  `wb_baseline`/`pz_sh`/`pz_mid`/`pz_hi` are per-image measured gains (seeded
 *  from each frame's as-shot WB analysis) and must not leak to other frames.
 *  (These fields land in InvertParams with the per-zone WB feature; the cast
 *  below keeps this file forward-compatible before that merge.) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EXCLUDE = new Set<keyof InvertParams>([
  "mode", "stock", "base_override", "d_max_override", "hdr", "positive", "exposure",
  ...["wb_baseline", "pz_sh", "pz_mid", "pz_hi"] as any[],
]);

/** The tone/color subset of a params object (everything except EXCLUDE). */
export function toneColorOf(p: InvertParams): Partial<InvertParams> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(p) as (keyof InvertParams)[]) {
    if (!EXCLUDE.has(k)) out[k] = p[k];
  }
  return out as Partial<InvertParams>;
}

/** True when the tone/color subset differs from a fresh default. */
export function hasToneColorEdits(p: InvertParams): boolean {
  return JSON.stringify(toneColorOf(p)) !== JSON.stringify(toneColorOf(defaultParams()));
}

const entry = (edits: Record<string, InvertParams>, id: string): InvertParams =>
  edits[id] ?? defaultParams();

export function framesWithToneColor(edits: Record<string, InvertParams>, ids: string[]): string[] {
  return ids.filter((id) => edits[id] && hasToneColorEdits(edits[id]));
}

export function applyToneColorToAll(
  edits: Record<string, InvertParams>, ids: string[], src: InvertParams,
): Record<string, InvertParams> {
  const next = { ...edits };
  const tc = clone(toneColorOf(src));
  for (const id of ids) next[id] = { ...entry(edits, id), ...clone(tc) };
  return next;
}

export function framesWithCrop(crops: Record<string, CropRect | null>, ids: string[]): string[] {
  return ids.filter((id) => crops[id] != null);
}

export function applyCropToAll(
  crops: Record<string, CropRect | null>, ids: string[], crop: CropRect | null,
): Record<string, CropRect | null> {
  const next = { ...crops };
  for (const id of ids) next[id] = crop ? clone(crop) : null;
  return next;
}

export function framesWithBase(edits: Record<string, InvertParams>, ids: string[]): string[] {
  return ids.filter((id) => edits[id]?.base_override != null);
}

export function applyBaseToAll(
  edits: Record<string, InvertParams>, ids: string[], base: [number, number, number] | null,
): Record<string, InvertParams> {
  const next = { ...edits };
  for (const id of ids) next[id] = { ...entry(edits, id), base_override: base ? [...base] : null };
  return next;
}

/** Apply ONE shared exposure to every frame — used only when the user deliberately
 *  sets a roll-wide exposure (else each frame keeps its own, e.g. Auto-Brightness). */
export function applyExposureToAll(
  edits: Record<string, InvertParams>, ids: string[], exposure: number,
): Record<string, InvertParams> {
  const next = { ...edits };
  for (const id of ids) next[id] = { ...entry(edits, id), exposure };
  return next;
}

export function framesWithWhitePoint(edits: Record<string, InvertParams>, ids: string[]): string[] {
  return ids.filter((id) => edits[id]?.d_max_override != null);
}

export function applyWhitePointToAll(
  edits: Record<string, InvertParams>, ids: string[], dmax: number | null,
): Record<string, InvertParams> {
  const next = { ...edits };
  for (const id of ids) next[id] = { ...entry(edits, id), d_max_override: dmax };
  return next;
}
