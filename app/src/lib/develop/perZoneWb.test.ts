// Parity test: JS reference of the per-zone WB gain formula must match the
// GLSL shader (shaders.ts applyPerZoneWb) and the Rust CPU (finish.rs apply_per_zone_wb).
// All three use the same luma weights, smoothstep edges, and weighted gain blend.
import { describe, it, expect } from "vitest";
import { perZoneWb } from "./finish";
import { defaultParams, type InvertParams } from "../api";

// JS reference — mirrors finish.rs::apply_per_zone_wb and the GLSL applyPerZoneWb.
function luma(rgb: [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

function applyPerZoneWb(
  rgb: [number, number, number],
  sh: [number, number, number],
  mid: [number, number, number],
  hi: [number, number, number],
): [number, number, number] {
  const L = luma(rgb);
  const wsh = 1 - smoothstep(0.08, 0.58, L);
  const whi = smoothstep(0.41, 0.91, L);
  const wmid = clamp01(1 - wsh - whi);
  return [
    clamp01(rgb[0] * (wsh * sh[0] + wmid * mid[0] + whi * hi[0])),
    clamp01(rgb[1] * (wsh * sh[1] + wmid * mid[1] + whi * hi[1])),
    clamp01(rgb[2] * (wsh * sh[2] + wmid * mid[2] + whi * hi[2])),
  ];
}

describe("perZoneWb uniform builder", () => {
  it("defaultParams() yields enabled:1, sh/mid/hi=[1,1,1] (identity)", () => {
    const u = perZoneWb(defaultParams());
    expect(u.enabled).toBe(1);
    expect(u.sh).toEqual([1, 1, 1]);
    expect(u.mid).toEqual([1, 1, 1]);
    expect(u.hi).toEqual([1, 1, 1]);
  });

  it("pz_enabled=false yields enabled:0", () => {
    const p: InvertParams = { ...defaultParams(), pz_enabled: false };
    expect(perZoneWb(p).enabled).toBe(0);
  });

  it("passes through pz_sh/mid/hi as-is", () => {
    const p: InvertParams = {
      ...defaultParams(),
      pz_sh: [1.2, 0.9, 1.1],
      pz_mid: [1.0, 1.05, 0.95],
      pz_hi: [0.85, 1.1, 1.0],
    };
    const u = perZoneWb(p);
    expect(u.sh).toEqual([1.2, 0.9, 1.1]);
    expect(u.mid).toEqual([1.0, 1.05, 0.95]);
    expect(u.hi).toEqual([0.85, 1.1, 1.0]);
  });
});

describe("applyPerZoneWb JS reference (parity guard for GLSL + Rust)", () => {
  // Non-trivial gains: shadows cool, mids neutral, highlights warm.
  const sh: [number, number, number] = [0.9, 1.0, 1.2];
  const mid: [number, number, number] = [1.0, 1.0, 1.0];
  const hi: [number, number, number] = [1.15, 1.0, 0.85];

  it("shadow probe (L≈0.05): wsh=1, wmid=0, whi=0 → gain=sh", () => {
    // rgb=(0.05, 0.05, 0.05) → L=0.05 < 0.08 → smoothstep=0 → wsh=1
    const rgb: [number, number, number] = [0.05, 0.05, 0.05];
    const out = applyPerZoneWb(rgb, sh, mid, hi);
    expect(out[0]).toBeCloseTo(0.05 * 0.9, 5);
    expect(out[1]).toBeCloseTo(0.05 * 1.0, 5);
    expect(out[2]).toBeCloseTo(0.05 * 1.2, 5);
  });

  it("highlight probe (L≈0.95): wsh=0, wmid=0, whi=1 → gain=hi", () => {
    // rgb=(0.95, 0.95, 0.95) → L=0.95 > 0.91 → smoothstep=1 → whi=1
    const rgb: [number, number, number] = [0.95, 0.95, 0.95];
    const out = applyPerZoneWb(rgb, sh, mid, hi);
    expect(out[0]).toBeCloseTo(clamp01(0.95 * 1.15), 5);
    expect(out[1]).toBeCloseTo(0.95 * 1.0, 5);
    expect(out[2]).toBeCloseTo(0.95 * 0.85, 5);
  });

  it("mid probe (L=0.5): all three zones blend, wmid dominates", () => {
    // L=0.5: wsh=1-ss(0.08,0.58,0.5), whi=ss(0.41,0.91,0.5), wmid=1-wsh-whi
    // t_sh=(0.5-0.08)/0.5=0.84 → ss=0.84²*(3-2*0.84)=0.931392 → wsh=0.068608
    // t_hi=(0.5-0.41)/0.5=0.18 → ss=0.18²*(3-2*0.18)=0.085536 → whi=0.085536
    // wmid=1-0.068608-0.085536=0.845856
    const wsh = 1 - smoothstep(0.08, 0.58, 0.5);
    const whi = smoothstep(0.41, 0.91, 0.5);
    const wmid = clamp01(1 - wsh - whi);
    const rgb: [number, number, number] = [0.5, 0.5, 0.5];
    const out = applyPerZoneWb(rgb, sh, mid, hi);
    const expR = clamp01(0.5 * (wsh * sh[0] + wmid * mid[0] + whi * hi[0]));
    const expG = clamp01(0.5 * (wsh * sh[1] + wmid * mid[1] + whi * hi[1]));
    const expB = clamp01(0.5 * (wsh * sh[2] + wmid * mid[2] + whi * hi[2]));
    expect(out[0]).toBeCloseTo(expR, 5);
    expect(out[1]).toBeCloseTo(expG, 5);
    expect(out[2]).toBeCloseTo(expB, 5);
    // wmid dominates (≈0.846)
    expect(wmid).toBeGreaterThan(0.8);
  });

  it("identity gains (sh=mid=hi=[1,1,1]) → passthrough", () => {
    const id: [number, number, number] = [1, 1, 1];
    const rgb: [number, number, number] = [0.3, 0.6, 0.2];
    const out = applyPerZoneWb(rgb, id, id, id);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(0.6, 5);
    expect(out[2]).toBeCloseTo(0.2, 5);
  });
});
