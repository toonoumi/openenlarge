// app/src/lib/roll/exportSheet.ts
import { get } from "svelte/store";
import { save } from "@tauri-apps/plugin-dialog";
import { api, defaultParams } from "$lib/api";
import { editsById, cropById } from "$lib/store";
import { developedFolderImages } from "$lib/export/eligible";
import { withEffectiveBase } from "$lib/develop/base";
import { imageDir } from "$lib/library/folderScope";
import { draftThumbView } from "./livePreview";
import { layoutContactSheet } from "./contactSheet";

/** Render each developed frame at its own stored edits + crop, composite them
 *  into a contact-sheet canvas, and save the result as a PNG file chosen by
 *  the user via the OS save dialog. */
export async function exportContactSheet(): Promise<void> {
  const frames = get(developedFolderImages);
  if (frames.length === 0) return;

  const edits = get(editsById);
  const crops = get(cropById);

  // --- Render every frame tile ---
  const TILE_W = 400;
  const TILE_H = 300;

  const images = await Promise.all(
    frames.map(async (frame) => {
      const params = withEffectiveBase(
        edits[frame.id] ?? defaultParams(),
        imageDir(frame),
      );
      const crop = crops[frame.id] ?? null;
      const view = draftThumbView(crop);
      const dataUrl = await api.thumbnail(frame.id, params, view);

      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
      });
    }),
  );

  // --- Layout ---
  const count = images.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const layout = layoutContactSheet(count, {
    cols,
    tileW: TILE_W,
    tileH: TILE_H,
    gap: 12,
    margin: 24,
  });

  // --- Composite onto a canvas ---
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");

  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, layout.width, layout.height);

  for (let i = 0; i < images.length; i++) {
    const tile = layout.tiles[i];
    const img = images[i];

    // Object-fit: contain — letterbox inside the tile rect.
    const scaleX = tile.w / img.naturalWidth;
    const scaleY = tile.h / img.naturalHeight;
    const scale = Math.min(scaleX, scaleY);
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    const drawX = tile.x + (tile.w - drawW) / 2;
    const drawY = tile.y + (tile.h - drawH) / 2;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
  }

  // --- Encode to PNG base64 ---
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

  // --- OS save dialog ---
  const path = await save({
    defaultPath: "contact-sheet.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!path) return; // user cancelled

  // Write via the same Rust command used by AiEnhancePanel for PNG bytes.
  await api.saveEnhanced(path, base64, { kind: "png", bitDepth: 8 });
}
