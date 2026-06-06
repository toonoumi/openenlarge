import type { Rect } from "./types";

/** Transform a normalized rect when the IMAGE is rotated 90° clockwise. */
export function rotateRectCW(r: Rect): Rect {
  return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
}
export function rotateRectCCW(r: Rect): Rect {
  return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
}
export function flipRectH(r: Rect): Rect { return { ...r, x: 1 - r.x - r.w }; }
export function flipRectV(r: Rect): Rect { return { ...r, y: 1 - r.y - r.h }; }

/**
 * Orientation flags after flipping the *displayed* (oriented) image along `axis`.
 *
 * The backend applies flips BEFORE the rot90 quarter-turns (see convert.rs
 * `orient`: flip_h → flip_v → rot90). So flipping the post-rotation view is only
 * a raw flag toggle when rot90 is even. For odd quarter-turns a horizontal flip
 * of the view is a *vertical* flip of the pre-rotation image and vice versa
 * (Fh∘Rᵏ = R⁻ᵏ∘Fh), so the rotation must be negated too — otherwise H and V come
 * out swapped. Negating preserves rot90 parity, so oriented dims are unchanged
 * and the crop rect still flips on the same (display) axis.
 */
export function flipOrient(
  o: { rot90: number; flipH: boolean; flipV: boolean },
  axis: "h" | "v",
): { rot90: number; flipH: boolean; flipV: boolean } {
  return {
    rot90: (4 - o.rot90) % 4,
    flipH: axis === "h" ? !o.flipH : o.flipH,
    flipV: axis === "v" ? !o.flipV : o.flipV,
  };
}

/** Oriented pixel dims after `rot90` clockwise quarter-turns. */
export function orientDims(w: number, h: number, rot90: number): [number, number] {
  return rot90 % 2 === 1 ? [h, w] : [w, h];
}
