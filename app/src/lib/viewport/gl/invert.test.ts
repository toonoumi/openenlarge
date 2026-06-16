import { describe, it, expect } from "vitest";
import { toInversionUniforms, type ResolvedInversion } from "./invert";

const RES: ResolvedInversion = {
  base: [0.8, 0.6, 0.4],
  wb: [1.1, 1.0, 0.9],
  m_pre: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  m_post: [2, 0, 0, 0, 1, 0, 0, 0, 1],
  exposure: 2.0,
  black: 0.05,
  gamma: 0.4545,
  mode: 0,
  d_max: 2.0,
  print_exposure: 1.0,
  paper_black: 0.0,
  paper_grade: 0.5,
  soft_clip: 0.9,
  positive: false,
};

describe("positive flag", () => {
  const base: ResolvedInversion = {
    base: [0.7, 0.6, 0.5], wb: [1, 1, 1], m_pre: Array(9).fill(0), m_post: Array(9).fill(0),
    exposure: 1, black: 0, gamma: 0.4545, mode: 3, d_max: 1.5,
    print_exposure: 1, paper_black: 0, paper_grade: 0.95, soft_clip: 0.9, positive: true,
  };
  it("round-trips positive through toInversionUniforms", () => {
    expect(toInversionUniforms(base).positive).toBe(true);
  });
});

describe("toInversionUniforms", () => {
  it("passes scalars through and builds Float32Array mat3s", () => {
    const u = toInversionUniforms(RES);
    expect(u.exposure).toBe(2.0);
    expect(u.black).toBeCloseTo(0.05);
    expect(u.gamma).toBeCloseTo(0.4545);
    expect(u.mode).toBe(0);
    expect(u.d_max).toBeCloseTo(2.0);
    expect(u.print_exposure).toBeCloseTo(1.0);
    expect(u.paper_grade).toBeCloseTo(0.5);
    expect(u.soft_clip).toBeCloseTo(0.9);
    expect(u.paper_black).toBeCloseTo(0.0);
    expect(Array.from(u.base)).toEqual(Array.from(new Float32Array([0.8, 0.6, 0.4])));
    expect(Array.from(u.wb)).toEqual(Array.from(new Float32Array([1.1, 1.0, 0.9])));
    expect(u.m_post).toBeInstanceOf(Float32Array);
    expect(u.m_post.length).toBe(9);
    expect(Array.from(u.m_post)).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});
