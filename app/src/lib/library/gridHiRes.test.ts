import { describe, it, expect } from "vitest";
import { gridColumns, gridThumbView } from "./gridHiRes";
import type { CropRect } from "../crop/types";
import type { DustEdits } from "../develop/dust";

describe("gridColumns", () => {
  // 800px container, 16px padding, 12px gap.
  it("packs many columns when cells are small", () => {
    expect(gridColumns(800, 130, 16, 12)).toBe(5); // floor((800-16+12)/(130+12)) = 5
  });

  it("gives 2 columns when cells are about half the width", () => {
    expect(gridColumns(800, 380, 16, 12)).toBe(2); // floor(796/392) = 2
  });

  it("gives 1 column when a cell fills the row (max zoom)", () => {
    expect(gridColumns(800, 784, 16, 12)).toBe(1);
  });

  it("never returns less than 1", () => {
    expect(gridColumns(100, 9999, 16, 12)).toBe(1);
  });
});

describe("gridThumbView", () => {
  it("maps crop geometry and carries the edge cap", () => {
    const crop: CropRect = {
      rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, aspect: "custom",
      orientation: "landscape", rot90: 1, flipH: true, flipV: false, angle: 3,
    };
    expect(gridThumbView(crop, null, 1080)).toEqual({
      image_crop: [0.1, 0.2, 0.5, 0.6],
      rot90: 1, flip_h: true, flip_v: false, angle: 3, edge: 1080,
    });
  });

  it("defaults geometry and omits dust when there is no crop/dust", () => {
    expect(gridThumbView(null, null, 720)).toEqual({
      image_crop: null, rot90: 0, flip_h: false, flip_v: false, angle: 0, edge: 720,
    });
  });

  it("includes dust strokes and IR removal when present", () => {
    const dust: DustEdits = {
      strokes: [{ points: [{ x: 0.1, y: 0.1 }], r: 0.02 }],
      irRemoval: { enabled: true, sensitivity: 60 },
      autoDust: { enabled: false, sensitivity: 50 }, brushMigan: false, aiApplied: false,
    };
    const view = gridThumbView(null, dust, 1080);
    expect(view.dust).toEqual(dust.strokes);
    expect(view.ir_removal).toEqual({ enabled: true, sensitivity: 60 });
  });
});
