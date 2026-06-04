import type { ViewSpec } from "../api";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Scale that fits the whole image in the viewport (display px per image px). */
export function fitScale(imgW: number, imgH: number, vpW: number, vpH: number): number {
  if (!imgW || !imgH || !vpW || !vpH) return 1;
  return Math.min(vpW / imgW, vpH / imgH);
}

/**
 * Derive the render view from zoom/pan state.
 * `scale` = display px per image px. `(cx,cy)` = image-space point centered in the viewport.
 * The crop is the visible region in full-res image px; out_w/out_h ≈ its on-screen size.
 */
export function deriveView(
  scale: number, cx: number, cy: number,
  imgW: number, imgH: number, vpW: number, vpH: number,
  raw = false,
): ViewSpec {
  const visW = Math.min(vpW / scale, imgW);
  const visH = Math.min(vpH / scale, imgH);
  const x = clamp(cx - visW / 2, 0, Math.max(0, imgW - visW));
  const y = clamp(cy - visH / 2, 0, Math.max(0, imgH - visH));
  return {
    crop: [x, y, visW, visH],
    out_w: Math.max(1, Math.round(visW * scale)),
    out_h: Math.max(1, Math.round(visH * scale)),
    raw,
  };
}
