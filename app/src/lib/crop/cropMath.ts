import type { Rect, Handle } from "./types";

export const MIN = 0.05; // minimum normalized box size

export interface ScreenRect { left: number; top: number; width: number; height: number }

/** Normalized rect → screen px rect within the image's screen rect. */
export function toScreen(r: Rect, img: ScreenRect): ScreenRect {
  return {
    left: img.left + r.x * img.width,
    top: img.top + r.y * img.height,
    width: r.w * img.width,
    height: r.h * img.height,
  };
}

/** Container px point → normalized image point (clamped 0..1). */
export function toNorm(px: number, py: number, img: ScreenRect): [number, number] {
  const nx = (px - img.left) / Math.max(1, img.width);
  const ny = (py - img.top) / Math.max(1, img.height);
  return [Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny))];
}

/** Which handle (if any) is under a container-px point. `tol` in px. */
export function handleAt(px: number, py: number, box: ScreenRect, tol: number): Handle {
  const l = box.left, t = box.top, rgt = box.left + box.width, b = box.top + box.height;
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const near = (a: number, bb: number) => Math.abs(a - bb) <= tol;
  const onL = near(px, l), onR = near(px, rgt), onT = near(py, t), onB = near(py, b);
  const midX = near(px, cx), midY = near(py, cy);
  const inX = px >= l - tol && px <= rgt + tol, inY = py >= t - tol && py <= b + tol;
  if (onL && onT) return "nw"; if (onR && onT) return "ne";
  if (onL && onB) return "sw"; if (onR && onB) return "se";
  if (onT && midX && inX) return "n"; if (onB && midX && inX) return "s";
  if (onL && midY && inY) return "w"; if (onR && midY && inY) return "e";
  if (px > l && px < rgt && py > t && py < b) return "move";
  return null;
}

/** Apply a normalized drag delta for a handle. aspect=w/h locks the ratio. */
export function applyDrag(h: Handle, r: Rect, dnx: number, dny: number, aspect: number | null): Rect {
  if (h === "move") return clampRect({ ...r, x: r.x + dnx, y: r.y + dny }, true);
  let { x, y, w, hh } = { x: r.x, y: r.y, w: r.w, hh: r.h };
  const east = h === "e" || h === "ne" || h === "se";
  const west = h === "w" || h === "nw" || h === "sw";
  const south = h === "s" || h === "se" || h === "sw";
  const north = h === "n" || h === "ne" || h === "nw";
  if (east) w += dnx;
  if (west) { x += dnx; w -= dnx; }
  if (south) hh += dny;
  if (north) { y += dny; hh -= dny; }
  if (aspect != null) {
    if (h === "e" || h === "w") { const nh = w / aspect; y += (hh - nh) / 2; hh = nh; }
    else if (h === "n" || h === "s") { const nw = hh * aspect; x += (w - nw) / 2; w = nw; }
    else {
      const nh = w / aspect;
      if (north) y += hh - nh;
      hh = nh;
    }
  }
  return clampRect({ x, y, w, h: hh });
}

/** Clamp into [0,1] with a MIN size. When move=true, preserve size (just shift). */
export function clampRect(r: Rect, move = false): Rect {
  if (move) {
    const w = Math.min(r.w, 1), h = Math.min(r.h, 1);
    return { w, h, x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)) };
  }
  let { x, y, w, h } = r;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  w = Math.max(MIN, Math.min(1, w));
  h = Math.max(MIN, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

/** Centered rect of a target aspect (w/h) fitting within [0,1], ~80% of the frame. */
export function conform(r: Rect, aspect: number): Rect {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let w = Math.min(r.w, 1), h = w / aspect;
  if (h > 1) { h = 1; w = h * aspect; }
  if (w > 1) { w = 1; h = w / aspect; }
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h });
}

/** Default centered 80% rect with the native aspect ratio (w/h). */
export function default80(nativeRatio: number): Rect {
  let w = 0.8, h = 0.8;
  if (nativeRatio >= 1) h = w / nativeRatio; else w = h * nativeRatio;
  return clampRect({ x: 0.5 - w / 2, y: 0.5 - h / 2, w, h });
}
