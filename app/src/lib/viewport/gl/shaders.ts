// Fullscreen-triangle vertex shader (no buffers; uses gl_VertexID).
export const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = uv;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

// Fragment shader: ports finish.rs. tone_curve + saturation per pixel; texture
// (unsharp) computed by re-evaluating finish() on a 3x3 (outer-product 0.25/0.5/
// 0.25) neighbourhood — numerically equal to blur(finish_pixel) then unsharp.
export const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_lut;         // 256x1 composed tone LUT (R/G/B per channel)
uniform vec2 u_texel;            // 1/width, 1/height
uniform float u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_vibrance, u_saturation, u_texture;
// Color grading (precomputed offsets + masks; mirror finish.rs::ColorGrade).
uniform vec3 u_cg_sh_off, u_cg_mid_off, u_cg_hi_off, u_cg_glob_off;
uniform float u_cg_sh_lum, u_cg_mid_lum, u_cg_hi_lum, u_cg_glob_lum;
uniform float u_cg_sh_edge, u_cg_hi_edge, u_cg_soft;

float tone(float v) {
  v = clamp(v, 0.0, 1.0);
  v += u_whites * 0.20 * v * v * v;
  v -= u_blacks * 0.20 * pow(1.0 - v, 3.0);
  v += u_shadows * 0.30 * (1.0 - v) * (1.0 - v) * v;
  v += u_highlights * 0.30 * v * v * (1.0 - v);
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

vec3 finishAt(vec2 uv) {
  vec3 c = texture(u_src, uv).rgb;
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
  return colorGrade(cu);
}

void main() {
  vec3 c = finishAt(v_uv);
  if (abs(u_texture) < 1e-5) { o = vec4(c, 1.0); return; }
  vec2 d = u_texel;
  vec3 b =
    finishAt(v_uv + vec2(-d.x, -d.y)) * 0.0625 +
    finishAt(v_uv + vec2( 0.0, -d.y)) * 0.125  +
    finishAt(v_uv + vec2( d.x, -d.y)) * 0.0625 +
    finishAt(v_uv + vec2(-d.x,  0.0)) * 0.125  +
    c * 0.25 +
    finishAt(v_uv + vec2( d.x,  0.0)) * 0.125  +
    finishAt(v_uv + vec2(-d.x,  d.y)) * 0.0625 +
    finishAt(v_uv + vec2( 0.0,  d.y)) * 0.125  +
    finishAt(v_uv + vec2( d.x,  d.y)) * 0.0625;
  float k = 1.5 * u_texture;
  o = vec4(clamp(c + k * (c - b), 0.0, 1.0), 1.0);
}`;
