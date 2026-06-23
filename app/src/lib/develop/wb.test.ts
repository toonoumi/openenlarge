import { describe, it, expect } from "vitest";
import { applyAsShotWb } from "./wb";
import { defaultParams } from "../api";

describe("applyAsShotWb", () => {
  it("sets the visible Temp/Tint to the estimate and resets the baseline to identity", () => {
    const p = defaultParams();
    const out = applyAsShotWb(p, { temp: 7200, tint: 30, gains: [1.2, 1, 0.8] });
    // Absolute-WB model: the sliders carry the white balance; the hidden baseline is identity.
    expect(out.temp).toBe(7200);
    expect(out.tint).toBe(30);
    expect(out.wb_baseline).toEqual([1, 1, 1]);
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
