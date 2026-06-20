export interface Tile { x: number; y: number; w: number; h: number }
export interface SheetLayout { width: number; height: number; cols: number; rows: number; tiles: Tile[] }

/** Contact-sheet tiles are a fixed LANDSCAPE aspect (35mm 3:2). A frame of any
 *  orientation — including a portrait crop — occupies a landscape tile and is fit
 *  INSIDE it (letterboxed/centered), so portrait frames never inflate row height.
 *  Mirrors Lightroom's uniform grid. Keep in sync with the `aspect-ratio` on
 *  Roll.svelte's `.frame-cell` / `.proof-frame`. */
export const TILE_ASPECT = 3 / 2;

/** Choose the contact-sheet tile aspect (w/h) from the roll's frame aspects so
 *  landscape frames fill their tile with no side gaps. Uses the MEDIAN of
 *  landscape frames (aspect ≥ 1) — a roll is one camera, so they share a shape;
 *  the median resists the odd cropped frame. Falls back to all frames, then to
 *  TILE_ASPECT (empty roll). Portrait frames pillarbox inside the landscape tile. */
export function pickTileAspect(aspects: number[]): number {
  const valid = aspects.filter((a) => a > 0 && Number.isFinite(a));
  const land = valid.filter((a) => a >= 1);
  const pool = land.length ? land : valid;
  if (pool.length === 0) return TILE_ASPECT;
  const s = [...pool].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Contain-fit an `iw`×`ih` image inside a `boxW`×`boxH` box. Vertically centered;
 *  horizontal alignment is `alignX` ("left" = flush left, no leading gap; "center").
 *  Keeps the on-screen tiles' `object-position` in sync. Returns the destination
 *  rect (offset + size) for ctx.drawImage. */
export function fitContain(
  iw: number,
  ih: number,
  boxW: number,
  boxH: number,
  alignX: "left" | "center" = "center",
): { dx: number; dy: number; dw: number; dh: number } {
  if (iw <= 0 || ih <= 0) return { dx: 0, dy: 0, dw: boxW, dh: boxH };
  const scale = Math.min(boxW / iw, boxH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return { dx: alignX === "left" ? 0 : (boxW - dw) / 2, dy: (boxH - dh) / 2, dw, dh };
}

/** Lay out `count` equal tiles in a `cols`-wide grid with uniform gaps + margin.
 * Pure geometry — pixel coordinates for a canvas compositor. */
export function layoutContactSheet(
  count: number,
  opts: { cols: number; tileW: number; tileH: number; gap: number; margin: number },
): SheetLayout {
  const { cols, tileW, tileH, gap, margin } = opts;
  const rows = Math.ceil(count / cols);
  const width = 2 * margin + cols * tileW + (cols - 1) * gap;
  const height = 2 * margin + (rows === 0 ? 0 : rows * tileH + (rows - 1) * gap);
  const tiles: Tile[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    tiles.push({ x: margin + c * (tileW + gap), y: margin + r * (tileH + gap), w: tileW, h: tileH });
  }
  return { width, height, cols, rows, tiles };
}
