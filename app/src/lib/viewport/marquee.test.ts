import { describe, it, expect } from "vitest";
import { marqueeZoom } from "./marquee";

describe("marqueeZoom", () => {
  it("centers on the rectangle midpoint regardless of corner order", () => {
    const a = marqueeZoom(100, 200, 300, 400, 1000, 1000, 0.5);
    expect(a.cx).toBe(200);
    expect(a.cy).toBe(300);
    const b = marqueeZoom(300, 400, 100, 200, 1000, 1000, 0.5);
    expect(b.cx).toBe(200);
    expect(b.cy).toBe(300);
  });

  it("scales so the limiting rectangle dimension fills the viewport", () => {
    // rect 200 wide x 100 tall, viewport 1000x1000 → width is limiting: 1000/200 = 5
    const z = marqueeZoom(0, 0, 200, 100, 1000, 1000, 0.5);
    expect(z.scale).toBeCloseTo(5);
  });

  it("never zooms below fit", () => {
    // huge rect would imply scale < fit; clamp up to fit
    const z = marqueeZoom(0, 0, 5000, 5000, 1000, 1000, 0.5);
    expect(z.scale).toBeCloseTo(0.5);
  });

  it("never zooms beyond max", () => {
    // tiny rect would imply enormous scale; clamp to max
    const z = marqueeZoom(0, 0, 2, 2, 1000, 1000, 0.5, 8);
    expect(z.scale).toBe(8);
  });

  it("treats a zero-area rectangle as max zoom without dividing by zero", () => {
    const z = marqueeZoom(50, 50, 50, 50, 1000, 1000, 0.5, 8);
    expect(z.scale).toBe(8);
    expect(z.cx).toBe(50);
    expect(z.cy).toBe(50);
  });
});
