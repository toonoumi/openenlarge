/**
 * Compute the zoom needed to fit a marquee rectangle (two image-space corner
 * points) into the padded viewport.
 *
 * @param ax,ay  first corner, image-space px
 * @param bx,by  second corner, image-space px (any order vs the first)
 * @param avW,avH  padded available viewport size, display px
 * @param fit  fit-to-view scale (lower clamp)
 * @param max  maximum zoom scale (upper clamp), default 8
 * @returns scale (display px per image px) and the rectangle's image-space center
 */
export function marqueeZoom(
  ax: number, ay: number, bx: number, by: number,
  avW: number, avH: number, fit: number, max = 8,
): { scale: number; cx: number; cy: number } {
  const rw = Math.max(1e-6, Math.abs(bx - ax));
  const rh = Math.max(1e-6, Math.abs(by - ay));
  const want = Math.min(avW / rw, avH / rh);
  const scale = Math.min(max, Math.max(fit, want));
  return { scale, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
}
