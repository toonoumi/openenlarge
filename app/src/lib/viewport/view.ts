import type { ViewSpec } from "../api";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Round (w,h) device px to integers, capped so the LONGER edge ≤ `cap` while
 *  preserving aspect (uniform scale — never clamp axes independently, which would
 *  distort the image when only one axis exceeds the cap). */
function aspectCappedBacking(w: number, h: number, cap: number): { w: number; h: number } {
  const k = Math.min(1, cap / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

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

export interface ViewWindow {
  off: [number, number];
  scale: [number, number];
  backing: { w: number; h: number };
  css: { left: number; top: number; width: number; height: number };
}

/**
 * The visible window for the GL preview at a given zoom/pan, in the displayed
 * (oriented+cropped) image of `imgW×imgH`. Mirrors `deriveView`'s visible-region
 * math but returns the shader UV window, the bounded canvas backing size, and the
 * on-screen CSS rect the canvas should occupy (the image's viewport-clipped box).
 * Identity (`off=[0,0], scale=[1,1]`) at fit/100%-fitting zoom.
 */
export function viewWindow(
  scale: number, cx: number, cy: number,
  imgW: number, imgH: number, vpW: number, vpH: number,
  dpr: number, maxBacking: number,
): ViewWindow {
  const visW = Math.min(vpW / scale, imgW);
  const visH = Math.min(vpH / scale, imgH);
  const x = clamp(cx - visW / 2, 0, Math.max(0, imgW - visW));
  const y = clamp(cy - visH / 2, 0, Math.max(0, imgH - visH));
  // On-screen position of the visible region: image origin is at vpW/2 - cx*scale.
  const left = vpW / 2 + (x - cx) * scale;
  const top = vpH / 2 + (y - cy) * scale;
  const width = visW * scale;
  const height = visH * scale;
  return {
    off: [x / imgW, y / imgH],
    scale: [visW / imgW, visH / imgH],
    backing: aspectCappedBacking(width * dpr, height * dpr, maxBacking),
    css: { left, top, width, height },
  };
}
