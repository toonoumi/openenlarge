/**
 * Reciprocal ("mired") slider scale for colour temperature.
 *
 * Colour-temperature perception is roughly linear in reciprocal kelvin
 * (mired = 1e6 / K), not in kelvin. A slider linear in kelvin over e.g.
 * 2000–50000 K therefore crams the whole warm (low-K) half into a sliver near
 * the minimum and stretches the cool (high-K) half across the rest — blue races,
 * yellow crawls. Mapping the <input> domain to `1e6/min - 1e6/value` makes equal
 * thumb travel produce an equal perceptual white-balance shift, with `min`
 * pinned to the left edge of the track (so warm→cool still reads left→right).
 */

/** Slider position (input value) for a natural value on the reciprocal scale. */
export function reciprocalPos(value: number, min: number): number {
  return 1e6 / min - 1e6 / value;
}

/** Inverse of {@link reciprocalPos}: natural value for a slider position. */
export function reciprocalValue(pos: number, min: number): number {
  return 1e6 / (1e6 / min - pos);
}

/** Input-domain span `[0, span]` covering the natural range `[min, max]`. */
export function reciprocalSpan(min: number, max: number): number {
  return 1e6 / min - 1e6 / max;
}
