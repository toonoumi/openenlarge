import { describe, it, expect } from "vitest";
import { clipUniforms } from "./clip";

describe("clipUniforms", () => {
  it("all off → enables 0", () => {
    const u = clipUniforms({ high: false, low: false, strict: false });
    expect(u.highOn).toBe(0);
    expect(u.lowOn).toBe(0);
    expect(u.strict).toBe(0);
  });

  it("highlight on → highOn 1", () => {
    const u = clipUniforms({ high: true, low: false, strict: false });
    expect(u.highOn).toBe(1);
    expect(u.lowOn).toBe(0);
  });

  it("shadow on → lowOn 1", () => {
    const u = clipUniforms({ high: false, low: true, strict: false });
    expect(u.highOn).toBe(0);
    expect(u.lowOn).toBe(1);
  });

  it("strict flag is passed through; thresholds are derived in-shader", () => {
    const u = clipUniforms({ high: true, low: true, strict: true });
    expect(u.highOn).toBe(1);
    expect(u.lowOn).toBe(1);
    expect(u.strict).toBe(1);
  });

  it("strict is independent of the enables", () => {
    const u = clipUniforms({ high: false, low: false, strict: true });
    expect(u.highOn).toBe(0);
    expect(u.lowOn).toBe(0);
    expect(u.strict).toBe(1);
  });
});
