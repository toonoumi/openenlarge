import type { ExportFormat } from "../api";

export function extFor(kind: ExportFormat["kind"]): string {
  switch (kind) {
    case "jpeg": return "jpg";
    case "tiff": return "tiff";
    case "png": return "png";
  }
}

/** Map an original filename to `<stem>.<ext>` for the chosen format. */
export function outName(fileName: string, kind: ExportFormat["kind"]): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${extFor(kind)}`;
}
