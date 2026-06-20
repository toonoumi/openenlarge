import { describe, it, expect } from "vitest";
import { layoutContactSheet, fitContain, TILE_ASPECT } from "./contactSheet";

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

  it("falls back to the full box for degenerate (zero) dimensions", () => {
    expect(fitContain(0, 0, 300, 200)).toEqual({ dx: 0, dy: 0, dw: 300, dh: 200 });
  });

  it("TILE_ASPECT is 3:2 landscape", () => {
    expect(TILE_ASPECT).toBeCloseTo(1.5);
  });
});
