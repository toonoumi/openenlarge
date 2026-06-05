import { describe, it, expect } from "vitest";
import { toneLutBytes, colorGrade, colorMix } from "./finish";
import { defaultParams, type InvertParams } from "../api";

const P = (over: Partial<InvertParams> = {}): InvertParams => ({ ...defaultParams(), ...over });

describe("toneLutBytes", () => {
  it("default params give a 256-entry RGBA ramp", () => {
    const lut = toneLutBytes(P());
    expect(lut.length).toBe(256 * 4);
    expect(lut[0]).toBe(0);
    expect(lut[255 * 4]).toBe(255);
    expect(lut[128 * 4]).toBe(128); // R channel midpoint
    expect(lut[3]).toBe(255); // alpha
  });

  it("tc_shadows lifts the shadow zone, leaves mid ~flat", () => {
    const lut = toneLutBytes(P({ tc_shadows: 100 }));
    const sh = lut[Math.round(0.125 * 255) * 4];
    const mid = lut[128 * 4];
    expect(sh).toBeGreaterThan(0.125 * 255);
    expect(Math.abs(mid - 128)).toBeLessThan(8);
  });

  it("tolerates params missing the curve fields (old stored blob)", () => {
    // Simulate an edits blob saved before tone-curve fields existed.
    const stale = { ...defaultParams() } as Record<string, unknown>;
    delete stale.tc_curve; delete stale.tc_red; delete stale.tc_green; delete stale.tc_blue;
    delete stale.tc_shadows;
    const lut = toneLutBytes(stale as unknown as InvertParams);
    expect(lut.length).toBe(256 * 4);
    expect(lut[0]).toBe(0);
    expect(lut[255 * 4]).toBe(255); // identity ramp, not all-zero (black)
  });

  it("a red point curve only moves the red channel", () => {
    const lut = toneLutBytes(P({ tc_red: [[0, 0], [0.5, 0.7], [1, 1]] }));
    const i = 128 * 4;
    expect(lut[i]).toBeGreaterThan(150);     // R lifted
    expect(Math.abs(lut[i + 1] - 128)).toBeLessThan(8); // G flat
    expect(Math.abs(lut[i + 2] - 128)).toBeLessThan(8); // B flat
  });
});

describe("colorMix", () => {
  it("default params yield identity uniforms", () => {
    const u = colorMix(defaultParams());
    expect(Array.from(u.cm_hue)).toEqual(new Array(8).fill(0));
    expect(Array.from(u.cm_sat)).toEqual(new Array(8).fill(0));
    expect(Array.from(u.cm_lum)).toEqual(new Array(8).fill(0));
    expect(u.pc_count).toBe(0);
  });

  it("packs a single sample and divides shifts by 100", () => {
    const p = defaultParams();
    p.pc_samples = [{ hue: 200, sat: 0.5, lum: 0.4, hue_shift: 50, sat_shift: -100,
      lum_shift: 0, variance: 0, range: 50 }];
    const u = colorMix(p);
    expect(u.pc_count).toBe(1);
    expect(u.pc_hue[0]).toBeCloseTo(200);
    expect(u.pc_hue_shift[0]).toBeCloseTo(0.5);
    expect(u.pc_sat_shift[0]).toBeCloseTo(-1);
  });
});

describe("colorGrade", () => {
  it("default params give zero offsets and default mask edges", () => {
    const cg = colorGrade(P());
    for (const v of cg.sh_off) expect(v).toBeCloseTo(0, 6);
    expect(cg.glob_lum).toBe(0);
    expect(cg.sh_edge).toBeCloseTo(0.33);
    expect(cg.hi_edge).toBeCloseTo(0.66);
    expect(cg.softness).toBeCloseTo(0.25); // blending 50 → 0.1 + 0.3*0.5
  });

  it("balance shifts both mask edges; blending widens softness", () => {
    const cg = colorGrade(P({ cg_balance: 100, cg_blending: 100 }));
    expect(cg.sh_edge).toBeCloseTo(0.58);
    expect(cg.hi_edge).toBeCloseTo(0.91);
    expect(cg.softness).toBeCloseTo(0.4);
  });

  it("a saturated shadows wheel produces a nonzero chroma offset", () => {
    const cg = colorGrade(P({ cg_sh_hue: 0, cg_sh_sat: 100 }));
    expect(cg.sh_off[0]).toBeGreaterThan(0); // red pushed up
    expect(cg.sh_off[2]).toBeLessThan(0);    // blue pulled down
  });
});
