import { VERT, FRAG, INVERT_FRAG, USM_FRAG, TEXTURE_SIGMA_FRAC } from "./shaders";
import { type InversionUniforms } from "./invert";
import type { FinishUniforms } from "./uniforms";
import type { ColorGradeUniforms, ColorMixUniforms } from "../../develop/finish";
import type { ClipUniforms } from "./clip";
import { LUT_SIZE } from "../../develop/curve";

/** True if the environment can create a WebGL2 context. */
export function webgl2Available(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * Spike (Plan 1): does THIS environment's WebGL2 support an RGBA16F render
 * target? Plans 2-3 (GPU inversion + offscreen export) depend on it. Creates a
 * tiny offscreen RGBA16F texture, attaches it to an FBO, and checks both the
 * float-color-buffer extension and framebuffer completeness. Returns a verdict
 * object so the result can be logged from the app.
 */
export function float16RenderTargetSupported():
  { ok: boolean; reason: string } {
  if (typeof document === "undefined") return { ok: false, reason: "no document" };
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = document.createElement("canvas").getContext("webgl2");
  } catch {
    return { ok: false, reason: "no webgl2 context" };
  }
  if (!gl) return { ok: false, reason: "no webgl2 context" };
  // Needed to RENDER to a float texture (not just sample one).
  if (!gl.getExtension("EXT_color_buffer_float")) {
    return { ok: false, reason: "EXT_color_buffer_float missing" };
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    return { ok: false, reason: `framebuffer incomplete: 0x${status.toString(16)}` };
  }
  return { ok: true, reason: "RGBA16F render target OK" };
}

const UNIFORM_NAMES = [
  "contrast", "highlights", "shadows", "whites", "blacks",
  "vibrance", "saturation", "texture",
] as const;

// Color-grading uniforms: [shader uniform name, ColorGradeUniforms key]. The
// shader names are cg-prefixed; the JS object keys are not — keep them paired.
const CG_VEC3: [string, keyof ColorGradeUniforms][] = [
  ["u_cg_sh_off", "sh_off"], ["u_cg_mid_off", "mid_off"],
  ["u_cg_hi_off", "hi_off"], ["u_cg_glob_off", "glob_off"],
];
const CG_FLOAT: [string, keyof ColorGradeUniforms][] = [
  ["u_cg_sh_lum", "sh_lum"], ["u_cg_mid_lum", "mid_lum"],
  ["u_cg_hi_lum", "hi_lum"], ["u_cg_glob_lum", "glob_lum"],
  ["u_cg_sh_edge", "sh_edge"], ["u_cg_hi_edge", "hi_edge"], ["u_cg_soft", "softness"],
];

