// Fullscreen-triangle vertex shader (no buffers; uses gl_VertexID).
export const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = uv;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

// Fragment shader: ports finish.rs. tone_curve + saturation + curve + grade per
// pixel. The texture (unsharp/clarity) effect is NOT done here — it needs a wide
// separable Gaussian, which would be far too costly to re-evaluate finish() for
// per tap. Instead this pass writes the finished color to an FBO (u_finish_mode
// == 1) and the separate USM_FRAG program blurs + unsharps it. When presenting
// directly (u_finish_mode == 0) it applies the clip-warning overlay.
export const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_lut;         // 256x1 composed tone LUT (R/G/B per channel)
uniform vec2 u_texel;            // 1/width, 1/height
uniform float u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_vibrance, u_saturation, u_texture;
uniform float u_brightness;      // brightness/density (−1..1); log-curve gain, pre-tone
// Color grading (precomputed offsets + masks; mirror finish.rs::ColorGrade).
uniform vec3 u_cg_sh_off, u_cg_mid_off, u_cg_hi_off, u_cg_glob_off;
uniform float u_cg_sh_lum, u_cg_mid_lum, u_cg_hi_lum, u_cg_glob_lum;
uniform float u_cg_sh_edge, u_cg_hi_edge, u_cg_soft;
// Color Mixer (HSL): per-band sliders pre-divided to unit. Band centers are const.
uniform float u_cm_hue[8];
uniform float u_cm_sat[8];
uniform float u_cm_lum[8];
// Point Color: up to 8 samples.
uniform int u_pc_count;
uniform float u_pc_hue[8];
uniform float u_pc_sat[8];
uniform float u_pc_lum[8];
uniform float u_pc_hue_shift[8];
uniform float u_pc_sat_shift[8];
uniform float u_pc_lum_shift[8];
uniform float u_pc_variance[8];
uniform float u_pc_range[8];

// Clipping-warning overlay (B1: OUTPUT detail-loss semantics). Enables only;
// the thresholds are derived from the engine soft-clip knee, not hard-coded
// display values — see clipCode().
uniform float u_clip_high_on;  // > 0.5 → paint blown highlights red
uniform float u_clip_low_on;   // > 0.5 → paint crushed shadows blue
uniform float u_clip_strict;   // > 0.5 → flag the ONSET of loss, not just true loss
uniform float u_soft_clip;     // engine highlight soft-clip knee (InversionParams.soft_clip)

// 0 = present to the bound framebuffer (apply clip overlay); 1 = write the plain
// finished color to an FBO for the texture (USM) pass to consume.
uniform int u_finish_mode;

float tone(float v) {
  v = clamp(v, 0.0, 1.0);
  v += u_whites * 0.20 * v * v * v;
  v += u_blacks * 0.20 * pow(1.0 - v, 3.0);
  // Shelf weights that peak AT the extremes (mirror finish.rs::tone_curve) so
  // Highlights/Shadows actually reach clipped highlights/shadows; gain 0.18 keeps
  // the curve monotonic even under opposing endpoint sliders.
  v += u_highlights * 0.18 * smoothstep(0.5, 1.0, v);
  v += u_shadows * 0.18 * (1.0 - smoothstep(0.0, 0.5, v));
  v = 0.5 + (v - 0.5) * (1.0 + u_contrast);
  return clamp(v, 0.0, 1.0);
}

vec3 colorGrade(vec3 rgb) {
  float L = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float wsh = 1.0 - smoothstep(u_cg_sh_edge - u_cg_soft, u_cg_sh_edge + u_cg_soft, L);
  float whi = smoothstep(u_cg_hi_edge - u_cg_soft, u_cg_hi_edge + u_cg_soft, L);
  float wmid = clamp(1.0 - wsh - whi, 0.0, 1.0);
  vec3 outc = rgb
    + wsh * (u_cg_sh_off + vec3(u_cg_sh_lum))
    + wmid * (u_cg_mid_off + vec3(u_cg_mid_lum))
    + whi * (u_cg_hi_off + vec3(u_cg_hi_lum))
    + (u_cg_glob_off + vec3(u_cg_glob_lum));
  return clamp(outc, 0.0, 1.0);
}

