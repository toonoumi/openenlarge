import type { CropRect } from "../crop/types";
import type { DustEdits } from "../develop/dust";
import type { ThumbView } from "../api";

/** Long-edge px for the boosted (zoomed-in) Library grid thumbnail. */
export const GRID_HIRES_EDGE = 1080;
/** Long-edge px for the static (catalog) grid thumbnail — matches the backend
 * develop-time THUMB_EDGE, so a lazily regenerated thumbnail matches a fresh develop. */
export const GRID_STATIC_EDGE = 320;
/** At/below this many columns the cells are large enough to warrant a hi-res render. */
export const GRID_HIRES_MAX_COLS = 2;

/**
 * Effective column count of a CSS `auto-fill` grid whose tracks are
 * `minmax(minCol, 1fr)` with `gap` between them inside a `containerW`-wide,
 * `padX`-padded scroll area. Mirrors the browser's track-filling math so the
 * frontend can know when cells get big. Always ≥ 1.
 */
export function gridColumns(containerW: number, minCol: number, padX: number, gap: number): number {
  const avail = containerW - padX + gap; // each track contributes (minCol + gap)
  return Math.max(1, Math.floor(avail / (minCol + gap)));
}

/**
 * Per-image `ThumbView` for a hi-res grid render: persistent geometry (crop,
 * orientation, straighten) + dust/IR, capped at `edge`. Matches what the
 * Develop refreshThumb / Roll sheet send, so the boosted cell shows the same look.
 */
export function gridThumbView(
  crop: CropRect | null | undefined,
  dust: DustEdits | null | undefined,
  edge: number,
): ThumbView {
  const view: ThumbView = {
    image_crop: crop ? [crop.rect.x, crop.rect.y, crop.rect.w, crop.rect.h] : null,
    rot90: crop?.rot90 ?? 0,
    flip_h: crop?.flipH ?? false,
    flip_v: crop?.flipV ?? false,
    angle: crop?.angle ?? 0,
    edge,
  };
  if (dust) {
    view.dust = dust.strokes;
    view.ir_removal = dust.irRemoval;
  }
  return view;
}
