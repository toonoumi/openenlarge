/** A point normalized to the displayed image ([0,1] in both axes). */
export interface DustPoint { x: number; y: number }
/** A brush stroke: a polyline + radius normalized to the displayed image WIDTH. */
export interface DustStroke { points: DustPoint[]; r: number }
/** IR-driven automatic dust removal settings. */
export interface IrRemoval { enabled: boolean; sensitivity: number }
/** AI (learned-model) auto dust/hair removal settings. */
export interface AutoDust { enabled: boolean; sensitivity: number }
/** Per-image dust edit state.
 * `brushMigan` = AI-fill mode: strokes are NOT healed live (shown as a mask
 * overlay); a single "AI erase" sets `aiApplied` to bake the MI-GAN heal.
 * Any new/removed stroke clears `aiApplied` so the new mask must be re-applied. */
export interface DustEdits {
  strokes: DustStroke[];
  irRemoval: IrRemoval;
  autoDust: AutoDust;
  brushMigan: boolean;
  aiApplied: boolean;
  /** Normalized seed points for global auto-dust spots the user chose to KEEP. */
  autoDustExclusions: DustPoint[];
  /** Show eraser-icon markers over heal locations in the viewport. */
  showSpots: boolean;
}

export const emptyDust = (): DustEdits => ({
  strokes: [],
  irRemoval: { enabled: false, sensitivity: 50 },
  autoDust: { enabled: false, sensitivity: 50 },
  brushMigan: false,
  aiApplied: false,
  autoDustExclusions: [],
  showSpots: true,
});

export function addStroke(d: DustEdits, s: DustStroke): DustEdits {
  return { ...d, strokes: [...d.strokes, s], aiApplied: false };
}
export function undoStroke(d: DustEdits): DustEdits {
  return { ...d, strokes: d.strokes.slice(0, -1), aiApplied: false };
}
export function resetDust(d: DustEdits): DustEdits {
  return { ...d, strokes: [], aiApplied: false };
}
export function setIrEnabled(d: DustEdits, enabled: boolean): DustEdits {
  return { ...d, irRemoval: { ...d.irRemoval, enabled } };
}
export function setIrSensitivity(d: DustEdits, sensitivity: number): DustEdits {
  return { ...d, irRemoval: { ...d.irRemoval, sensitivity } };
}
export function setAutoDustEnabled(d: DustEdits, enabled: boolean): DustEdits {
  return { ...d, autoDust: { ...d.autoDust, enabled } };
}
export function setAutoDustSensitivity(d: DustEdits, sensitivity: number): DustEdits {
  return { ...d, autoDust: { ...d.autoDust, sensitivity } };
}
export function setBrushMigan(d: DustEdits, brushMigan: boolean): DustEdits {
  return { ...d, brushMigan, aiApplied: false };
}
export function setAiApplied(d: DustEdits, aiApplied: boolean): DustEdits {
  return { ...d, aiApplied };
}

/** Centroid (normalized) of a stroke's polyline — the eraser-marker anchor. */
export function strokeCentroid(s: DustStroke): DustPoint {
  if (s.points.length === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of s.points) { sx += p.x; sy += p.y; }
  return { x: sx / s.points.length, y: sy / s.points.length };
}
/** Remove the manual/AI heal spot (stroke) at `i`. Out-of-range → unchanged. */
export function removeStrokeAt(d: DustEdits, i: number): DustEdits {
  if (i < 0 || i >= d.strokes.length) return d;
  return { ...d, strokes: d.strokes.filter((_, k) => k !== i), aiApplied: false };
}
/** Keep a global auto-dust spot: exclude its centroid from removal. */
export function addExclusion(d: DustEdits, p: DustPoint): DustEdits {
  return { ...d, autoDustExclusions: [...d.autoDustExclusions, p] };
}
/** Toggle the heal-spot marker overlay. */
export function setShowSpots(d: DustEdits, showSpots: boolean): DustEdits {
  return { ...d, showSpots };
}

/** Normalized-to-width radius → on-screen pixels at the current zoom `eff`. */
export function screenRadius(normR: number, imgW: number, eff: number): number {
  return normR * imgW * eff;
}
/** On-screen pixel radius → normalized-to-width radius. */
export function normRadius(screenR: number, imgW: number, eff: number): number {
  return imgW > 0 && eff > 0 ? screenR / (imgW * eff) : 0;
}