const float PI_F = 3.14159265358979;
const float BAND_CENTERS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0);
const float CM_FALLOFF_DEG = 50.0;
const float CM_HUE_SHIFT_MAX = 30.0;
const float CM_LUM_GAIN = 0.25;
const float CM_SAT_GATE_LO = 0.05;
const float CM_SAT_GATE_HI = 0.20;
const float PC_RANGE_MIN_DEG = 5.0;
const float PC_RANGE_MAX_DEG = 60.0;
const float PC_SAT_TOL = 0.25;
const float PC_LUM_TOL = 0.25;
const float PC_VAR_SPAN = 2.0;

vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  if (mx - mn < 1e-7) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h * 60.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(float h, float s, float l) {
  if (s <= 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float hk = h / 360.0;
  return vec3(hue2rgb(p, q, hk + 1.0/3.0), hue2rgb(p, q, hk), hue2rgb(p, q, hk - 1.0/3.0));
}
float wrap180(float d) {
  float x = mod(d + 180.0, 360.0) - 180.0;
  return x <= -180.0 ? x + 360.0 : x;
}
float bandWeight(float h, float center) {
  float d = abs(wrap180(h - center));
  return d >= CM_FALLOFF_DEG ? 0.0 : 0.5 * (1.0 + cos(PI_F * d / CM_FALLOFF_DEG));
}
vec3 colorMixer(vec3 rgb) {
  vec3 hsl = rgb2hsl(rgb);
  float h = hsl.x, s = hsl.y, l = hsl.z;
  float gate = smoothstep(CM_SAT_GATE_LO, CM_SAT_GATE_HI, s);
  float hueDelta = 0.0, satFactor = 1.0, lumDelta = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = bandWeight(h, BAND_CENTERS[i]);
    hueDelta += w * gate * u_cm_hue[i] * CM_HUE_SHIFT_MAX;
    satFactor += w * gate * u_cm_sat[i];
    lumDelta += w * u_cm_lum[i] * CM_LUM_GAIN;
  }
  return hsl2rgb(h + hueDelta, clamp(s * satFactor, 0.0, 1.0), clamp(l + lumDelta, 0.0, 1.0));
}
float pcTol(float base, float variance) {
  return max(0.02, base * (1.0 + (variance / 100.0) * PC_VAR_SPAN));
}
float pcHueWeight(float h, float target, float range) {
  float hw = PC_RANGE_MIN_DEG + (range / 100.0) * (PC_RANGE_MAX_DEG - PC_RANGE_MIN_DEG);
  float d = abs(wrap180(h - target));
  return d >= hw ? 0.0 : 0.5 * (1.0 + cos(PI_F * d / hw));
}
vec3 pointColor(vec3 rgb) {
  if (u_pc_count <= 0) return rgb;
  vec3 hsl = rgb2hsl(rgb);
  float h = hsl.x, s = hsl.y, l = hsl.z;
  float hueDelta = 0.0, satFactor = 1.0, lumDelta = 0.0;
  for (int k = 0; k < 8; k++) {
    if (k >= u_pc_count) break;
    float wh = pcHueWeight(h, u_pc_hue[k], u_pc_range[k]);
    if (wh <= 0.0) continue;
    float ws = clamp(1.0 - abs(s - u_pc_sat[k]) / pcTol(PC_SAT_TOL, u_pc_variance[k]), 0.0, 1.0);
    float wl = clamp(1.0 - abs(l - u_pc_lum[k]) / pcTol(PC_LUM_TOL, u_pc_variance[k]), 0.0, 1.0);
    float w = wh * ws * wl;
    hueDelta += w * u_pc_hue_shift[k] * CM_HUE_SHIFT_MAX;
    satFactor += w * u_pc_sat_shift[k];
    lumDelta += w * u_pc_lum_shift[k] * CM_LUM_GAIN;
  }
  return hsl2rgb(h + hueDelta, clamp(s * satFactor, 0.0, 1.0), clamp(l + lumDelta, 0.0, 1.0));
}
// Brightness/density slider span — MUST equal finish.rs BRIGHTNESS_DENSITY_RANGE
// so the GPU proxy preview matches the CPU full-res export.
const float BRIGHTNESS_DENSITY_RANGE = 0.5;

