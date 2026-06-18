import { describe, it, expect } from "vitest";
import { layoutContactSheet } from "./contactSheet";

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