/** Applies the finishing layer to a source preview texture via a fragment shader. */
export class FinishRenderer {
  readonly available: boolean;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private uniforms: FinishUniforms | null = null;
  private cg: ColorGradeUniforms | null = null;
  private cm: ColorMixUniforms | null = null;
  private clip: ClipUniforms | null = null;
  private srcW = 0;
  private srcH = 0;
  private hasSource = false;
  private invProg: WebGLProgram | null = null;
  private srcTexF: WebGLTexture | null = null;   // RGBA16F raw negative
  private interTex: WebGLTexture | null = null;   // RGBA16F inverted intermediate
  // Texture (USM) pass: cached plain finished color + a blur scratch + the
  // separable-blur program. A dedicated scratch (not interTex) keeps the inverted
  // positive in interTex intact for readPixel()'s clean color-pick re-render.
  private finishTex: WebGLTexture | null = null;  // RGBA16F finished color (no clip/USM)
  private blurTmpTex: WebGLTexture | null = null; // RGBA16F horizontal-blur scratch
  private usmProg: WebGLProgram | null = null;
  private usmLoc: Record<string, WebGLUniformLocation | null> = {};
  private fbo: WebGLFramebuffer | null = null;
  private inv: InversionUniforms | null = null;
  private invLoc: Record<string, WebGLUniformLocation | null> = {};
  private readFbo: WebGLFramebuffer | null = null;   // 1-px clean-readback target
  private readTex: WebGLTexture | null = null;
  private readW = 0;
  private readH = 0;
  private geom = {
    crop_off: new Float32Array([0, 0]),
    crop_scale: new Float32Array([1, 1]),
    angle: 0,
    aspect: 1,
    orient: new Float32Array([1, 0, 0, 1]),
    raw: false,
  };
  private useFloat = false; // true once setSourceFloat is used

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) { this.available = false; return; }
    this.gl = gl;
    const prog = this.build(gl);
    if (!prog) { this.available = false; return; }
    this.prog = prog;
    this.vao = gl.createVertexArray(); // empty VAO required to draw in WebGL2
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Tone-curve LUT texture (256x1 RGBA8, linear for smooth interpolation).
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.setLut(identityLut());
    gl.useProgram(prog);
    this.loc.u_src = gl.getUniformLocation(prog, "u_src");
    this.loc.u_lut = gl.getUniformLocation(prog, "u_lut");
    this.loc.u_texel = gl.getUniformLocation(prog, "u_texel");
    for (const n of UNIFORM_NAMES) this.loc[`u_${n}`] = gl.getUniformLocation(prog, `u_${n}`);
    for (const [u] of CG_VEC3) this.loc[u] = gl.getUniformLocation(prog, u);
    for (const [u] of CG_FLOAT) this.loc[u] = gl.getUniformLocation(prog, u);
    for (const u of [
      "u_cm_hue","u_cm_sat","u_cm_lum","u_pc_count","u_pc_hue","u_pc_sat","u_pc_lum",
      "u_pc_hue_shift","u_pc_sat_shift","u_pc_lum_shift","u_pc_variance","u_pc_range",
      "u_clip_high_on","u_clip_low_on","u_clip_strict","u_soft_clip","u_finish_mode",
    ]) this.loc[u] = gl.getUniformLocation(prog, u);
    gl.uniform1i(this.loc.u_src, 0);
    gl.uniform1i(this.loc.u_lut, 1);

    // Invert program (pass 1). Requires float color-buffer for the FBO.
    if (!gl.getExtension("EXT_color_buffer_float")) { this.available = false; return; }
    const ivs = this.compile(gl, gl.VERTEX_SHADER, VERT);
    const ifs = this.compile(gl, gl.FRAGMENT_SHADER, INVERT_FRAG);
    if (!ivs || !ifs) { this.available = false; return; }
    const ip = gl.createProgram()!;
    gl.attachShader(ip, ivs); gl.attachShader(ip, ifs); gl.linkProgram(ip);
    if (!gl.getProgramParameter(ip, gl.LINK_STATUS)) {
      console.error("invert link:", gl.getProgramInfoLog(ip)); this.available = false; return;
    }
    this.invProg = ip;
    for (const n of [
      "u_src","u_base","u_wb","u_m_pre","u_m_post","u_exposure","u_black","u_gamma",
      "u_mode","u_raw","u_positive","u_crop_off","u_crop_scale","u_angle","u_aspect","u_orient",
      "u_d_max","u_print_exposure","u_paper_black","u_paper_grade","u_soft_clip",
    ]) this.invLoc[n] = gl.getUniformLocation(ip, n);
    gl.useProgram(ip); gl.uniform1i(this.invLoc.u_src, 0);

    // RGBA16F raw-negative source texture.
    this.srcTexF = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTexF);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // RGBA16F intermediate (inverted) + FBO.
    this.interTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.interTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.fbo = gl.createFramebuffer();

    // RGBA16F finished-color cache + blur scratch for the texture (USM) pass.
    for (const t of ["finishTex", "blurTmpTex"] as const) {
      const tex = gl.createTexture();
      this[t] = tex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    // USM (texture) program: separable Gaussian blur + unsharp composite.
    const uvs = this.compile(gl, gl.VERTEX_SHADER, VERT);
    const ufs = this.compile(gl, gl.FRAGMENT_SHADER, USM_FRAG);
    if (!uvs || !ufs) { this.available = false; return; }
    const usm = gl.createProgram()!;
    gl.attachShader(usm, uvs); gl.attachShader(usm, ufs); gl.linkProgram(usm);
    if (!gl.getProgramParameter(usm, gl.LINK_STATUS)) {
      console.error("usm link:", gl.getProgramInfoLog(usm)); this.available = false; return;
    }
    this.usmProg = usm;
    for (const n of [
      "u_blur","u_center","u_texel","u_mode","u_sigma","u_texture",
      "u_clip_high_on","u_clip_low_on",
    ]) this.usmLoc[n] = gl.getUniformLocation(usm, n);
    gl.useProgram(usm);
    gl.uniform1i(this.usmLoc.u_blur, 0);
    gl.uniform1i(this.usmLoc.u_center, 2);

    this.available = true;
  }

  /** Release every GL object and the context itself. MUST be called when the owning
   *  Viewport unmounts: otherwise each remount leaks a WebGL context, and WebKit
   *  forcibly reclaims them after ~16 — surfacing as "Context leak detected" plus
   *  multi-second stalls (frozen image switching) until the old contexts are reaped. */
  dispose() {
    const gl = this.gl;
    if (!gl) return;
    gl.deleteTexture(this.tex);
    gl.deleteTexture(this.lutTex);
    gl.deleteTexture(this.srcTexF);
    gl.deleteTexture(this.interTex);
    gl.deleteTexture(this.finishTex);
    gl.deleteTexture(this.blurTmpTex);
    gl.deleteTexture(this.readTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteFramebuffer(this.readFbo);
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.invProg);
    gl.deleteProgram(this.usmProg);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null; // further calls no-op (every method guards on `this.gl`)
  }

  /** Upload a 256×1 RGBA8 tone LUT. */
  setLut(bytes: Uint8Array) {
    const gl = this.gl; if (!gl || !this.lutTex) return;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  }

  setColorGrade(cg: ColorGradeUniforms) { this.cg = cg; }
  setColorMix(cm: ColorMixUniforms) { this.cm = cm; }
  setClip(c: ClipUniforms) { this.clip = c; }

  private build(gl: WebGL2RenderingContext): WebGLProgram | null {
    const vs = this.compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    const p = gl.createProgram()!;
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("link:", gl.getProgramInfoLog(p)); return null;
    }
    return p;
  }
  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("shader:", gl.getShaderInfoLog(s)); return null;
    }
    return s;
  }

  /** Upload a decoded preview image as the source texture; sizes the canvas. */
  setSource(img: TexImageSource, w: number, h: number) {
    const gl = this.gl; if (!gl || !this.tex) return;
    this.useFloat = false; // 8-bit CPU-fallback source → draw() uses the single finishing pass
    this.srcW = w; this.srcH = h;
    this.canvas.width = w; this.canvas.height = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    // Size the finished-color / blur-scratch FBOs so the texture (USM) pass works
    // on the 8-bit CPU-fallback path too (no invert pass runs here).
    this.allocInter(w, h);
    this.hasSource = true;
  }

  setUniforms(u: FinishUniforms) { this.uniforms = u; }

  /** Upload the raw linear negative as an RGBA16F texture (once per image). */
  setSourceFloat(pixels: Uint16Array, w: number, h: number) {
    const gl = this.gl; if (!gl || !this.srcTexF || !this.interTex) return;
    this.srcW = w; this.srcH = h; this.useFloat = true;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTexF);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // geometry handled in-shader
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, pixels);
    // (Re)allocate the intermediate to the OUTPUT size; default = source size.
    this.allocInter(w, h);
    this.hasSource = true;
  }

  /** Size the intermediate + finished-color FBO textures (output dims = canvas). */
  private allocInter(w: number, h: number) {
    const gl = this.gl; if (!gl || !this.interTex || !this.finishTex || !this.blurTmpTex) return;
    for (const tex of [this.interTex, this.finishTex, this.blurTmpTex]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    }
  }

  setInversion(u: InversionUniforms) { this.inv = u; }

  /** Geometry from the host (identity-safe). out{W,H} = post-geometry canvas size. */
  setGeometry(g: {
    crop_off: [number, number]; crop_scale: [number, number];
    angle: number; aspect: number; orient: [number, number, number, number];
    raw: boolean; outW: number; outH: number;
  }) {
    this.geom.crop_off = new Float32Array(g.crop_off);
    this.geom.crop_scale = new Float32Array(g.crop_scale);
    this.geom.angle = g.angle;
    this.geom.aspect = g.aspect;
    this.geom.orient = new Float32Array(g.orient);
    this.geom.raw = g.raw;
    this.canvas.width = g.outW; this.canvas.height = g.outH;
    this.allocInter(g.outW, g.outH);
    this.srcW = g.outW; this.srcH = g.outH; // finishing pass uses these for u_texel/viewport
  }

  /** Max texture dimension this GL context supports (0 if no context). */
  maxTextureSize(): number {
    return this.gl ? this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) : 0;
  }

  /** PASS 1: INVERT raw negative → intermediate FBO (output-sized). */
  private drawInvertPass() {
    const gl = this.gl; if (!gl) return;
    gl.useProgram(this.invProg);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.interTex, 0);
    gl.viewport(0, 0, this.srcW, this.srcH);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTexF);
    const L = this.invLoc, u = this.inv!;
    gl.uniform3fv(L.u_base, u.base); gl.uniform3fv(L.u_wb, u.wb);
    gl.uniformMatrix3fv(L.u_m_pre, false, u.m_pre);
    gl.uniformMatrix3fv(L.u_m_post, false, u.m_post);
    gl.uniform1f(L.u_exposure, u.exposure); gl.uniform1f(L.u_black, u.black);
    gl.uniform1f(L.u_gamma, u.gamma); gl.uniform1i(L.u_mode, u.mode);
    gl.uniform1f(L.u_d_max, u.d_max); gl.uniform1f(L.u_print_exposure, u.print_exposure);
    gl.uniform1f(L.u_paper_black, u.paper_black); gl.uniform1f(L.u_paper_grade, u.paper_grade);
    gl.uniform1f(L.u_soft_clip, u.soft_clip);
    gl.uniform1i(L.u_raw, this.geom.raw ? 1 : 0);
    gl.uniform1i(L.u_positive, u.positive ? 1 : 0);
    gl.uniform2fv(L.u_crop_off, this.geom.crop_off);
    gl.uniform2fv(L.u_crop_scale, this.geom.crop_scale);
    gl.uniform1f(L.u_angle, this.geom.angle);
    gl.uniform1f(L.u_aspect, this.geom.aspect);
    gl.uniformMatrix2fv(L.u_orient, false, this.geom.orient);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * PASS 2: FINISH (existing program) reads the intermediate, draws into
   * WHATEVER framebuffer is currently bound (canvas for live, export FBO for
   * export) at viewport (vw, vh).
   */
  private drawFinishPass(vw: number, vh: number, clipOff = false, finishMode = 0) {
    const gl = this.gl; if (!gl) return;
    const p = this.prog, fu = this.uniforms;
    if (!p || !fu) return;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, vw, vh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.useFloat ? this.interTex : this.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.loc.u_finish_mode, finishMode);
    gl.uniform2f(this.loc.u_texel, 1 / vw, 1 / vh);
    for (const n of UNIFORM_NAMES) gl.uniform1f(this.loc[`u_${n}`], (fu as unknown as Record<string, number>)[n]);
    const cg = this.cg;
    if (cg) {
      for (const [uu, k] of CG_VEC3) gl.uniform3fv(this.loc[uu], cg[k] as [number, number, number]);
      for (const [uu, k] of CG_FLOAT) gl.uniform1f(this.loc[uu], cg[k] as number);
    }
    const cm = this.cm;
    if (cm) {
      gl.uniform1fv(this.loc.u_cm_hue, cm.cm_hue);
      gl.uniform1fv(this.loc.u_cm_sat, cm.cm_sat);
      gl.uniform1fv(this.loc.u_cm_lum, cm.cm_lum);
      gl.uniform1i(this.loc.u_pc_count, cm.pc_count);
      gl.uniform1fv(this.loc.u_pc_hue, cm.pc_hue);
      gl.uniform1fv(this.loc.u_pc_sat, cm.pc_sat);
      gl.uniform1fv(this.loc.u_pc_lum, cm.pc_lum);
      gl.uniform1fv(this.loc.u_pc_hue_shift, cm.pc_hue_shift);
      gl.uniform1fv(this.loc.u_pc_sat_shift, cm.pc_sat_shift);
      gl.uniform1fv(this.loc.u_pc_lum_shift, cm.pc_lum_shift);
      gl.uniform1fv(this.loc.u_pc_variance, cm.pc_variance);
      gl.uniform1fv(this.loc.u_pc_range, cm.pc_range);
    }
    // clipOff zeroes the overlay ENABLES so the finishing pass writes pure image
    // color — used by readPixel() so the color picker is never corrupted by the
    // clip-warning overlay (B2). The detail-loss thresholds (strict + soft_clip)
    // stay set regardless, so finish_mode==1 still bakes the correct code into
    // alpha for the USM pass even when the live overlay is off (B1).
    const clip = clipOff ? null : this.clip;
    gl.uniform1f(this.loc.u_clip_high_on, clip ? clip.highOn : 0);
    gl.uniform1f(this.loc.u_clip_low_on, clip ? clip.lowOn : 0);
    gl.uniform1f(this.loc.u_clip_strict, this.clip ? this.clip.strict : 0);
    gl.uniform1f(this.loc.u_soft_clip, this.inv ? this.inv.soft_clip : 0.9);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Finishing + (when the texture slider is non-zero) the unsharp/clarity pass,
   * rendered into `dstFbo` (null = canvas). The fast path draws finishing
   * straight to the target. When texture is active it caches the plain finished
   * color in finishTex, runs a separable Gaussian (H → interTex scratch, V +
   * unsharp composite → dstFbo). Mirrors finish.rs::apply_texture.
   */
  private drawFinishAndTexture(vw: number, vh: number, dstFbo: WebGLFramebuffer | null, clipOff = false) {
    const gl = this.gl; if (!gl) return;
    const amount = this.uniforms ? this.uniforms.texture : 0;
    if (Math.abs(amount) < 1e-5) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      this.drawFinishPass(vw, vh, clipOff, /* finishMode present */ 0);
      return;
    }
    // 1) finishing → finishTex (plain color, no clip, no USM).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.finishTex, 0);
    this.drawFinishPass(vw, vh, /* clipOff */ true, /* finishMode plain */ 1);
    // 2) horizontal blur finishTex → blurTmpTex.
    this.drawUsmPass(vw, vh, 0, this.fbo, this.blurTmpTex, this.finishTex, null, clipOff);
    // 3) vertical blur + unsharp composite (blurTmpTex + finishTex center) → dstFbo.
    this.drawUsmPass(vw, vh, 1, dstFbo, null, this.blurTmpTex, this.finishTex, clipOff);
  }

  /**
   * One pass of the USM program. mode 0 = horizontal blur of `blurSrc` into
   * `attach` (attached to `targetFbo`); mode 1 = vertical blur of `blurSrc` plus
   * unsharp composite against `center`, drawn into the bound `targetFbo` (null =
   * canvas; its color attachment is left intact). `center` is bound only in mode 1.
   */
  private drawUsmPass(
    vw: number, vh: number, mode: number,
    targetFbo: WebGLFramebuffer | null, attach: WebGLTexture | null,
    blurSrc: WebGLTexture | null, center: WebGLTexture | null, clipOff: boolean,
  ) {
    const gl = this.gl, up = this.usmProg; if (!gl || !up) return;
    gl.useProgram(up);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    if (attach) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, attach, 0);
    gl.viewport(0, 0, vw, vh);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, blurSrc);
    if (center) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, center); }
    gl.uniform1i(this.usmLoc.u_mode, mode);
    gl.uniform2f(this.usmLoc.u_texel, 1 / vw, 1 / vh);
    // Floor at 0.5 to match finish.rs::texture_blur (so radius = ceil(3σ) ≥ 2).
    gl.uniform1f(this.usmLoc.u_sigma, Math.max(0.5, TEXTURE_SIGMA_FRAC * Math.min(vw, vh)));
    gl.uniform1f(this.usmLoc.u_texture, this.uniforms ? this.uniforms.texture : 0);
    const clip = clipOff ? null : this.clip;
    gl.uniform1f(this.usmLoc.u_clip_high_on, clip ? clip.highOn : 0);
    gl.uniform1f(this.usmLoc.u_clip_low_on, clip ? clip.lowOn : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  draw() {
    const gl = this.gl; if (!gl || !this.hasSource) return;
    if (this.useFloat && this.invProg && this.inv) this.drawInvertPass();
    this.drawFinishAndTexture(this.srcW, this.srcH, null);
  }

  /**
   * Read one pixel of CLEAN finished image color at framebuffer coords (sx, sy)
   * — i.e. WITHOUT the clip-warning overlay baked in (B2: the color picker must
   * be identical whether the overlay is on or off, even inside a clipped region).
   *
   * Re-runs only the finishing pass (the inverted `interTex` from the last draw()
   * is reused) with the overlay forced off, into a scissored 1-px offscreen FBO,
   * then reads that single pixel back. Returns null if not yet drawable.
   */
  readPixel(sx: number, sy: number): [number, number, number] | null {
    const gl = this.gl; if (!gl || !this.hasSource || !this.prog) return null;
    const w = this.srcW, h = this.srcH;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

    // (Re)allocate the readback target to match the current canvas size so (sx,sy)
    // — computed against the canvas backbuffer — addresses the same pixel here.
    if (!this.readFbo) this.readFbo = gl.createFramebuffer();
    if (!this.readTex || this.readW !== w || this.readH !== h) {
      if (this.readTex) gl.deleteTexture(this.readTex);
      this.readTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.readTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.readW = w; this.readH = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.readTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
    // Shade ONLY the target pixel (scissor) so a per-pixel pick stays cheap.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx, sy, 1, 1);
    this.drawFinishPass(w, h, /* clipOff */ true);
    gl.disable(gl.SCISSOR_TEST);
    const px = new Uint8Array(4);
    gl.readPixels(sx, sy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [px[0], px[1], px[2]];
  }

  /**
   * Render invert+finish for EXPORT into an offscreen FBO at (w,h) and read back.
   * bit16=false → returns RGBA8 (Uint8Array); bit16=true → RGBA f32 (Float32Array).
   * Geometry is identity (Rust already baked orient/crop/heal into `src`).
   * Returns null if WebGL is unavailable or (w,h) exceeds MAX_TEXTURE_SIZE.
   */
  renderExport(
    src: Uint16Array, w: number, h: number,
    inv: InversionUniforms,
    fu: FinishUniforms, lut: Uint8Array, cg: ColorGradeUniforms, cm: ColorMixUniforms,
    bit16: boolean,
  ): { data: Uint8Array | Float32Array; w: number; h: number } | null {
    const gl = this.gl; if (!gl || !this.invProg || !this.prog) return null;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (w > max || h > max) return null;

    // Upload the full-res source, set inversion + IDENTITY geometry + finishing.
    this.setSourceFloat(src, w, h);
    this.setInversion(inv);
    this.setGeometry({ crop_off: [0, 0], crop_scale: [1, 1], angle: 0, aspect: 1, orient: [1, 0, 0, 1], raw: false, outW: w, outH: h });
    this.setUniforms(fu); this.setLut(lut); this.setColorGrade(cg); this.setColorMix(cm);

    // Offscreen output texture + FBO (RGBA8 for 8-bit, RGBA16F for 16-bit).
    const outInternal = bit16 ? gl.RGBA16F : gl.RGBA8;
    const outType = bit16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, outInternal, w, h, 0, gl.RGBA, outType, null);
    const outFbo = gl.createFramebuffer();

    // PASS 1: invert → interTex.
    this.drawInvertPass();
    // PASS 2: finish (+ texture USM) interTex → outTex.
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
    // Bail (→ CPU fallback) if this output format isn't renderable on the device
    // (e.g. RGBA16F render targets unsupported), rather than reading back garbage.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(outFbo); gl.deleteTexture(outTex);
      return null;
    }
    this.drawFinishAndTexture(w, h, outFbo);

    // Read back. readPixels returns rows bottom-to-top (GL origin = bottom-left),
    // but the Rust readback (image_from_rgba8/_f32) treats row 0 as the top, so
    // flip vertically here to match that top-to-bottom contract (else export is
    // upside-down vs the on-screen preview, which the canvas presents y-up).
    let data: Uint8Array | Float32Array;
    if (bit16) { data = new Float32Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data); }
    else { data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); }
    flipRowsY(data, w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(outFbo); gl.deleteTexture(outTex);
    return { data, w, h };
  }
}

/** Flip tightly-packed RGBA rows in place (top↔bottom) to convert GL readback
 *  (bottom-to-top) into the top-to-bottom order file encoders expect. */
function flipRowsY(data: Uint8Array | Float32Array, w: number, h: number) {
  const stride = w * 4;
  const tmp = data.slice(0, stride); // typed-array row scratch (same type as data)
  for (let y = 0; y < (h >> 1); y++) {
    const top = y * stride, bot = (h - 1 - y) * stride;
    tmp.set(data.subarray(top, top + stride));
    data.copyWithin(top, bot, bot + stride);
    data.set(tmp, bot);
  }
}

/** A neutral 256×1 RGBA8 ramp LUT (identity tone curve). */
function identityLut(): Uint8Array {
  const out = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = Math.round((i / (LUT_SIZE - 1)) * 255);
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}