vec3 finishAt(vec2 uv) {
  // Brightness/density: log-curve gain (10^(b·RANGE)) before the tone curve, so
  // equal slider steps = equal density steps (mirror finish.rs::finish_pixel).
  vec3 c = texture(u_src, uv).rgb * pow(10.0, u_brightness * BRIGHTNESS_DENSITY_RANGE);
  vec3 t = vec3(tone(c.r), tone(c.g), tone(c.b));
  float y = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
  float mx = max(max(t.r, t.g), t.b);
  float mn = min(min(t.r, t.g), t.b);
  float cur = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  float f = 1.0 + u_saturation + u_vibrance * (1.0 - cur);
  vec3 s = clamp(vec3(y) + (t - vec3(y)) * f, 0.0, 1.0);
  // Tone curve LUT (per channel: sample at the channel's own value).
  vec3 cu = vec3(
    texture(u_lut, vec2(s.r, 0.5)).r,
    texture(u_lut, vec2(s.g, 0.5)).g,
    texture(u_lut, vec2(s.b, 0.5)).b);
  return pointColor(colorMixer(colorGrade(cu)));
}

// B1 — output detail-loss detection. With the filmic display curve the engine
// reaches true white at 1.0 and rolls off gently through a shoulder, so highlight
// detail is effectively gone once a channel sits deep in that shoulder (near 1.0);
// shadows are lost near black. 'src' is the inverted positive — post-engine,
// PRE-finish (texture(u_src)). Strict mode flags the ONSET (entering the shoulder /
// near-black). Returns a 2-bit code: bit1 (=2) highlight loss, bit0 (=1) shadow loss.
const float CLIP_LO = 2.0 / 255.0;
const float CLIP_LO_STRICT = 8.0 / 255.0;
const float CLIP_HI = 0.992;       // deep in the shoulder → highlight detail gone
const float CLIP_HI_STRICT = 0.96; // onset: entering the highlight shoulder
int clipCode(vec3 src) {
  float hiT = u_clip_strict > 0.5 ? CLIP_HI_STRICT : CLIP_HI;
  float loT = u_clip_strict > 0.5 ? CLIP_LO_STRICT : CLIP_LO;
  int code = 0;
  if (src.r >= hiT || src.g >= hiT || src.b >= hiT) code += 2;
  if (src.r <= loT || src.g <= loT || src.b <= loT) code += 1;
  return code;
}

vec3 clipOverlay(vec3 disp, int code) {
  if (u_clip_high_on > 0.5 && (code & 2) != 0) return vec3(1.0, 0.15, 0.15); // highlight → red
  if (u_clip_low_on  > 0.5 && (code & 1) != 0) return vec3(0.2, 0.45, 1.0);  // shadow → blue
  return disp;
}

