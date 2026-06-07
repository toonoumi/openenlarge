/** Mirrors the Rust `ResolvedInversion` JSON from the `resolved_inversion` command. */
export interface ResolvedInversion {
  base: [number, number, number];
  wb: [number, number, number];
  m_pre: number[];   // column-major 9
  m_post: number[];  // column-major 9
  exposure: number;
  black: number;
  gamma: number;
  mode: number;      // 0=B, 1=C, 2=Naive, 3=D
  d_max: number;
  print_exposure: number;
  paper_black: number;
  paper_grade: number;
  soft_clip: number;
}

/** GL-ready uniform buffers for the INVERT pass. */
export interface InversionUniforms {
  base: Float32Array;   // 3
  wb: Float32Array;     // 3
  m_pre: Float32Array;  // 9 (column-major, for uniformMatrix3fv)
  m_post: Float32Array; // 9
  exposure: number;
  black: number;
  gamma: number;
  mode: number;
  d_max: number;
  print_exposure: number;
  paper_black: number;
  paper_grade: number;
  soft_clip: number;
}

export function toInversionUniforms(r: ResolvedInversion): InversionUniforms {
  return {
    base: new Float32Array(r.base),
    wb: new Float32Array(r.wb),
    m_pre: new Float32Array(r.m_pre),
    m_post: new Float32Array(r.m_post),
    exposure: r.exposure,
    black: r.black,
    gamma: r.gamma,
    mode: r.mode,
    d_max: r.d_max,
    print_exposure: r.print_exposure,
    paper_black: r.paper_black,
    paper_grade: r.paper_grade,
    soft_clip: r.soft_clip,
  };
}
