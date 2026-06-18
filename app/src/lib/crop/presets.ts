export interface AspectPreset { id: string; label: string; ratio: number | null; group?: string } // w/h; null = original

// Ordered by film-format group; ratios coinciding across formats is intentional
// (e.g. 4×5 and 8×10 are the same ratio but distinct sheet-film sizes).
export const PRESETS: AspectPreset[] = [
  { id: "original", label: "crop.aspect.original", ratio: null },
  // 135 (35mm)
  { id: "36:24", label: "crop.aspect.36x24", ratio: 36 / 24, group: "crop.aspectGroup.135" },
  // 120 (medium format)
  { id: "6:4.5", label: "crop.aspect.6x4_5", ratio: 6 / 4.5, group: "crop.aspectGroup.120" },
  { id: "6:6", label: "crop.aspect.6x6", ratio: 1, group: "crop.aspectGroup.120" },
  { id: "6:7", label: "crop.aspect.6x7", ratio: 6 / 7, group: "crop.aspectGroup.120" },
  { id: "6:8", label: "crop.aspect.6x8", ratio: 6 / 8, group: "crop.aspectGroup.120" },
  { id: "6:9", label: "crop.aspect.6x9", ratio: 6 / 9, group: "crop.aspectGroup.120" },
  // Large format (sheet film)
  { id: "4:5", label: "crop.aspect.4x5", ratio: 4 / 5, group: "crop.aspectGroup.large" },
  { id: "5:7", label: "crop.aspect.5x7", ratio: 5 / 7, group: "crop.aspectGroup.large" },
  { id: "8:10", label: "crop.aspect.8x10", ratio: 8 / 10, group: "crop.aspectGroup.large" },
  // Screen / print
  { id: "1:1", label: "crop.aspect.1x1", ratio: 1, group: "crop.aspectGroup.screen" },
  { id: "16:9", label: "crop.aspect.16x9", ratio: 16 / 9, group: "crop.aspectGroup.screen" },
  { id: "16:10", label: "crop.aspect.16x10", ratio: 16 / 10, group: "crop.aspectGroup.screen" },
  { id: "8.5:11", label: "crop.aspect.8_5x11", ratio: 8.5 / 11, group: "crop.aspectGroup.screen" },
];

export interface AspectGroup { label: string | null; items: AspectPreset[] }

/** PRESETS bucketed into consecutive groups for <optgroup> rendering.
 *  Ungrouped presets (e.g. "original") get a null label → rendered as bare options. */
export const PRESET_GROUPS: AspectGroup[] = PRESETS.reduce<AspectGroup[]>((groups, p) => {
  const key = p.group ?? null;
  const last = groups[groups.length - 1];
  if (last && last.label === key) last.items.push(p);
  else groups.push({ label: key, items: [p] });
  return groups;
}, []);

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
