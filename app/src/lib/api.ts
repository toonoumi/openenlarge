import { invoke } from "@tauri-apps/api/core";

export interface Metadata {
  camera?: string; lens?: string; iso?: string; shutter?: string;
  aperture?: string; width: number; height: number; file_size: number; date?: string;
}
export interface ImageEntry {
  id: string; file_name: string; thumbnail: string; metadata: Metadata; developed: boolean;
}
export type Quality = "performance" | "quality";
export interface InvertParams {
  mode: "b" | "c";
  stock: "none" | "portra400" | "fujic200";
  base_rect: [number, number, number, number] | null;
  exposure: number; black: number; gamma: number;
  auto_wb: boolean; temp: number; tint: number;
}
export interface ViewSpec {
  crop: [number, number, number, number];
  out_w: number;
  out_h: number;
  raw: boolean;
}

export const api = {
  importImage: (path: string) => invoke<ImageEntry>("import_image", { path }),
  renderView: (id: string, params: InvertParams, view: ViewSpec) =>
    invoke<string>("render_view", { id, params, view }),
  exportImage: (id: string, params: InvertParams, outPath: string) =>
    invoke<void>("export_image", { id, params, outPath }),
  developImage: (id: string) => invoke<ImageEntry>("develop_image", { id }),
  setQuality: (quality: Quality) => invoke<void>("set_quality", { quality }),
};

export const defaultParams = (): InvertParams => ({
  mode: "b", stock: "none", base_rect: null, exposure: 1, black: 0, gamma: 0.4545,
  auto_wb: true, temp: 0, tint: 0,
});