void main() {
  vec3 c = finishAt(v_uv);
  int code = clipCode(texture(u_src, v_uv).rgb);
  // mode 1: hand the plain finished color to the USM pass, carrying the detail-loss
  // code in alpha (the USM pass can't see the inverted positive). No clip overlay.
  if (u_finish_mode == 1) { o = vec4(c, float(code)); return; }
  o = vec4(clipOverlay(c, code), 1.0);
}`;

// Texture (unsharp/clarity) blur sigma as a fraction of the smaller viewport
// dimension. MUST equal TEXTURE_SIGMA_FRAC in finish.rs so a CPU full-res export
// and a GPU (proxy) preview blur the same fraction of the frame. The renderer
// passes sigma = TEXTURE_SIGMA_FRAC * min(vw, vh) as u_sigma.
export const TEXTURE_SIGMA_FRAC = 0.0025;

// USM pass: separable Gaussian blur + unsharp composite of the finished color
// produced by FRAG (u_finish_mode == 1). Runs twice: u_mode 0 = horizontal blur
// (finishTex → scratch), u_mode 1 = vertical blur (→ full 2-D Gaussian) then
// out = clamp(center + k·(center − blur)) with the clip overlay. Mirrors
// finish.rs::apply_texture (same sigma, gain, clamp, edge-clamp). MAXR / POS_GAIN
// / NEG_GAIN MUST match TEXTURE_MAX_RADIUS / USM_POS_GAIN / USM_NEG_GAIN there.
export const USM_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_blur;     // unit 0: texture to blur (finishTex, or h-blurred)
uniform sampler2D u_center;   // unit 2: finished color (center), used in mode 1
uniform vec2 u_texel;         // 1/vw, 1/vh of the finishing viewport
uniform int u_mode;           // 0 = horizontal blur, 1 = vertical blur + composite
uniform float u_sigma;        // gaussian sigma in pixels
uniform float u_texture;      // slider amount, -1..1
// B1 clip overlay: enables only. The detail-loss decision was computed by FRAG
// (which can see the inverted positive + soft-clip knee) and handed to us in the
// alpha of the finished-color texture (u_center) as a 2-bit code.
uniform float u_clip_high_on, u_clip_low_on;

const int MAXR = 64;          // == TEXTURE_MAX_RADIUS
const float POS_GAIN = 2.5;   // == USM_POS_GAIN
const float NEG_GAIN = 1.0;   // == USM_NEG_GAIN

vec3 clipOverlay(vec3 c, int code) {
  if (u_clip_high_on > 0.5 && (code & 2) != 0) return vec3(1.0, 0.15, 0.15);
  if (u_clip_low_on  > 0.5 && (code & 1) != 0) return vec3(0.2, 0.45, 1.0);
  return c;
}

// 1-D normalised Gaussian along 'step' (one texel in x or y). Radius = ceil(3σ),
// capped at MAXR; the loop runs to the constant MAXR (GLSL needs a constant
// bound) and skips taps beyond the radius. CLAMP_TO_EDGE on the sampler matches
// finish.rs's clamped indices.
vec3 gauss(vec2 step) {
  float sigma = max(u_sigma, 1e-3);
  int R = int(min(ceil(3.0 * sigma), float(MAXR)));
  float inv = 1.0 / (2.0 * sigma * sigma);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -MAXR; i <= MAXR; i++) {
    if (i < -R || i > R) continue;
    float w = exp(-float(i * i) * inv);
    acc += w * texture(u_blur, v_uv + step * float(i)).rgb;
    wsum += w;
  }
  return acc / wsum;
}

void main() {
  if (u_mode == 0) {                              // horizontal blur only
    o = vec4(gauss(vec2(u_texel.x, 0.0)), 1.0);
    return;
  }
  vec3 blur = gauss(vec2(0.0, u_texel.y));        // → full 2-D gaussian
  vec4 ctr = texture(u_center, v_uv);             // .rgb = finished color, .a = clip code
  vec3 center = ctr.rgb;
  int code = int(ctr.a + 0.5);
  float k = u_texture >= 0.0 ? u_texture * POS_GAIN : u_texture * NEG_GAIN;
  vec3 outc = clamp(center + k * (center - blur), 0.0, 1.0);
  o = vec4(clipOverlay(outc, code), 1.0);
}`;

// INVERT pass: samples the raw linear negative (RGBA16F), applies geometry
// (orient/flip/straighten/crop) as a UV transform, then ports engine.rs
// invert_b/c/naive + tone. Writes the inverted positive to an RGBA16F FBO that
// the existing FRAG (finishing) pass then reads. Geometry uniforms map the
// output [0,1] UV into source [0,1] UV; out-of-source samples render black.
export const INVERT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;                 // output UV in [0,1]
out vec4 o;
uniform sampler2D u_src;      // raw negative, RGBA16F
uniform vec3 u_base;
uniform vec3 u_wb;
uniform mat3 u_m_pre;
uniform mat3 u_m_post;
uniform float u_exposure, u_black, u_gamma;
uniform float u_d_max, u_print_exposure, u_paper_black, u_paper_grade, u_soft_clip;
uniform int u_mode;           // 0=B 1=C 2=Naive 3=D
uniform bool u_raw;           // true → output the scan (display gamma), no inversion
uniform bool u_positive;      // true → positive passthrough (no inversion), WB+exposure only
// Geometry: output→source UV mapping. The output is the crop sub-rect of the
// (straightened) oriented image, so we invert the backend's source→output order
// (orient → straighten → crop) by going crop → un-straighten → un-orient.
uniform vec2 u_crop_off;      // crop origin in oriented-image UV
uniform vec2 u_crop_scale;    // crop size in oriented-image UV
uniform float u_angle;        // straighten radians (clockwise)
uniform float u_aspect;       // oriented-image height/width (for pixel-space straighten)
uniform mat2 u_orient;        // oriented-UV → source-UV (undoes rot90/flip)

