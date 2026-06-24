import { describe, it, expect } from "vitest";
import { finishUniforms } from "./uniforms";
import type { InvertParams } from "../../api";

const base = {
  contrast: 50, highlights: -100, shadows: 0, whites: 25,
  blacks: -25, texture: 100, vibrance: 10, saturation: -40,
} as InvertParams;

describe("finishUniforms", () => {
  it("scales UI −100..100 down to −1..1 per channel", () => {
    const u = finishUniforms(base);
    expect(u.contrast).toBeCloseTo(0.5);
    // Highlights/Shadows clamp the negative half to 0: negative is engine recovery
    // (resolve_to_uniforms), so only the positive half reaches the finish pass.
    expect(u.highlights).toBeCloseTo(0); // base.highlights = −100 → recovery, not finish
    expect(u.shadows).toBeCloseTo(0);
    expect(u.whites).toBeCloseTo(0.25);
    expect(u.blacks).toBeCloseTo(-0.25);
    expect(u.texture).toBeCloseTo(1);
    expect(u.vibrance).toBeCloseTo(0.1);
    expect(u.saturation).toBeCloseTo(-0.4);
  });

  it("passes the positive half of Highlights/Shadows through unchanged", () => {
    const u = finishUniforms({ ...base, highlights: 100, shadows: 60 } as InvertParams);
    expect(u.highlights).toBeCloseTo(1);
    expect(u.shadows).toBeCloseTo(0.6);
  });

  it("clamps negative Shadows to 0 (engine recovery, not a finish move)", () => {
    const u = finishUniforms({ ...base, shadows: -50 } as InvertParams);
    expect(u.shadows).toBeCloseTo(0);
  });
});
