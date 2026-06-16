import { describe, it, expect } from "vitest";
import type { InvertParams, MatchedParams } from "../api";

// Mirrors the panel's apply: spread the matched subset onto current params once.
function applyMatch(p: InvertParams, m: MatchedParams): InvertParams {
  return { ...p, ...m };
}

describe("color match apply", () => {
  it("overwrites only the scoped keys, leaving others intact", () => {
    const p = { temp: 5000, tint: 0, exposure: 0, contrast: 0, saturation: 0,
      cg_sh_hue: 0, cg_sh_sat: 0, cg_sh_lum: 0, cg_hi_hue: 0, cg_hi_sat: 0, cg_hi_lum: 0,
      vibrance: 42, highlights: 7 } as unknown as InvertParams;
    const m = { temp: 6200, tint: -10, exposure: 0.5, contrast: 12, saturation: -5,
      cg_sh_hue: 30, cg_sh_sat: 8, cg_sh_lum: -3, cg_hi_hue: 210, cg_hi_sat: 6, cg_hi_lum: 2 } as MatchedParams;
    const out = applyMatch(p, m);
    expect(out.temp).toBe(6200);
    expect(out.cg_hi_hue).toBe(210);
    expect(out.vibrance).toBe(42);   // untouched
    expect(out.highlights).toBe(7);  // untouched
  });
});
