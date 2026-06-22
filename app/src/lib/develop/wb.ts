// White-balance helper: maps an AsShotWb result onto InvertParams using the
// "store-baseline, re-zero-sliders" model. The gains are stored as wb_baseline
// (consumed by the engine) and the user-visible Temp/Tint sliders are reset to
// the neutral center (5500 K / 0) so they always start at zero after auto-WB.
import type { InvertParams, AsShotWb } from "../api";

/**
 * Merge an AsShotWb result into params, storing gains as the hidden engine
 * baseline and re-zeroing the Temp/Tint sliders to their neutral center.
 *
 * @param p   - current InvertParams (not mutated)
 * @param wb  - AsShotWb returned by as_shot_wb or gray_point_wb
 * @returns   a new InvertParams with wb_baseline set and temp/tint at neutral
 */
export function applyAsShotWb(p: InvertParams, wb: AsShotWb): InvertParams {
  return { ...p, wb_baseline: wb.gains, temp: 5500, tint: 0 };
}
