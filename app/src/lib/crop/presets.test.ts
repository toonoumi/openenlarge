import { describe, it, expect } from "vitest";
import { PRESETS, effectiveRatio } from "./presets";

describe("presets", () => {
  it("includes Original first and the required ids", () => {
    expect(PRESETS[0].id).toBe("original");
    const ids = PRESETS.map((p) => p.id);
    for (const id of ["1:1", "4:5", "8.5:11", "5:7", "2:3", "4:4", "16:9", "16:10"])
      expect(ids).toContain(id);
  });
  it("effectiveRatio: landscape >= 1, portrait <= 1", () => {
    expect(effectiveRatio("4:5", 1.5, "landscape")).toBeCloseTo(5 / 4);
    expect(effectiveRatio("4:5", 1.5, "portrait")).toBeCloseTo(4 / 5);
  });
  it("Original resolves to the native ratio (oriented)", () => {
    expect(effectiveRatio("original", 1.5, "landscape")).toBeCloseTo(1.5);
    expect(effectiveRatio("original", 1.5, "portrait")).toBeCloseTo(1 / 1.5);
  });
});
