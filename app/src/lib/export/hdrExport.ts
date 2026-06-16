import type { ExportFormat, InvertParams } from "../api";

/** Gain-map HDR export applies only to JPEG output for HDR-toggled images. */
export function wantsHdrExport(kind: ExportFormat["kind"], params: InvertParams): boolean {
  return kind === "jpeg" && params.hdr === true;
}
