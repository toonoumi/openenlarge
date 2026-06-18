import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Per-image film/calibration fields that are NOT part of the shared "look". */
const EXCLUDE = new Set<keyof InvertParams>([
  "mode", "stock", "base_override", "d_max_override", "hdr", "positive",
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
