/** Normalized rectangle on the original image, components in 0..1. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Committed per-image crop. aspect is a preset id or "custom". */
export interface CropRect {
  rect: Rect;
  aspect: string;
  orientation: "landscape" | "portrait";
}

export type Handle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | null;
