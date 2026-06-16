import { describe, it, expect } from "vitest";
import { binPixels, channelPath, smoothBins } from "./histogram";

describe("binPixels", () => {
  it("counts each channel value into its bucket", () => {
    // two pixels: (255,0,0) and (255,128,0)
    const data = new Uint8ClampedArray([255, 0, 0, 255, 255, 128, 0, 255]);
    const bins = binPixels(data);
    expect(bins.r[255]).toBe(2);
    expect(bins.g[0]).toBe(1);
    expect(bins.g[128]).toBe(1);
    expect(bins.b[0]).toBe(2);
  });
});

describe("smoothBins", () => {
  it("preserves length and total mass on a flat input", () => {
    const flat = new Array(256).fill(5);
    const out = smoothBins(flat, 3);
    expect(out).toHaveLength(256);
    expect(out.every((v) => Math.abs(v - 5) < 1e-9)).toBe(true); // clamped edges → no dip
  });

  it("spreads a single spike into its neighbours while keeping it the peak", () => {
    const bins = new Array(256).fill(0);
    bins[128] = 100;
    const out = smoothBins(bins, 3);
    expect(out[128]).toBeLessThan(100);   // spike is tamed
    expect(out[127]).toBeGreaterThan(0);  // mass bled to neighbours
    expect(out[129]).toBeGreaterThan(0);
    expect(out[128]).toBeGreaterThan(out[127]); // centre stays the max
  });

  it("returns the input unchanged when radius is 0", () => {
    const bins = new Array(256).fill(0);
    bins[10] = 3;
    expect(smoothBins(bins, 0)).toBe(bins);
  });
});

describe("channelPath", () => {
  it("maps the peak bucket to y=0 (top)", () => {
    const bins = new Array(256).fill(0);
    bins[0] = 10;
    const pts = channelPath(bins, 256, 80);
    expect(pts.startsWith("0.0,0.0")).toBe(true);
  });
});
