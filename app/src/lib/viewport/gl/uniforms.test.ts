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
    expect(u.highlights).toBeCloseTo(-1);
    expect(u.shadows).toBeCloseTo(0);
    expect(u.whites).toBeCloseTo(0.25);
    expect(u.blacks).toBeCloseTo(-0.25);
    expect(u.texture).toBeCloseTo(1);
    expect(u.vibrance).toBeCloseTo(0.1);
    expect(u.saturation).toBeCloseTo(-0.4);
  });
});
