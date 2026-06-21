import { describe, it, expect } from "vitest";
import { defaultParams } from "./api";

describe("defaultParams", () => {
  // Regression guard for the blue-cast bug: a fresh frame must default to "gain"
  // WB. The auto-WB seed (`auto_seed_wb`) and the develop-time thumbnail bake both
  // produce/render gain-neutral temp/tint; defaulting to "subtractive" (color head)
  // applies those gain-tuned values pre-curve, leaving a cool/blue cast on every
  // freshly-developed frame. Keep this "gain" until the seed is made wb_mode-aware.
  it("defaults wb_mode to gain so fresh frames are neutral", () => {
    expect(defaultParams().wb_mode).toBe("gain");
  });
});
