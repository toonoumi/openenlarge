import { describe, it, expect } from "vitest";
import { defaultParams, type InvertParams } from "../api";
import { applyRollDelta, rollPreviewFrame } from "./apply";

const frame = (over: Partial<InvertParams>): InvertParams => ({ ...defaultParams(), ...over });

describe("relative roll adjustment", () => {
  it("applies a scalar offset on top of each frame, preserving per-frame differences", () => {
    const edits = { a: frame({ contrast: 10 }), b: frame({ contrast: 30 }) };
    const draft = frame({ contrast: 20 }); // +20 offset from neutral 0
    const applied = defaultParams(); // nothing baked in yet
    const out = applyRollDelta(edits, ["a", "b"], draft, applied);
    expect(out.a.contrast).toBe(30); // 10 + 20
    expect(out.b.contrast).toBe(50); // 30 + 20 — the 20-unit per-frame gap survives
  });

  it("is a no-op when the draft equals the applied offset (delta 0)", () => {
    const edits = { a: frame({ contrast: 10, exposure: 0.5 }) };
    const draft = frame({ contrast: 20, exposure: 1 });
    const out = applyRollDelta(edits, ["a"], draft, draft); // applied === draft
    expect(out.a.contrast).toBe(10);
    expect(out.a.exposure).toBe(0.5);
  });

  it("clamps the result to the slider range", () => {
    const edits = { a: frame({ contrast: 95 }) };
    const out = applyRollDelta(edits, ["a"], frame({ contrast: 30 }), defaultParams());
    expect(out.a.contrast).toBe(100); // 95 + 30 clamped to 100
  });

  it("treats temp/exposure as relative offsets from their neutrals", () => {
    const edits = { a: frame({ temp: 5500, exposure: 0.2 }), b: frame({ temp: 5200, exposure: -0.3 }) };
    const draft = frame({ temp: 6500, exposure: 1 }); // +1000 K, +1 EV
    const out = applyRollDelta(edits, ["a", "b"], draft, defaultParams());
    expect(out.a.temp).toBe(6500);
    expect(out.b.temp).toBe(6200);
    expect(out.a.exposure).toBeCloseTo(1.2);
    expect(out.b.exposure).toBeCloseTo(0.7);
  });

  it("only folds the incremental delta when an offset is already applied", () => {
    const edits = { a: frame({ contrast: 30 }) }; // already has +20 baked in (10 -> 30)
    const applied = frame({ contrast: 20 });
    const draft = frame({ contrast: 35 }); // user nudged the roll slider 20 -> 35
    const out = applyRollDelta(edits, ["a"], draft, applied);
    expect(out.a.contrast).toBe(45); // 30 + (35 - 20)
  });

  it("does not touch per-image fields excluded from the look (base_override)", () => {
    const edits = { a: frame({ base_override: [0.9, 0.55, 0.35], contrast: 10 }) };
    const out = applyRollDelta(edits, ["a"], frame({ contrast: 20 }), defaultParams());
    expect(out.a.base_override).toEqual([0.9, 0.55, 0.35]);
  });

  it("rollPreviewFrame matches the persist math for one frame", () => {
    const f = frame({ contrast: 10, saturation: -5 });
    const draft = frame({ contrast: 20, saturation: 10 });
    const prev = rollPreviewFrame(f, draft, defaultParams());
    expect(prev.contrast).toBe(30);
    expect(prev.saturation).toBe(5);
  });
});
