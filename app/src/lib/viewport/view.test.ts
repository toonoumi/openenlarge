import { describe, it, expect } from "vitest";
import { fitScale, deriveView, viewWindow } from "./view";

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

describe("viewWindow", () => {
  // 1000x500 image, 250x250 viewport, dpr 1, generous backing cap.
  it("fit/zoomed-out: identity window, canvas = letterboxed image rect", () => {
    const s = fitScale(1000, 500, 250, 250); // 0.25
    const w = viewWindow(s, 500, 250, 1000, 500, 250, 250, 1, 8192);
    expect(w.off).toEqual([0, 0]);
    expect(w.scale).toEqual([1, 1]);
    // dispW=250, dispH=125 → centered vertically in the 250 tall viewport.
    expect(w.css).toEqual({ left: 0, top: 62.5, width: 250, height: 125 });
    expect(w.backing).toEqual({ w: 250, h: 125 });
  });

  it("100% centered: full viewport canvas, centered half-ish window", () => {
    const w = viewWindow(1, 500, 250, 1000, 500, 250, 250, 1, 8192);
    // visW=250 of 1000 → scale .25, centered at x=375 → off .375; visH=250 of 500 → scale .5, off .25
    expect(w.off[0]).toBeCloseTo(0.375, 6);
    expect(w.scale[0]).toBeCloseTo(0.25, 6);
    expect(w.off[1]).toBeCloseTo(0.25, 6);
    expect(w.scale[1]).toBeCloseTo(0.5, 6);
    expect(w.css).toEqual({ left: 0, top: 0, width: 250, height: 250 });
    expect(w.backing).toEqual({ w: 250, h: 250 });
  });

  it("high zoom: backing stays bounded, window is a thin slice", () => {
    // 8x zoom on a 1000px image → dispW 8000; viewport 250 → window 250/8000.
    const w = viewWindow(8, 500, 250, 1000, 500, 250, 250, 2, 8192);
    expect(w.scale[0]).toBeCloseTo(250 / 8000, 6);
    expect(w.css.width).toBe(250);
    expect(w.backing.w).toBe(500); // 250 css * dpr 2, under the 8192 cap
  });

  it("backing is capped at maxBacking", () => {
    const w = viewWindow(8, 500, 250, 1000, 500, 250, 250, 2, 300);
    expect(w.backing.w).toBe(300); // 500 would exceed the 300 cap
  });

  it("pan clamps the window inside the image", () => {
    // 2x zoom, panned hard left/up past the edge.
    const w = viewWindow(2, 0, 0, 1000, 500, 250, 250, 1, 8192);
    expect(w.off[0]).toBe(0); // clamped to the left edge
    expect(w.off[1]).toBe(0);
  });

  it("backing cap preserves aspect when only one axis exceeds it", () => {
    // Wide 4000x1000 image, 2300x1000 pane, dpr 2, cap 4096. At fit the window fills
    // the pane: css ~2300x575 → device 4600x1150; width caps, height must scale with it.
    const w = viewWindow(fitScale(4000, 1000, 2300, 1000), 2000, 500, 4000, 1000, 2300, 1000, 2, 4096);
    expect(Math.max(w.backing.w, w.backing.h)).toBeLessThanOrEqual(4096);
    // aspect preserved (within a 1px rounding tolerance)
    expect(w.backing.w / w.backing.h).toBeCloseTo(w.css.width / w.css.height, 2);
  });
});
