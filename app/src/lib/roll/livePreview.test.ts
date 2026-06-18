// app/src/lib/roll/livePreview.test.ts
import { describe, it, expect } from "vitest";
import { defaultParams } from "../api";
import { livePreviewParams, draftThumbView } from "./livePreview";
import type { CropRect } from "../crop/types";

describe("livePreviewParams", () => {
  it("takes tone/color from the draft but base/dmax from the frame", () => {
    const draft = { ...defaultParams(), contrast: 40, base_override: [9, 9, 9] as [number, number, number], d_max_override: 7 };
    const frame = { ...defaultParams(), base_override: [0.3, 0.3, 0.3] as [number, number, number], d_max_override: 2 };
    const out = livePreviewParams(draft, frame);
    expect(out.contrast).toBe(40);                  // from draft
    expect(out.base_override).toEqual([0.3, 0.3, 0.3]); // from frame
    expect(out.d_max_override).toBe(2);             // from frame
  });
});

describe("draftThumbView", () => {
  it("maps a CropRect to a ThumbView", () => {
    const crop: CropRect = { rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, aspect: "custom", orientation: "landscape", rot90: 1, flipH: true, flipV: false, angle: 3 };
    expect(draftThumbView(crop)).toEqual({
      image_crop: [0.1, 0.2, 0.5, 0.6], rot90: 1, flip_h: true, flip_v: false, angle: 3,
    });
  });

  it("maps null to a full-frame view", () => {
    expect(draftThumbView(null)).toEqual({ image_crop: null, rot90: 0, flip_h: false, flip_v: false, angle: 0 });
  });
});
