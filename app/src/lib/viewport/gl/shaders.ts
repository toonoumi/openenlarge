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
uniform vec2 u_texel;            // 1/width, 1/height
uniform float u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_vibrance, u_saturation, u_texture;

float tone(float v) {
  v = clamp(v, 0.0, 1.0);
  v += u_whites * 0.20 * v * v * v;
  v -= u_blacks * 0.20 * pow(1.0 - v, 3.0);
  v += u_shadows * 0.30 * (1.0 - v) * (1.0 - v) * v;
  v += u_highlights * 0.30 * v * v * (1.0 - v);
  v = 0.5 + (v - 0.5) * (1.0 + u_contrast);
  return clamp(v, 0.0, 1.0);
}

vec3 finishAt(vec2 uv) {
  vec3 c = texture(u_src, uv).rgb;
  vec3 t = vec3(tone(c.r), tone(c.g), tone(c.b));
  float y = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
  float mx = max(max(t.r, t.g), t.b);
  float mn = min(min(t.r, t.g), t.b);
  float cur = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  float f = 1.0 + u_saturation + u_vibrance * (1.0 - cur);
  return clamp(vec3(y) + (t - vec3(y)) * f, 0.0, 1.0);
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
