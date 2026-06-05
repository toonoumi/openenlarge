import { describe, it, expect } from "vitest";
import { clampRect, conform, applyDrag, default80, toScreen, MIN } from "./cropMath";
import type { Rect } from "./types";

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("clampRect", () => {
  it("keeps the rect inside [0,1] and at least MIN", () => {
    const c = clampRect(r(-0.2, 0.9, 0.5, 0.5));
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(c.w).toBeGreaterThanOrEqual(MIN);
  });
});

describe("conform", () => {
  it("produces the target aspect ratio (w/h), centered, in bounds", () => {
    const c = conform(r(0.1, 0.1, 0.8, 0.8), 2);
    expect(c.w / c.h).toBeCloseTo(2, 2);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("default80", () => {
  it("is a centered 80% box (native ratio lives in normalized space)", () => {
    expect(default80()).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  });
});

describe("conform screen ratio", () => {
  it("a normalized aspect of pixelRatio/native yields that pixel ratio on screen", () => {
    const native = 1.5, pixelRatio = 1;        // want a square on screen
    const na = pixelRatio / native;
    const c = conform({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, na);
    expect((c.w / c.h) * native).toBeCloseTo(pixelRatio, 3);
  });
});

describe("applyDrag", () => {
  it("move shifts the rect by the delta", () => {
    const c = applyDrag("move", r(0.3, 0.3, 0.4, 0.4), 0.1, -0.1, null);
    expect(c.x).toBeCloseTo(0.4);
    expect(c.y).toBeCloseTo(0.2);
    expect(c.w).toBeCloseTo(0.4);
  });
  it("east handle grows width, freeform", () => {
    const c = applyDrag("e", r(0.2, 0.2, 0.3, 0.3), 0.1, 0, null);
    expect(c.w).toBeCloseTo(0.4);
    expect(c.x).toBeCloseTo(0.2);
  });
  it("corner with aspect lock preserves the ratio", () => {
    const c = applyDrag("se", r(0.2, 0.2, 0.3, 0.3), 0.2, 0.0, 1);
    expect(c.w / c.h).toBeCloseTo(1, 2);
  });
});

describe("toScreen", () => {
  it("maps a normalized rect into the image's screen rect", () => {
    const s = toScreen(r(0.5, 0, 0.5, 1), { left: 100, top: 50, width: 200, height: 100 });
    expect(s).toEqual({ left: 200, top: 50, width: 100, height: 100 });
  });
});
