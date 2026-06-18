import { describe, it, expect } from "vitest";
import { clipUniforms } from "./clip";

describe("clipUniforms", () => {
  it("all off → high 0, lowOn 0", () => {
    const u = clipUniforms({ high: false, low: false, strict: false });
    expect(u.high).toBe(0);
    expect(u.lowOn).toBe(0);
  });

  it("highlight on, normal threshold → high 1.0", () => {
    const u = clipUniforms({ high: true, low: false, strict: false });
    expect(u.high).toBe(1.0);
    expect(u.lowOn).toBe(0);
  });

  it("shadow on, normal threshold → lowOn 1, low 0", () => {
    const u = clipUniforms({ high: false, low: true, strict: false });
    expect(u.lowOn).toBe(1);
    expect(u.low).toBe(0);
  });

  it("strict tightens thresholds to 253/255 and 2/255", () => {
    const u = clipUniforms({ high: true, low: true, strict: true });
    expect(u.high).toBeCloseTo(253 / 255, 6);
    expect(u.low).toBeCloseTo(2 / 255, 6);
    expect(u.lowOn).toBe(1);
  });

  it("strict but highlight off → high stays 0 (off sentinel)", () => {
    const u = clipUniforms({ high: false, low: true, strict: true });
    expect(u.high).toBe(0);
  });
});
