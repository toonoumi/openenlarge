export interface AspectPreset { id: string; label: string; ratio: number | null } // w/h; null = original

export const PRESETS: AspectPreset[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "1:1", label: "1 × 1", ratio: 1 },
  { id: "4:5", label: "4 × 5  ·  8 × 10", ratio: 4 / 5 },
  { id: "8.5:11", label: "8.5 × 11", ratio: 8.5 / 11 },
  { id: "5:7", label: "5 × 7", ratio: 5 / 7 },
  { id: "2:3", label: "2 × 3  ·  4 × 6", ratio: 2 / 3 },
  { id: "4:4", label: "4 × 4", ratio: 1 },
  { id: "16:9", label: "16 × 9", ratio: 16 / 9 },
  { id: "16:10", label: "16 × 10", ratio: 16 / 10 },
];

/** Effective target ratio (w/h) for a preset under an orientation.
 *  landscape → ≥1, portrait → ≤1. "original"/"custom" use the native ratio. */
export function effectiveRatio(
  id: string, nativeRatio: number, orientation: "landscape" | "portrait",
): number {
  const p = PRESETS.find((x) => x.id === id);
  const base = p && p.ratio != null ? p.ratio : nativeRatio;
  return orientation === "landscape" ? Math.max(base, 1 / base) : Math.min(base, 1 / base);
}

/** Normalized aspect (w_norm/h_norm) for a preset, so the ON-SCREEN box has the
 *  intended pixel ratio. screenRatio = (w_norm/h_norm) × nativeRatio, hence we
 *  divide the pixel ratio by nativeRatio. */
export function presetNormAspect(
  id: string, nativeRatio: number, orientation: "landscape" | "portrait",
): number {
  return effectiveRatio(id, nativeRatio, orientation) / nativeRatio;
}

export function labelFor(id: string): string {
  if (id === "custom") return "Custom";
  return PRESETS.find((p) => p.id === id)?.label ?? "Custom";
}
