// TS mirror of the tone-curve composition and color-grading setup in
// crates/film-core/src/finish.rs. The composed tone LUT and the per-region color
// offsets are computed here (CPU/JS) and handed to the GPU; the shader applies the
// LUT lookup and the per-pixel grading. Keep the constants/math identical to
// finish.rs so the live preview matches thumbnails/export.

import { curveLut, sampleLut, LUT_SIZE } from "./curve";
import { IDENTITY_CURVE, CM_BANDS, type CurvePoint, type InvertParams, type PointColorSample } from "../api";

/** Fall back to the identity curve if a stored curve is missing/degenerate. */
const safeCurve = (c: CurvePoint[] | undefined | null): CurvePoint[] =>
  Array.isArray(c) && c.length >= 2 ? c : IDENTITY_CURVE;

/** Coerce a possibly-missing numeric field to a finite number (default 0). */
const num = (v: number | undefined | null): number => (typeof v === "number" && isFinite(v) ? v : 0);

// --- Tone Curve region constants (mirror finish.rs). ---
const REGION_GAIN = 0.25;
const REGION_WIDTH = 0.22;
const REGION_CENTERS = [0.125, 0.375, 0.625, 0.875]; // shadows, darks, lights, highlights

// --- Color Grading constants (mirror finish.rs). ---
const CG_COLOR_GAIN = 0.5;
const CG_LUM_GAIN = 0.3;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function regionBump(v: number, c: number): number {
  const t = (v - c) / REGION_WIDTH;
  return Math.max(0, 1 - t * t);
}

/** Apply the four parametric region sliders (−1..1) to a value in [0,1].
 *  `regions` ordered [shadows, darks, lights, highlights]. */
function parametric(v: number, regions: number[]): number {
  v = clamp01(v);
  for (let k = 0; k < 4; k++) v += regions[k] * REGION_GAIN * regionBump(v, REGION_CENTERS[k]);
  return clamp01(v);
}

/** Build the composed tone LUT as a 256×1 RGBA8 byte array (R=lut_r, etc.). */
export function toneLutBytes(p: InvertParams): Uint8Array {
  const regions = [num(p.tc_shadows) / 100, num(p.tc_darks) / 100, num(p.tc_lights) / 100, num(p.tc_highlights) / 100];
  const m = curveLut(safeCurve(p.tc_curve));
  const r = curveLut(safeCurve(p.tc_red));
  const g = curveLut(safeCurve(p.tc_green));
  const b = curveLut(safeCurve(p.tc_blue));
  const out = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    const base = sampleLut(m, parametric(x, regions));
    out[i * 4 + 0] = Math.round(clamp01(sampleLut(r, base)) * 255);
    out[i * 4 + 1] = Math.round(clamp01(sampleLut(g, base)) * 255);
    out[i * 4 + 2] = Math.round(clamp01(sampleLut(b, base)) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

type Vec3 = [number, number, number];

function hsvHueRgb(h: number): Vec3 {
  h = (((h % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

const luma = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Chroma-only offset for one wheel: hue (deg) + sat (0..1) → zero-luma RGB push. */
function wheelOffset(hue: number, sat: number): Vec3 {
  const col = hsvHueRgb(hue);
  const y = luma(col);
  return [(col[0] - y) * sat * CG_COLOR_GAIN, (col[1] - y) * sat * CG_COLOR_GAIN, (col[2] - y) * sat * CG_COLOR_GAIN];
}

/** Precomputed color-grading uniforms (mirror finish.rs::ColorGrade). */
export interface ColorGradeUniforms {
  sh_off: Vec3; sh_lum: number;
  mid_off: Vec3; mid_lum: number;
  hi_off: Vec3; hi_lum: number;
  glob_off: Vec3; glob_lum: number;
  sh_edge: number; hi_edge: number; softness: number;
}

export function colorGrade(p: InvertParams): ColorGradeUniforms {
  const lum = (v: number) => (num(v) / 100) * CG_LUM_GAIN;
  const balance = num(p.cg_balance) / 100;
  return {
    sh_off: wheelOffset(num(p.cg_sh_hue), num(p.cg_sh_sat) / 100), sh_lum: lum(p.cg_sh_lum),
    mid_off: wheelOffset(num(p.cg_mid_hue), num(p.cg_mid_sat) / 100), mid_lum: lum(p.cg_mid_lum),
    hi_off: wheelOffset(num(p.cg_hi_hue), num(p.cg_hi_sat) / 100), hi_lum: lum(p.cg_hi_lum),
    glob_off: wheelOffset(num(p.cg_glob_hue), num(p.cg_glob_sat) / 100), glob_lum: lum(p.cg_glob_lum),
    sh_edge: 0.33 + balance * 0.25,
    hi_edge: 0.66 + balance * 0.25,
    softness: 0.1 + 0.3 * (num(p.cg_blending) / 100),
  };
}

/** Packed Color Mixer uniforms for the GPU (mirror finish.rs::ColorMix). Mixer
 *  slider values are pre-divided by 100; sample shifts too. Arrays are length 8;
 *  Point Color slots beyond pc_count are zero-filled. */
export interface ColorMixUniforms {
  cm_hue: Float32Array; cm_sat: Float32Array; cm_lum: Float32Array;
  pc_count: number;
  pc_hue: Float32Array; pc_sat: Float32Array; pc_lum: Float32Array;
  pc_hue_shift: Float32Array; pc_sat_shift: Float32Array; pc_lum_shift: Float32Array;
  pc_variance: Float32Array; pc_range: Float32Array;
}

export function colorMix(p: InvertParams): ColorMixUniforms {
  const cm_hue = new Float32Array(8);
  const cm_sat = new Float32Array(8);
  const cm_lum = new Float32Array(8);
  const pRec = p as unknown as Record<string, number>;
  CM_BANDS.forEach((b, i) => {
    cm_hue[i] = num(pRec[`cm_${b}_hue`]) / 100;
    cm_sat[i] = num(pRec[`cm_${b}_sat`]) / 100;
    cm_lum[i] = num(pRec[`cm_${b}_lum`]) / 100;
  });
  const mk = () => new Float32Array(8);
  const pc_hue = mk(), pc_sat = mk(), pc_lum = mk();
  const pc_hue_shift = mk(), pc_sat_shift = mk(), pc_lum_shift = mk();
  const pc_variance = mk(), pc_range = mk();
  const samples: PointColorSample[] = Array.isArray(p.pc_samples) ? p.pc_samples.slice(0, 8) : [];
  samples.forEach((s, i) => {
    pc_hue[i] = num(s.hue); pc_sat[i] = num(s.sat); pc_lum[i] = num(s.lum);
    pc_hue_shift[i] = num(s.hue_shift) / 100;
    pc_sat_shift[i] = num(s.sat_shift) / 100;
    pc_lum_shift[i] = num(s.lum_shift) / 100;
    pc_variance[i] = num(s.variance);
    pc_range[i] = num(s.range);
  });
  return { cm_hue, cm_sat, cm_lum, pc_count: samples.length,
    pc_hue, pc_sat, pc_lum, pc_hue_shift, pc_sat_shift, pc_lum_shift, pc_variance, pc_range };
}
