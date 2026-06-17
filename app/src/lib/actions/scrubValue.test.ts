import { describe, it, expect } from "vitest";
import { computeScrubValue } from "./scrubValue";
import { reciprocalSpan, reciprocalValue } from "../develop/sliderScale";

describe("computeScrubValue", () => {
  // A typical -100..100 step-1 develop slider (contrast/highlights/etc.).
  const bipolar = { startValue: 0, pxPerStep: 1, step: 1, min: -100, max: 100 };

  it("moves one step per pixel by default", () => {
    expect(computeScrubValue({ ...bipolar, dx: 5 })).toBe(5);
    expect(computeScrubValue({ ...bipolar, dx: -12 })).toBe(-12);
  });

  it("recomputes absolutely from startValue (no drift across the same drag)", () => {
    expect(computeScrubValue({ ...bipolar, startValue: 40, dx: 10 })).toBe(50);
    // A later, larger dx from the SAME startValue lands exactly, not cumulatively.
    expect(computeScrubValue({ ...bipolar, startValue: 40, dx: 25 })).toBe(65);
  });

  it("clamps to [min, max] at both ends", () => {
    expect(computeScrubValue({ ...bipolar, startValue: 90, dx: 50 })).toBe(100);
    expect(computeScrubValue({ ...bipolar, startValue: -90, dx: -50 })).toBe(-100);
  });

  it("honors a fractional step and snaps to its grid (exposure: step 0.05)", () => {
    const expo = { startValue: 0, pxPerStep: 1, step: 0.05, min: -5, max: 5 };
    expect(computeScrubValue({ ...expo, dx: 3 })).toBe(0.15);
    expect(computeScrubValue({ ...expo, dx: -2 })).toBe(-0.1);
  });

  it("kills binary-float dust from step accumulation", () => {
    // 0.1 + 0.2-style artifacts must not leak into the stored value.
    const v = computeScrubValue({ startValue: 0, dx: 3, pxPerStep: 1, step: 0.1, min: -1, max: 1 });
    expect(v).toBe(0.3);
    expect(Number.isInteger(v * 10)).toBe(true);
  });

  it("snaps an off-grid startValue onto the step grid anchored at min", () => {
    // Quality-style slider; a stray 50.4 collapses to the integer grid.
    expect(computeScrubValue({ startValue: 50.4, dx: 0, pxPerStep: 1, step: 1, min: 1, max: 100 })).toBe(50);
  });

  it("slows down with a larger pxPerStep (fine modifier)", () => {
    // 16 px of travel at 8 px/step → 2 steps.
    expect(computeScrubValue({ ...bipolar, dx: 16, pxPerStep: 8 })).toBe(2);
  });

  describe("reciprocal temperature slider (position domain, span ~480, step 0.5)", () => {
    const TEMP_MIN = 2000;
    const TEMP_MAX = 50000;
    const span = reciprocalSpan(TEMP_MIN, TEMP_MAX);
    // The action scrubs in position units [0, span]; the host converts to kelvin.
    const recip = { startValue: 0, pxPerStep: 1, step: 0.5, min: 0, max: span };

    it("clamps within the position span at both edges", () => {
      expect(computeScrubValue({ ...recip, dx: -10 })).toBe(0);
      const farRight = computeScrubValue({ ...recip, startValue: span, dx: 10_000 });
      expect(farRight).toBeCloseTo(span, 6);
    });

    it("a forward drag lowers kelvin smoothly (warm → cool reads left→right)", () => {
      const start = computeScrubValue({ ...recip, startValue: 100, dx: 0 });
      const fwd = computeScrubValue({ ...recip, startValue: 100, dx: 20 });
      expect(fwd).toBeGreaterThan(start);
      // Position increases → kelvin increases (cooler), monotonic and finite.
      expect(reciprocalValue(fwd, TEMP_MIN)).toBeGreaterThan(reciprocalValue(start, TEMP_MIN));
    });
  });
});
