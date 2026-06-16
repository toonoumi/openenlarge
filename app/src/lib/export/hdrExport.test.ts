import { describe, it, expect } from "vitest";
import { wantsHdrExport } from "./hdrExport";

describe("wantsHdrExport", () => {
  it("true only for jpeg + hdr-on", () => {
    expect(wantsHdrExport("jpeg", { hdr: true } as any)).toBe(true);
  });
  it("false for jpeg + hdr-off", () => {
    expect(wantsHdrExport("jpeg", { hdr: false } as any)).toBe(false);
  });
  it("false for tiff/png even with hdr on", () => {
    expect(wantsHdrExport("tiff", { hdr: true } as any)).toBe(false);
    expect(wantsHdrExport("png", { hdr: true } as any)).toBe(false);
  });
  it("false when hdr is undefined (old params)", () => {
    expect(wantsHdrExport("jpeg", {} as any)).toBe(false);
  });
});
