/** GPU uniform values for the clipping-warning overlay. */
export interface ClipUniforms {
  /** 0 = highlight warning off (shader off-sentinel); else high threshold in 0..1. */
  high: number;
  /** Shadow threshold in 0..1. */
  low: number;
  /** 1 = shadow warning on, 0 = off. */
  lowOn: number;
}

/** Map clip-warning toggle state to shader uniform values.
 *  Normal mode flags pure clip (255 / 0); strict mode flags near-clip (253 / 2). */
export function clipUniforms(s: { high: boolean; low: boolean; strict: boolean }): ClipUniforms {
  const hi = s.strict ? 253 / 255 : 1.0;
  const lo = s.strict ? 2 / 255 : 0.0;
  return {
    high: s.high ? hi : 0,
    low: lo,
    lowOn: s.low ? 1 : 0,
  };
}
