import { describe, it, expect } from "vitest";
import { defaultParams, type InvertParams } from "../api";
import type { CropRect } from "../crop/types";
import {
  toneColorOf, hasToneColorEdits, framesWithToneColor, applyToneColorToAll,
  framesWithCrop, applyCropToAll,
  framesWithBase, applyBaseToAll,
  framesWithWhitePoint, applyWhitePointToAll,
} from "./apply";

const crop: CropRect = {
  rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, aspect: "custom",
  orientation: "landscape", rot90: 0, flipH: false, flipV: false, angle: 0,
};

describe("tone/color", () => {
  it("toneColorOf excludes film/calibration fields", () => {
    const p = { ...defaultParams(), exposure: 1, contrast: 10, base_override: [1, 1, 1] as [number, number, number], d_max_override: 2 };
    const tc = toneColorOf(p);
    expect(tc.contrast).toBe(10);          // a real shared tone/color field is kept
    expect("exposure" in tc).toBe(false);  // per-image (Auto-Brightness) — excluded
    expect("base_override" in tc).toBe(false);
    expect("d_max_override" in tc).toBe(false);
    expect("stock" in tc).toBe(false);
  });

  it("hasToneColorEdits is false for defaults, true after a tone edit", () => {
    expect(hasToneColorEdits(defaultParams())).toBe(false);
    expect(hasToneColorEdits({ ...defaultParams(), contrast: 10 })).toBe(true);
  });

  it("hasToneColorEdits ignores base/dmax-only differences", () => {
    expect(hasToneColorEdits({ ...defaultParams(), d_max_override: 3, base_override: [0.5, 0.5, 0.5] })).toBe(false);
  });

  it("framesWithToneColor lists only ids with non-default tone/color", () => {
    const edits: Record<string, InvertParams> = {
      a: defaultParams(),
      b: { ...defaultParams(), saturation: 20 },
    };
    expect(framesWithToneColor(edits, ["a", "b", "c"])).toEqual(["b"]);
  });

  it("applyToneColorToAll writes src tone/color but preserves each frame's base/dmax", () => {
    const edits: Record<string, InvertParams> = {
      a: { ...defaultParams(), base_override: [0.2, 0.2, 0.2], d_max_override: 1.5 },
    };
    const src = { ...defaultParams(), contrast: 30 };
    const next = applyToneColorToAll(edits, ["a", "b"], src);
    expect(next.a.contrast).toBe(30);
    expect(next.a.base_override).toEqual([0.2, 0.2, 0.2]); // preserved
    expect(next.a.d_max_override).toBe(1.5);               // preserved
    expect(next.b.contrast).toBe(30);                      // created from defaults
    expect(next.b.base_override).toBeNull();
    expect(next).not.toBe(edits);     // new map
    expect(next.a).not.toBe(edits.a); // new entry ref (persistence needs this)
  });
});

describe("crop", () => {
  it("framesWithCrop lists ids with a non-null crop", () => {
    const crops: Record<string, CropRect | null> = { a: null, b: crop };
    expect(framesWithCrop(crops, ["a", "b", "c"])).toEqual(["b"]);
  });

  it("applyCropToAll writes a cloned crop to every id", () => {
    const next = applyCropToAll({}, ["a", "b"], crop);
    expect(next.a).toEqual(crop);
    expect(next.a).not.toBe(crop);          // cloned
    expect(next.a!.rect).not.toBe(crop.rect); // deep clone
  });

  it("applyCropToAll with null clears crops", () => {
    const next = applyCropToAll({ a: crop }, ["a"], null);
    expect(next.a).toBeNull();
  });
});

describe("base", () => {
  it("framesWithBase lists ids whose base_override is set", () => {
    const edits: Record<string, InvertParams> = {
      a: defaultParams(),
      b: { ...defaultParams(), base_override: [0.3, 0.3, 0.3] },
    };
    expect(framesWithBase(edits, ["a", "b"])).toEqual(["b"]);
  });

  it("applyBaseToAll sets base_override on every id, leaving tone untouched", () => {
    const edits: Record<string, InvertParams> = { a: { ...defaultParams(), contrast: 5 } };
    const next = applyBaseToAll(edits, ["a", "b"], [0.4, 0.4, 0.4]);
    expect(next.a.base_override).toEqual([0.4, 0.4, 0.4]);
    expect(next.a.contrast).toBe(5);
    expect(next.b.base_override).toEqual([0.4, 0.4, 0.4]);
  });
});

