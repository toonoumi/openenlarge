// app/src/lib/roll/livePreview.ts
import type { InvertParams, ThumbView } from "../api";
import type { CropRect } from "../crop/types";
import { toneColorOf } from "./apply";

/** Preview params for one frame: the roll draft's tone/color look, but the frame's
 * own film base + white point (so the look is judged on each frame's calibration). */
export function livePreviewParams(draft: InvertParams, frame: InvertParams): InvertParams {
  return { ...frame, ...toneColorOf(draft) };
}

/** The draft crop geometry as a ThumbView for api.thumbnail. */
export function draftThumbView(crop: CropRect | null): ThumbView {
  return {
    image_crop: crop ? [crop.rect.x, crop.rect.y, crop.rect.w, crop.rect.h] : null,
    rot90: crop?.rot90 ?? 0, flip_h: crop?.flipH ?? false, flip_v: crop?.flipV ?? false, angle: crop?.angle ?? 0,
  };
}
