/** GPU uniform values for the clipping-warning overlay (B1: output detail-loss).
 *
 *  The overlay no longer compares the displayed pixel against a hard-coded value
 *  (255 / 253): that test never fired because invert_d's highlight soft-clip rolls
 *  blown highlights off to ~0.99 and never reaches 1.0. Instead the shader derives
 *  the detail-loss thresholds from the engine soft-clip knee (see clipCode() in
 *  shaders.ts), so these are just enables plus the strict flag. */
export interface ClipUniforms {
  /** 1 = highlight (red) overlay on, 0 = off. */
  highOn: number;
  /** 1 = shadow (blue) overlay on, 0 = off. */
  lowOn: number;
  /** 1 = strict: flag the ONSET of loss (any compression / near-black) rather than
   *  only true output detail-loss. */
  strict: number;
}

/** Map clip-warning toggle state to shader uniform values. */
export function clipUniforms(s: { high: boolean; low: boolean; strict: boolean }): ClipUniforms {
  return {
    highOn: s.high ? 1 : 0,
    lowOn: s.low ? 1 : 0,
    strict: s.strict ? 1 : 0,
  };
}