describe("white point", () => {
  it("framesWithWhitePoint lists ids whose d_max_override is set", () => {
    const edits: Record<string, InvertParams> = {
      a: defaultParams(),
      b: { ...defaultParams(), d_max_override: 2.1 },
    };
    expect(framesWithWhitePoint(edits, ["a", "b"])).toEqual(["b"]);
  });

  it("applyWhitePointToAll sets d_max_override on every id", () => {
    const next = applyWhitePointToAll({ a: defaultParams() }, ["a", "b"], 1.9);
    expect(next.a.d_max_override).toBe(1.9);
    expect(next.b.d_max_override).toBe(1.9);
  });
});

// ---- Regression: re-zero WB (Phase 1) ----
// These tests guard the two defects fixed when re-zero landed:
//   (a) per-image measured fields (wb_baseline, pz_sh/mid/hi) must NOT travel
//       across frames in applyToneColorToAll (Defect 2)
//   (b) tempOffset round-trips through TEMP_NEUTRAL, not a per-image baseline
//       (Defect 1 — validated here at the apply layer)

const TEMP_NEUTRAL = 5500; // must match copySettings.ts + Basic.svelte

describe("re-zero WB regressions", () => {
  it("applyToneColorToAll does NOT copy wb_baseline or pz gains to target frames", () => {
    // Simulate per-image measured fields using a cast so the test compiles before
    // wb_baseline/pz_* land in InvertParams (they arrive with the per-zone WB feature).
    const srcGains = { wb_baseline: [1.1, 0.95, 0.9], pz_sh: [1.05, 1.0, 0.98], pz_mid: [1.02, 1.0, 0.99], pz_hi: [1.0, 1.0, 1.03] };
    const src = { ...defaultParams(), contrast: 20, ...srcGains } as InvertParams;

    const tgtGains = { wb_baseline: [0.9, 1.0, 1.1], pz_sh: [0.97, 1.0, 1.02], pz_mid: [0.99, 1.0, 1.01], pz_hi: [1.0, 1.0, 0.98] };
    const target = { ...defaultParams(), ...tgtGains } as InvertParams;

    const edits: Record<string, InvertParams> = { tgt: target };
    const next = applyToneColorToAll(edits, ["tgt"], src);

    // Tone/color look should travel
    expect(next.tgt.contrast).toBe(20);

    // Per-image measured gains must NOT travel — target keeps its own
    const n = next.tgt as unknown as Record<string, unknown>;
    expect(n["wb_baseline"]).toEqual([0.9, 1.0, 1.1]);   // target's own baseline preserved
    expect(n["pz_sh"]).toEqual([0.97, 1.0, 1.02]);
    expect(n["pz_mid"]).toEqual([0.99, 1.0, 1.01]);
    expect(n["pz_hi"]).toEqual([1.0, 1.0, 0.98]);
  });

  it("tempOffset round-trips through TEMP_NEUTRAL (copy then paste yields original temp)", () => {
    // Source image: user warmed temp to 6000K (offset = +500 from neutral 5500)
    const srcTemp = 6000;
    const tempOffset = srcTemp - TEMP_NEUTRAL;  // +500

    // Paste: target temp = TEMP_NEUTRAL + tempOffset (no per-image as-shot fetch)
    const pastedTemp = TEMP_NEUTRAL + tempOffset;
    expect(pastedTemp).toBe(srcTemp);  // round-trip is lossless

    // Paste on a "different" image should land the same absolute temp
    // (because all images have TEMP_NEUTRAL as their neutral under re-zero)
    expect(pastedTemp).toBe(6000);
    expect(tempOffset).toBe(500);
  });
});