const float EPS = 1e-5;
const float LOG10 = 0.30102999566; // 1/log2(10): log10(x) = log2(x)*LOG10
// Exposure → t-multiply (pivot at black) — MUST equal engine.rs EXPO_K.
const float EXPO_K = 0.14;

// Filmic display S-curve — MUST equal engine.rs FILMIC_K/FILMIC_PIVOT/FILMIC_WHITE_T
// and filmic_s(). Logistic on normalised log-density, rescaled so filmicS(0)==0
// (neutral black) and filmicS(FILMIC_WHITE_T)==1.0 (true white). Replaces the old
// paper-grade/soft-clip encode that capped white at ~0.90.
const float FILMIC_K = 5.0;
const float FILMIC_PIVOT = 0.44; // < 0.5: brighter mids (calibration lift); see engine.rs
const float FILMIC_WHITE_T = 1.05;
float filmicL(float x) { return 1.0 / (1.0 + exp(-FILMIC_K * (x - FILMIC_PIVOT))); }
// Unclamped filmic forward — mirrors engine.rs filmic_s_raw (super-white density
// stays > 1 for the WB round-trip; do NOT clamp here).
float filmicSraw(float t) {
  float l0 = filmicL(0.0);
  float lw = filmicL(FILMIC_WHITE_T);
  return (filmicL(t) - l0) / (lw - l0);
}
float filmicS(float t) { return clamp(filmicSraw(t), 0.0, 1.0); }
// Exact inverse of filmicSraw (a logit) — mirrors engine.rs filmic_inv. Maps a
// display density y back to normalised log-density; filmicInv(0)==0. big is
// clamped just inside (0,1) so the logit stays finite when WB pushes y past the
// white asymptote (y ≳ 1.053) — that channel is a blown highlight → white.
float filmicInv(float y) {
  float l0 = filmicL(0.0);
  float lw = filmicL(FILMIC_WHITE_T);
  float big = clamp(y * (lw - l0) + l0, 1e-6, 1.0 - 1e-6); // = filmicL(t)
  return FILMIC_PIVOT + log(big / (1.0 - big)) / FILMIC_K;
}

float tone(float v, float gain) {
  v = max(v * u_exposure * gain - u_black, 0.0);
  return pow(v, u_gamma);
}

