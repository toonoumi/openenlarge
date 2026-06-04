import { describe, it, expect } from "vitest";
import { fitScale, deriveView } from "./view";

describe("deriveView", () => {
  it("fit view covers the whole image", () => {
    const s = fitScale(1000, 500, 250, 250);
    const v = deriveView(s, 500, 250, 1000, 500, 250, 250);
    expect(v.crop).toEqual([0, 0, 1000, 500]);
    expect(v.out_w).toBe(250);
    expect(v.out_h).toBe(125);
  });

  it("100% yields a viewport-sized crop centered on the point", () => {
    const v = deriveView(1.0, 500, 250, 1000, 500, 250, 250);
    expect(v.crop).toEqual([375, 125, 250, 250]);
    expect(v.out_w).toBe(250);
    expect(v.out_h).toBe(250);
  });

  it("clamps the crop at the edges", () => {
    const v = deriveView(1.0, 0, 0, 1000, 500, 250, 250);
    expect(v.crop[0]).toBe(0);
    expect(v.crop[1]).toBe(0);
  });
});
