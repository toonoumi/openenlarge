import { describe, it, expect } from "vitest";
import { applyAsShotWb } from "./wb";
import { defaultParams } from "../api";

describe("applyAsShotWb", () => {
  it("stores gains as wb_baseline and re-zeros temp/tint to neutral center", () => {
    const p = defaultParams();
    const out = applyAsShotWb(p, { temp: 7200, tint: 30, gains: [1.2, 1, 0.8] });
    expect(out.wb_baseline).toEqual([1.2, 1, 0.8]);
    expect(out.temp).toBe(5500);
    expect(out.tint).toBe(0);
  });

  it("preserves all other params unchanged", () => {
    const p = { ...defaultParams(), exposure: 1.5, contrast: 20 };
    const out = applyAsShotWb(p, { temp: 6000, tint: -10, gains: [1.0, 1.0, 1.0] });
    expect(out.exposure).toBe(1.5);
    expect(out.contrast).toBe(20);
  });

  it("does not mutate the input params", () => {
    const p = defaultParams();
    const originalTemp = p.temp;
    applyAsShotWb(p, { temp: 7000, tint: 15, gains: [1.1, 1.0, 0.9] });
    expect(p.temp).toBe(originalTemp);
  });
});
