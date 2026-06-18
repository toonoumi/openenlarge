import type { PointColorSample } from "../api";

/** Convert an sRGB byte pixel to a fresh Point Color sample (zeroed shifts). */
export function rgbToHslSample(r8: number, g8: number, b8: number): PointColorSample {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx - mn > 1e-7) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { hue: h, sat: s, lum: l,
    hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0, range: 50 };
}

/** A canvas (or canvas-like) backbuffer + CSS size, enough to map a cursor. */
export interface SampleDims {
  width: number; height: number; clientWidth: number; clientHeight: number;
}

/** Map a CSS-pixel cursor position (relative to the element's top-left) to a
 *  WebGL framebuffer sample coordinate. The GL origin is bottom-left, so y is
 *  flipped; both axes are clamped into the backbuffer. Returns null if the point
 *  falls outside the element. */
export function sampleCoords(d: SampleDims, cssX: number, cssY: number): { sx: number; sy: number } | null {
  if (cssX < 0 || cssY < 0 || cssX > d.clientWidth || cssY > d.clientHeight) return null;
  const sx = Math.min(d.width - 1, Math.max(0, Math.round(cssX * (d.width / d.clientWidth))));
  const syTop = Math.round(cssY * (d.height / d.clientHeight));
  const sy = Math.min(d.height - 1, Math.max(0, d.height - 1 - syTop)); // GL origin is bottom-left
  return { sx, sy };
}

/** Reads one pixel of CLEAN image data (no clip-warning overlay baked in). */
export interface PixelReader {
  readPixel(sx: number, sy: number): [number, number, number] | null;
}

/** Pick the displayed RGB under the cursor. `cssX`/`cssY` are relative to the
 *  CANVAS element's top-left. When a `reader` (the GL renderer) is supplied the
 *  value comes from a no-overlay readback pass, so the clip-warning overlay can
 *  never corrupt the picked color; otherwise it falls back to reading the
 *  composited backbuffer. Returns [r,g,b] bytes, or null if out of bounds. */
export function pickPixel(
  reader: PixelReader | null,
  canvas: HTMLCanvasElement,
  cssX: number, cssY: number,
): [number, number, number] | null {
  const c = sampleCoords(canvas, cssX, cssY);
  if (!c) return null;
  if (reader) return reader.readPixel(c.sx, c.sy);
  return readCanvasPixel(canvas, cssX, cssY);
}

/** Read one pixel from a WebGL2 canvas (created with preserveDrawingBuffer:true).
 *  `cssX`/`cssY` are coordinates relative to the CANVAS element's top-left.
 *  Returns [r,g,b] bytes, or null if out of bounds / no GL context.
 *  NOTE: reads the COMPOSITED backbuffer — the clip-warning overlay, if on, is
 *  baked in. Prefer pickPixel() with the renderer for clean image data. */
export function readCanvasPixel(canvas: HTMLCanvasElement, cssX: number, cssY: number): [number, number, number] | null {
  const c = sampleCoords(canvas, cssX, cssY);
  if (!c) return null;
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
  if (!gl) return null;
  const px = new Uint8Array(4);
  gl.readPixels(c.sx, c.sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return [px[0], px[1], px[2]];
}
