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
  // Absolute-WB model: the visible Temp/Tint sliders ARE the white balance. Auto-WB and the
  // gray-point picker set the sliders to the estimated absolute values (no more re-zero to
  // 5500/0), and the hidden baseline is reset to identity so it doesn't double-count. The
  // render composes wb_baseline × wb_from_kelvin(temp,tint); with identity baseline that's
  // exactly the sliders. (Old frames with a non-identity baseline still render correctly
  // until re-auto'd — migration + relative copy/roll land in the follow-up.)
  return { ...p, temp: wb.temp, tint: wb.tint, wb_baseline: [1, 1, 1] };
}
