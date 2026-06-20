import type { InvertParams } from "../../api";

/** The 8 finishing controls scaled to the engine's −1..1 (UI value ÷ 100).
 *  Mirrors `finish_from` in commands.rs / FinishParams in finish.rs. */
export interface FinishUniforms {
  contrast: number; highlights: number; shadows: number; whites: number;
  blacks: number; texture: number; vibrance: number; saturation: number;
  brightness: number;
}

export function finishUniforms(p: InvertParams): FinishUniforms {
  return {
    brightness: p.brightness / 100,
    contrast: p.contrast / 100,
    highlights: p.highlights / 100,
    shadows: p.shadows / 100,
    whites: p.whites / 100,
    blacks: p.blacks / 100,
    texture: p.texture / 100,
    vibrance: p.vibrance / 100,
    saturation: p.saturation / 100,
  };
}
