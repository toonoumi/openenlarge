/** A point normalized to the displayed image ([0,1] in both axes). */
export interface DustPoint { x: number; y: number }
/** A brush stroke: a polyline + radius normalized to the displayed image WIDTH. */
export interface DustStroke { points: DustPoint[]; r: number }
/** IR-driven automatic dust removal settings. */
export interface IrRemoval { enabled: boolean; sensitivity: number }
/** AI (learned-model) auto dust/hair removal settings. */
export interface AutoDust { enabled: boolean; sensitivity: number }
/** Per-image dust edit state. `brushMigan` heals manual strokes with MI-GAN
 * (applied on export; the live preview uses the fast classic fill). */
export interface DustEdits { strokes: DustStroke[]; irRemoval: IrRemoval; autoDust: AutoDust; brushMigan: boolean }

export const emptyDust = (): DustEdits => ({
  strokes: [],
  irRemoval: { enabled: false, sensitivity: 50 },
  autoDust: { enabled: false, sensitivity: 50 },
  brushMigan: false,
});

export function addStroke(d: DustEdits, s: DustStroke): DustEdits {
  return { ...d, strokes: [...d.strokes, s] };
}
export function undoStroke(d: DustEdits): DustEdits {
  return { ...d, strokes: d.strokes.slice(0, -1) };
}
export function resetDust(d: DustEdits): DustEdits {
  return { ...d, strokes: [] };
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
  return { ...d, brushMigan };
}

/** Normalized-to-width radius → on-screen pixels at the current zoom `eff`. */
export function screenRadius(normR: number, imgW: number, eff: number): number {
  return normR * imgW * eff;
}
/** On-screen pixel radius → normalized-to-width radius. */
export function normRadius(screenR: number, imgW: number, eff: number): number {
  return imgW > 0 && eff > 0 ? screenR / (imgW * eff) : 0;
}