vec3 invert(vec3 rgbIn) {
  // normalise against base, clamp like engine.rs
  vec3 r = clamp(vec3(
    rgbIn.r / max(u_base.r, EPS),
    rgbIn.g / max(u_base.g, EPS),
    rgbIn.b / max(u_base.b, EPS)), EPS, 1.0);
  if (u_mode == 3) {           // Mode D: negadoctor (Cineon). Mirrors engine.rs invert_d.
    // NOTE: Mode D does not use tone()/u_exposure/u_black/u_gamma. u_paper_black/
    // u_paper_grade/u_soft_clip are DEPRECATED by the filmic curve and inert here.
    // Like Naive, this re-derives from rgbIn and ignores the shared 'r' above
    // (it needs its own THRESH clamp, not r's [EPS,1] clamp).
    const float THRESH = 2.3283064e-10;
    vec3 clamped = max(rgbIn, vec3(THRESH));
    vec3 dmin = max(u_base, vec3(EPS));
    // Negative density d = log10(base/scan) >= 0 — linear in scene stops.
    vec3 d = max(log2(dmin / clamped) * LOG10, vec3(0.0));  // log10(dmin/clamped)
    // Exposure scales the WB-NEUTRALISED log-density (not raw t) so brightness
    // changes hue-free: EV stops scale by 2^(EXPO_K·EV). EV=0 → expo_gain==1 →
    // look unchanged. d_max sets the white anchor. (Mirrors engine.rs invert_d.)
    float ev = log2(max(u_print_exposure, EPS));
    float expo_gain = exp2(EXPO_K * ev);
    // Normalised log-density; d == d_max -> t == 1 (white point).
    vec3 t = d / max(u_d_max, EPS);
    // WB is a linear gain on the positive OUTPUT (filmic value), NOT a t-scale:
    // keeps black neutral (filmicS(0)*wb = 0) and stays consistent with the
    // gray-world auto-WB + gray-point picker. y is the WB-neutralised EV-0
    // display density (UNCLAMPED forward, so super-white highlights stay distinct);
    // exposure then scales its log-density filmicInv(y) and re-applies the curve —
    // so a neutral patch (equal y across channels) stays neutral at every exposure
    // (fixes the ±5-EV temperature shift).
    vec3 y = vec3(filmicSraw(t.r), filmicSraw(t.g), filmicSraw(t.b)) * u_wb;
    return clamp(vec3(
      filmicS(filmicInv(y.r) * expo_gain),
      filmicS(filmicInv(y.g) * expo_gain),
      filmicS(filmicInv(y.b) * expo_gain)), 0.0, 1.0);
  }
  if (u_mode == 2) {           // Naive: 1 - clamp(I/base,0,1). Intentionally uses
    // its own [0,1] clamp (engine.rs invert_naive), not the [EPS,1] r above.
    vec3 n = clamp(vec3(rgbIn.r/max(u_base.r,EPS), rgbIn.g/max(u_base.g,EPS), rgbIn.b/max(u_base.b,EPS)), 0.0, 1.0);
    return 1.0 - n;
  }
  if (u_mode == 1) {           // Mode C: per-channel log density
    vec3 dens = -vec3(log2(r.r), log2(r.g), log2(r.b)) * LOG10;
    return vec3(tone(dens.r, u_wb.r), tone(dens.g, u_wb.g), tone(dens.b, u_wb.b));
  }
  // Mode B: M_post * (-log10(M_pre * r)) then tone
  vec3 mixed = u_m_pre * r;
  vec3 dens = -vec3(
    log2(max(mixed.r, EPS)), log2(max(mixed.g, EPS)), log2(max(mixed.b, EPS))) * LOG10;
  vec3 unmixed = u_m_post * dens;
  return vec3(tone(unmixed.r, u_wb.r), tone(unmixed.g, u_wb.g), tone(unmixed.b, u_wb.b));
}

// Map output UV → source UV through crop + straighten + orient.
vec2 sourceUV(vec2 uv) {
  // Clip-space v_uv is y-up (v=1 at canvas top); image/texture space is y-down
  // (row 0 = top). Convert before geometry so crop/orient/straighten operate in
  // the image-space convention the JS-side matrices (mirroring convert.rs) assume.
  uv.y = 1.0 - uv.y;
  // 1. map the output UV into the (straightened) oriented-image frame, centred.
  vec2 c = u_crop_off + uv * u_crop_scale - 0.5;
  // 2. un-straighten: the backend rotates in oriented PIXEL space, so scale by the
  //    oriented aspect before/after the rotation (no-op when u_angle == 0).
  float s = sin(u_angle), co = cos(u_angle);
  c = mat2(co, -s / u_aspect, s * u_aspect, co) * c;
  // 3. un-orient (rot90/flip) into source UV, then back to [0,1].
  c = u_orient * c;
  return c + 0.5;
}

void main() {
  vec2 suv = sourceUV(v_uv);
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
    o = vec4(0.0, 0.0, 0.0, 1.0); return;     // outside source (straighten corners) = black
  }
  vec3 rgb = texture(u_src, suv).rgb;
  if (u_raw) { o = vec4(pow(clamp(rgb, 0.0, 1.0), vec3(1.0/2.2)), 1.0); return; }
  if (u_positive) {
    // Positive passthrough: display-encode the linear scan with WB + exposure
    // gain. Mirrors engine.rs develop_positive_px (pow(rgb*pe*wb, 1/2.2)).
    o = vec4(pow(max(rgb * u_print_exposure * u_wb, 0.0), vec3(1.0/2.2)), 1.0); return;
  }
  o = vec4(invert(rgb), 1.0);
}`;
