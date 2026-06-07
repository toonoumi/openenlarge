import { describe, it, expect } from "vitest";
import { reciprocalPos, reciprocalValue, reciprocalSpan } from "./sliderScale";

const MIN = 2000;
const MAX = 50000;

describe("reciprocal slider scale", () => {
  it("pins min to the left (pos 0) and max to the right (pos = span)", () => {
    expect(reciprocalPos(MIN, MIN)).toBeCloseTo(0, 6);
    expect(reciprocalPos(MAX, MIN)).toBeCloseTo(reciprocalSpan(MIN, MAX), 6);
  });

  it("round-trips position <-> value", () => {
    for (const v of [2000, 3200, 5500, 6500, 12000, 50000]) {
      expect(reciprocalValue(reciprocalPos(v, MIN), MIN)).toBeCloseTo(v, 3);
    }
  });

  it("gives equal perceptual (mired) shift for equal thumb travel", () => {
    // Equal position deltas anywhere on the track must map to equal mired deltas.
    const span = reciprocalSpan(MIN, MAX);
    const at = (frac: number) => reciprocalValue(frac * span, MIN);
    const miredOf = (v: number) => 1e6 / v;
    const lowEnd = Math.abs(miredOf(at(0.1)) - miredOf(at(0.2)));
    const midPoint = Math.abs(miredOf(at(0.45)) - miredOf(at(0.55)));
    const highEnd = Math.abs(miredOf(at(0.8)) - miredOf(at(0.9)));
    expect(midPoint).toBeCloseTo(lowEnd, 3);
    expect(highEnd).toBeCloseTo(lowEnd, 3);
  });

  it("moves neutral (5500K) off the 7% linear-kelvin position toward mid-track", () => {
    const frac = reciprocalPos(5500, MIN) / reciprocalSpan(MIN, MAX);
    // Linear kelvin would put 5500K at ~7%; reciprocal lifts it to ~66%.
    expect(frac).toBeGreaterThan(0.6);
    expect(frac).toBeLessThan(0.7);
  });
});
