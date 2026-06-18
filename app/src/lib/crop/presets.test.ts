import { describe, it, expect } from "vitest";
import { PRESETS, effectiveRatio, presetNormAspect } from "./presets";

describe("presets", () => {
  it("includes Original first and the required ids", () => {
    expect(PRESETS[0].id).toBe("original");
    const ids = PRESETS.map((p) => p.id);
    for (const id of ["36:24", "6:6", "6:9", "4:5", "8:10", "1:1", "8.5:11", "16:9", "16:10"])
      expect(ids).toContain(id);
  });
  it("groups every non-original preset under a film/screen group", () => {
    for (const p of PRESETS.filter((x) => x.id !== "original"))
      expect(p.group).toBeTruthy();
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

describe("presetNormAspect", () => {
  it("converts the pixel ratio to a normalized aspect (÷ nativeRatio)", () => {
    // 1:1 on a 3:2 (native 1.5) image → normalized aspect 1/1.5 so the SCREEN box is square
    expect(presetNormAspect("1:1", 1.5, "landscape")).toBeCloseTo(1 / 1.5, 4);
    expect(presetNormAspect("16:9", 1.5, "landscape")).toBeCloseTo((16 / 9) / 1.5, 4);
    // Original → normalized aspect 1 (native ratio), independent of nativeRatio
    expect(presetNormAspect("original", 1.5, "landscape")).toBeCloseTo(1, 4);
  });
});
