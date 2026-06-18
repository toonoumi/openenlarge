export interface Tile { x: number; y: number; w: number; h: number }
export interface SheetLayout { width: number; height: number; cols: number; rows: number; tiles: Tile[] }

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
