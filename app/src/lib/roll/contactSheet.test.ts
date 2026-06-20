import { describe, it, expect } from "vitest";
import { layoutContactSheet, fitContain, pickTileAspect, TILE_ASPECT } from "./contactSheet";

describe("layoutContactSheet", () => {
  const opts = { cols: 3, tileW: 100, tileH: 75, gap: 10, margin: 20 };

  it("computes canvas size from cols/rows + gaps + margins", () => {
    const l = layoutContactSheet(6, opts); // 6 frames, 3 cols → 2 rows
    expect(l.cols).toBe(3);
    expect(l.rows).toBe(2);
    // width = 2*margin + 3*tileW + 2*gap = 40 + 300 + 20 = 360
    expect(l.width).toBe(360);
    // height = 2*margin + 2*tileH + 1*gap = 40 + 150 + 10 = 200
    expect(l.height).toBe(200);
  });

  it("places tiles left-to-right, top-to-bottom", () => {
    const l = layoutContactSheet(4, opts);
    expect(l.rows).toBe(2);
    expect(l.tiles[0]).toEqual({ x: 20, y: 20, w: 100, h: 75 });            // r0c0
    expect(l.tiles[1]).toEqual({ x: 130, y: 20, w: 100, h: 75 });           // r0c1 (20+100+10)
    expect(l.tiles[3]).toEqual({ x: 20, y: 105, w: 100, h: 75 });           // r1c0 (20+75+10)
  });

  it("a partial last row still reserves a full row of height", () => {
    const l = layoutContactSheet(5, opts); // 3 cols → 2 rows
    expect(l.rows).toBe(2);
    expect(l.tiles.length).toBe(5);
  });

  it("zero frames yields an empty sheet with just margins", () => {
    const l = layoutContactSheet(0, opts);
    expect(l.rows).toBe(0);
    expect(l.tiles).toEqual([]);
    expect(l.width).toBe(360);   // still cols-wide
    expect(l.height).toBe(40);   // just top+bottom margin
  });
});

describe("fitContain", () => {
  // Box is a landscape tile: 300×200 (3:2).
  it("landscape image wider than the tile fits to width, letterboxed top/bottom", () => {
    // 3:1 image (very wide) → limited by width
    const r = fitContain(600, 200, 300, 200);
    expect(r.dw).toBe(300);
    expect(r.dh).toBe(100);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(50); // centered vertically
  });

  it("portrait image fits to height, pillarboxed left/right (no row inflation)", () => {
    // 1:2 portrait image inside a 300×200 landscape tile → limited by height
    const r = fitContain(100, 200, 300, 200);
    expect(r.dh).toBe(200);   // never exceeds the tile height
    expect(r.dw).toBe(100);
    expect(r.dy).toBe(0);
    expect(r.dx).toBe(100);   // centered horizontally
  });

  it("an exact-aspect image fills the tile with no offset", () => {
    const r = fitContain(3, 2, 300, 200);
    expect(r).toEqual({ dx: 0, dy: 0, dw: 300, dh: 200 });
  });

  it("left alignment removes the leading gap (dx=0), keeping vertical centering", () => {
    // square image in a 3:2 tile → pillarboxed; left-aligned flushes it left
    const r = fitContain(100, 100, 300, 200, "left");
    expect(r.dw).toBe(200);
    expect(r.dh).toBe(200);
    expect(r.dx).toBe(0);   // no leading space
    expect(r.dy).toBe(0);   // height fills, so no vertical slack here
  });

  it("left alignment of a squarer-than-tile landscape image flushes left, slack on the right only", () => {
    // 4:3 image (1.333) inside 3:2 tile (1.5) → height-limited, narrower than tile
    const r = fitContain(400, 300, 300, 200, "left");
    expect(r.dh).toBe(200);
    expect(r.dw).toBeCloseTo(266.67, 1);
    expect(r.dx).toBe(0);   // flush left regardless of aspect → uniform leading edge
  });

  it("falls back to the full box for degenerate (zero) dimensions", () => {
    expect(fitContain(0, 0, 300, 200)).toEqual({ dx: 0, dy: 0, dw: 300, dh: 200 });
  });

  it("TILE_ASPECT is 3:2 landscape", () => {
    expect(TILE_ASPECT).toBeCloseTo(1.5);
  });
});

describe("pickTileAspect", () => {
  it("a uniform-aspect roll yields exactly that aspect (frames fill, no gaps)", () => {
    expect(pickTileAspect([1.5, 1.5, 1.5, 1.5])).toBeCloseTo(1.5);
    expect(pickTileAspect([1.333, 1.333, 1.333])).toBeCloseTo(1.333);
  });

  it("uses the median of landscape frames, resisting an odd crop", () => {
    expect(pickTileAspect([1.3, 1.4, 1.5])).toBeCloseTo(1.4);
    expect(pickTileAspect([1.3, 1.4, 1.5, 1.6])).toBeCloseTo(1.45); // even → mean of middle two
  });

  it("ignores portrait frames when any landscape frames exist", () => {
    // portrait 0.667 present but landscape frames drive the tile
    expect(pickTileAspect([0.667, 1.5, 0.667, 1.5])).toBeCloseTo(1.5);
  });

  it("falls back to all frames when the roll is all portrait", () => {
    expect(pickTileAspect([0.667, 0.75])).toBeCloseTo(0.7085);
  });

  it("falls back to TILE_ASPECT for an empty / degenerate roll", () => {
    expect(pickTileAspect([])).toBeCloseTo(TILE_ASPECT);
    expect(pickTileAspect([0, NaN, Infinity])).toBeCloseTo(TILE_ASPECT);
  });
});
