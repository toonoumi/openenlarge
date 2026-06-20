import { describe, it, expect } from "vitest";
import { rgbToHslSample, sampleCoords, pickPixel } from "./colorPick";

describe("sampleCoords", () => {
  // A canvas whose backbuffer is 2× its CSS size (HiDPI), origin handling.
  const dims = { width: 200, height: 100, clientWidth: 100, clientHeight: 50 };

  it("maps a CSS point to framebuffer coords with a bottom-left (y-flipped) origin", () => {
    // Cursor at CSS (10, 5) → device (20, 10) from the top; GL y = H-1-10 = 89.
    expect(sampleCoords(dims, 10, 5)).toEqual({ sx: 20, sy: 89 });
  });

  it("top-left CSS corner maps to the top row in GL space (sy = H-1)", () => {
    expect(sampleCoords(dims, 0, 0)).toEqual({ sx: 0, sy: 99 });
  });

  it("bottom-right CSS corner clamps inside the backbuffer", () => {
    expect(sampleCoords(dims, 100, 50)).toEqual({ sx: 199, sy: 0 });
  });

  it("returns null when the point is outside the element bounds", () => {
    expect(sampleCoords(dims, -1, 10)).toBeNull();
    expect(sampleCoords(dims, 10, -1)).toBeNull();
    expect(sampleCoords(dims, 101, 10)).toBeNull();
    expect(sampleCoords(dims, 10, 51)).toBeNull();
  });
});

describe("pickPixel", () => {
  const canvas = { width: 200, height: 100, clientWidth: 100, clientHeight: 50 } as HTMLCanvasElement;

  it("reads the CLEAN image pixel via the renderer (no clip overlay) when one is present", () => {
    const calls: Array<[number, number]> = [];
    const renderer = {
      readPixel(sx: number, sy: number): [number, number, number] | null {
        calls.push([sx, sy]);
        return [12, 34, 56];
      },
    };
    // Cursor at CSS (10, 5) → device (20, 10) top → GL (20, 89).
    expect(pickPixel(renderer, canvas, 10, 5)).toEqual([12, 34, 56]);
    expect(calls).toEqual([[20, 89]]);
  });

  it("returns null without touching the renderer when out of bounds", () => {
    let touched = false;
    const renderer = { readPixel() { touched = true; return [0, 0, 0] as [number, number, number]; } };
    expect(pickPixel(renderer, canvas, -5, 5)).toBeNull();
    expect(touched).toBe(false);
  });
});

describe("rgbToHslSample", () => {
  it("converts a mid red byte pixel to HSL fields", () => {
    const s = rgbToHslSample(204, 51, 51); // ~ [0.8,0.2,0.2]
    expect(s.hue).toBeCloseTo(0, 0);
    expect(s.sat).toBeGreaterThan(0.5);
    expect(s.lum).toBeCloseTo(0.5, 1);
    expect(s.hue_shift).toBe(0);
    expect(s.range).toBe(50);
  });
  it("gray maps to zero saturation", () => {
    const s = rgbToHslSample(128, 128, 128);
    expect(s.sat).toBeCloseTo(0, 2);
  });
});

describe("medianRGBA", () => {
  // RGBA blocks: a run of neutral grain plus one extreme outlier per channel.
  // The median ignores the outlier the way a mean could not.
  it("returns the per-channel median and shrugs off a single outlier", async () => {
    const { medianRGBA } = await import("./colorPick");
    const px = [
      [100, 100, 100], [102, 98, 101], [99, 101, 100], [101, 99, 99],
      [255, 0, 255], // grain spike on R/B, crush on G
    ];
    const data = new Uint8Array(px.length * 4);
    px.forEach((p, i) => { data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2]; data[i * 4 + 3] = 255; });
    const m = medianRGBA(data)!;
    expect(m[0]).toBeGreaterThanOrEqual(99); expect(m[0]).toBeLessThanOrEqual(102);
    expect(m[1]).toBeGreaterThanOrEqual(98); expect(m[1]).toBeLessThanOrEqual(101);
    expect(m[2]).toBeGreaterThanOrEqual(99); expect(m[2]).toBeLessThanOrEqual(101);
  });

  it("returns null for an empty block", async () => {
    const { medianRGBA } = await import("./colorPick");
    expect(medianRGBA(new Uint8Array(0))).toBeNull();
  });
});
