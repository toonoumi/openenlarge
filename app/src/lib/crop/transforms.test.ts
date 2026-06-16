import { describe, it, expect } from "vitest";
import { rotateRectCW, rotateRectCCW, flipRectH, flipRectV, orientDims, flipOrient, displayToSourceUV } from "./transforms";
import type { Rect } from "./types";
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const close = (a: Rect, b: Rect) => {
  for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 6);
};

describe("rect transforms", () => {
  it("rotateRectCW four times is identity", () => {
    let c = r(0.1, 0.2, 0.3, 0.4); const start = { ...c };
    for (let i = 0; i < 4; i++) c = rotateRectCW(c);
    close(c, start);
  });
  it("CW then CCW is identity", () => {
    const c = r(0.1, 0.2, 0.3, 0.4);
    close(rotateRectCCW(rotateRectCW(c)), c);
  });
  it("flipRectH twice is identity; mirrors x once", () => {
    const c = r(0.1, 0.2, 0.3, 0.4);
    close(flipRectH(flipRectH(c)), c);
    expect(flipRectH(c).x).toBeCloseTo(1 - 0.1 - 0.3, 6);
  });
  it("flipRectV mirrors y", () => {
    expect(flipRectV(r(0.1, 0.2, 0.3, 0.4)).y).toBeCloseTo(1 - 0.2 - 0.4, 6);
  });
  it("rotateRectCW swaps w/h", () => {
    const c = rotateRectCW(r(0.1, 0.2, 0.3, 0.4));
    expect(c.w).toBeCloseTo(0.4, 6); expect(c.h).toBeCloseTo(0.3, 6);
  });
  it("orientDims swaps on quarter turns", () => {
    expect(orientDims(2, 3, 0)).toEqual([2, 3]);
    expect(orientDims(2, 3, 1)).toEqual([3, 2]);
    expect(orientDims(2, 3, 2)).toEqual([2, 3]);
    expect(orientDims(2, 3, 3)).toEqual([3, 2]);
  });
});

// Pixel-grid model of the backend's orient (convert.rs): flip_h, flip_v, then
// `rot90` clockwise quarter-turns. Used to prove flipOrient flips the *displayed*
// image, not the pre-rotation source.
type Grid = { w: number; h: number; px: string[] };
const at = (g: Grid, x: number, y: number) => g.px[y * g.w + x];
function gridFlipH(g: Grid): Grid {
  const px = g.px.map((_, i) => at(g, g.w - 1 - (i % g.w), Math.floor(i / g.w)));
  return { w: g.w, h: g.h, px };
}
function gridFlipV(g: Grid): Grid {
  const px = g.px.map((_, i) => at(g, i % g.w, g.h - 1 - Math.floor(i / g.w)));
  return { w: g.w, h: g.h, px };
}
function gridRotCW(g: Grid): Grid {
  const nw = g.h, nh = g.w;
  const px = new Array<string>(nw * nh);
  for (let ny = 0; ny < nh; ny++)
    for (let nx = 0; nx < nw; nx++) px[ny * nw + nx] = at(g, ny, g.h - 1 - nx);
  return { w: nw, h: nh, px };
}
function orient(g: Grid, rot90: number, flipH: boolean, flipV: boolean): Grid {
  let o = g;
  if (flipH) o = gridFlipH(o);
  if (flipV) o = gridFlipV(o);
  for (let i = 0; i < rot90 % 4; i++) o = gridRotCW(o);
  return o;
}

describe("flipOrient", () => {
  // Asymmetric so every distinct orientation is detectable.
  const base: Grid = { w: 2, h: 3, px: ["A", "B", "C", "D", "E", "F"] };

  it("flips the displayed (oriented) image for every starting orientation", () => {
    for (let rot90 = 0; rot90 < 4; rot90++)
      for (const flipH of [false, true])
        for (const flipV of [false, true])
          for (const axis of ["h", "v"] as const) {
            const shown = orient(base, rot90, flipH, flipV);
            const expected = axis === "h" ? gridFlipH(shown) : gridFlipV(shown);
            const o = flipOrient({ rot90, flipH, flipV }, axis);
            const actual = orient(base, o.rot90, o.flipH, o.flipV);
            expect(actual, `rot90=${rot90} flipH=${flipH} flipV=${flipV} axis=${axis}`).toEqual(expected);
          }
  });

  it("flipping the same axis twice restores the original flags", () => {
    for (let rot90 = 0; rot90 < 4; rot90++)
      for (const axis of ["h", "v"] as const) {
        const start = { rot90, flipH: false, flipV: false };
        const once = flipOrient(start, axis);
        const twice = flipOrient(once, axis);
        expect(twice).toEqual(start);
      }
  });
});

describe("displayToSourceUV", () => {
  const closeUV = (a: [number, number], b: [number, number]) => {
    expect(a[0]).toBeCloseTo(b[0], 6); expect(a[1]).toBeCloseTo(b[1], 6);
  };
  it("identity maps a point to itself", () => {
    closeUV(displayToSourceUV(0.3, 0.7, null, 0, false, false), [0.3, 0.7]);
  });
  it("un-crops into the oriented full image", () => {
    // crop window [0.25,0.25,0.5,0.5]; display center → source center.
    closeUV(displayToSourceUV(0.5, 0.5, [0.25, 0.25, 0.5, 0.5], 0, false, false), [0.5, 0.5]);
    // display top-left → crop top-left in source.
    closeUV(displayToSourceUV(0, 0, [0.25, 0.25, 0.5, 0.5], 0, false, false), [0.25, 0.25]);
  });
  it("inverts a 90° CW rotation (display top-left → source bottom-left)", () => {
    closeUV(displayToSourceUV(0, 0, null, 1, false, false), [0, 1]);
  });
  it("inverts a horizontal flip (display left → source right)", () => {
    closeUV(displayToSourceUV(0, 0.4, null, 0, true, false), [1, 0.4]);
  });
  it("inverts a vertical flip (display top → source bottom)", () => {
    closeUV(displayToSourceUV(0.4, 0, null, 0, false, true), [0.4, 1]);
  });
});
