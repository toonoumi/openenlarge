import { VERT, FRAG } from "./shaders";
import type { FinishUniforms } from "./uniforms";

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

const UNIFORM_NAMES = [
  "contrast", "highlights", "shadows", "whites", "blacks",
  "vibrance", "saturation", "texture",
] as const;

/** Applies the finishing layer to a source preview texture via a fragment shader. */
export class FinishRenderer {
  readonly available: boolean;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private uniforms: FinishUniforms | null = null;
  private srcW = 0;
  private srcH = 0;
  private hasSource = false;

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
    gl.useProgram(prog);
    this.loc.u_src = gl.getUniformLocation(prog, "u_src");
    this.loc.u_texel = gl.getUniformLocation(prog, "u_texel");
    for (const n of UNIFORM_NAMES) this.loc[`u_${n}`] = gl.getUniformLocation(prog, `u_${n}`);
    gl.uniform1i(this.loc.u_src, 0);
    this.available = true;
  }

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
    this.srcW = w; this.srcH = h;
    this.canvas.width = w; this.canvas.height = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.hasSource = true;
  }

  setUniforms(u: FinishUniforms) { this.uniforms = u; }

  draw() {
    const gl = this.gl, p = this.prog, u = this.uniforms;
    if (!gl || !p || !u || !this.hasSource) return;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.srcW, this.srcH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform2f(this.loc.u_texel, 1 / this.srcW, 1 / this.srcH);
    for (const n of UNIFORM_NAMES) gl.uniform1f(this.loc[`u_${n}`], (u as unknown as Record<string, number>)[n]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
