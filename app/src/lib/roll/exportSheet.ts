// app/src/lib/roll/exportSheet.ts
import { get } from "svelte/store";
import { save } from "@tauri-apps/plugin-dialog";
import { api, defaultParams } from "$lib/api";
import { editsById, cropById, rollFilmEdge, rollEdgeText } from "$lib/store";
import { developedFolderImages } from "$lib/export/eligible";
import { withEffectiveBase } from "$lib/develop/base";
import { imageDir } from "$lib/library/folderScope";
import { draftThumbView } from "./livePreview";
import { pickTileAspect, fitContain } from "./contactSheet";

// ─── Layout constants (match on-screen filmstrip) ────────────────────────────
const STRIP_SIZE = 6;     // frames per strip row
const FRAME_W = 260;      // frame width in pixels

// Filmstrip rebate/spacing (pixels, scaled to frame size)
const SPROCKET_H = 8;
const FRAME_NUM_H = 26;
const REBATE_TOP_H = SPROCKET_H + FRAME_NUM_H;
const BARCODE_INFO_H = 26;
const REBATE_BOT_H = BARCODE_INFO_H + SPROCKET_H;
const EDGE_REPEATS = 3; // edge marking copies distributed across the strip
const FRAME_GAP = 7;      // gap between frames within a strip
const FRAME_PAD = 6;      // left+right padding inside the black frames row
const STRIP_GAP = 16;     // vertical gap between strips
const OUTER_MARGIN = 24;  // canvas edge margin on all sides

// Proof-grid constants (film-edge OFF)
const PROOF_SHADOW_SIZE = 3;
const PROOF_PADDING = 3;
const PROOF_CAPTION_H = 8 + 12; // 8px gap + 12px text line


// ─── Helper: draw sprocket holes (faint vertical ticks) ─────────────────────
function drawSprocketBand(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
) {
  // Replicate: repeating-linear-gradient(90deg, transparent 0-9px, rgba(216,207,184,.16) 9px-15px, transparent 15px-20px)
  // Tick every 20px, tick width 6px starting at offset 9px
  const tickW = 6;
  const period = 20;
  const offsetInPeriod = 9;
  ctx.fillStyle = "rgba(216,207,184,0.16)";
  let dx = x;
  while (dx < x + w) {
    const tickX = dx + offsetInPeriod;
    if (tickX + tickW > x && tickX < x + w) {
      const clampedX = Math.max(tickX, x);
      const clampedW = Math.min(tickX + tickW, x + w) - clampedX;
      ctx.fillRect(clampedX, y, clampedW, h);
    }
    dx += period;
  }
}

// ─── Helper: draw barcode (approximate the CSS gradient) ─────────────────────
function drawBarcode(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
) {
  // Replicate: repeating-linear-gradient(90deg,#c9c3b0 0 1px,transparent 1px 3px,#c9c3b0 3px 4px,transparent 4px 6px,#c9c3b0 6px 8px,transparent 8px 11px,#c9c3b0 11px 12px,transparent 12px 15px,#c9c3b0 15px 17px,transparent 17px 19px)
  // Pattern: [bar at 0-1], [gap 1-3], [bar 3-4], [gap 4-6], [bar 6-8], [gap 8-11], [bar 11-12], [gap 12-15], [bar 15-17], [gap 17-19], repeat every 19px
  const pattern: Array<[number, number]> = [[0,1],[3,4],[6,8],[11,12],[15,17]]; // [start, end] within 19px period
  const period = 19;
  ctx.fillStyle = "#c9c3b0";
  let dx = x;
  while (dx < x + w) {
    for (const [s, e] of pattern) {
      const bx = dx + s;
      const bw = e - s;
      if (bx < x + w && bx + bw > x) {
        const cx = Math.max(bx, x);
        const cw = Math.min(bx + bw, x + w) - cx;
        ctx.fillRect(cx, y, cw, h);
      }
    }
    dx += period;
  }
}

/** Render each developed frame at its own stored edits + crop, composite them
 *  into a contact-sheet canvas matching the on-screen film-strip design, and
 *  save the result as a PNG file chosen by the user via the OS save dialog. */
export async function exportContactSheet(): Promise<void> {
  const frames = get(developedFolderImages);
  if (frames.length === 0) return;

  const edits = get(editsById);
  const crops = get(cropById);
  const filmEdge = get(rollFilmEdge);
  const edgeText = get(rollEdgeText);

  // ── Render every frame tile via the backend (same as on-screen) ──────────
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

  // Ensure custom fonts are loaded before drawing text
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }

  // ── Chunk frames into strips of STRIP_SIZE ────────────────────────────────
  const strips: { imgs: HTMLImageElement[]; nums: string[]; padCount: number }[] = [];
  for (let i = 0; i < images.length; i += STRIP_SIZE) {
    const slice = images.slice(i, i + STRIP_SIZE);
    const nums = slice.map((_, j) => String(i + j + 1).padStart(2, "0"));
    strips.push({ imgs: slice, nums, padCount: STRIP_SIZE - slice.length });
  }

  // ── Tile aspect from the roll's actual frame shapes (matches on-screen) ───
  // Landscape frames fill their tile edge-to-edge; every tile is FRAME_H tall.
  const tileAspect = pickTileAspect(
    images.map((im) => (im.naturalWidth > 0 && im.naturalHeight > 0 ? im.naturalWidth / im.naturalHeight : 0)),
  );
  const FRAME_H = Math.round(FRAME_W / tileAspect);

  // ── Compute canvas geometry ───────────────────────────────────────────────
  // Strip width: 6 frames + gaps + padding on both sides
  const stripContentW = STRIP_SIZE * FRAME_W + (STRIP_SIZE - 1) * FRAME_GAP + 2 * FRAME_PAD;

  let canvasW: number;
  let canvasH: number;

  if (filmEdge) {
    // Each strip: rebate-top + frames-row (FRAME_H) + rebate-bottom
    const perStripH = REBATE_TOP_H + FRAME_H + REBATE_BOT_H;
    const totalStripsH = strips.length * perStripH + Math.max(0, strips.length - 1) * STRIP_GAP;
    canvasW = 2 * OUTER_MARGIN + stripContentW;
    canvasH = 2 * OUTER_MARGIN + totalStripsH;
  } else {
    // Each proof strip: proof-frame (PROOF_PADDING*2 + FRAME_H) + caption
    const perStripH = PROOF_PADDING * 2 + FRAME_H + PROOF_CAPTION_H;
    const totalStripsH = strips.length * perStripH + Math.max(0, strips.length - 1) * STRIP_GAP;
    canvasW = 2 * OUTER_MARGIN + stripContentW;
    canvasH = 2 * OUTER_MARGIN + totalStripsH;
  }

  // ── Create canvas ─────────────────────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");

  // Background
  ctx.fillStyle = "#0b0b0c";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // ── Draw strips ───────────────────────────────────────────────────────────
  let cursorY = OUTER_MARGIN;
  const leftX = OUTER_MARGIN;

  for (let si = 0; si < strips.length; si++) {
    const strip = strips[si];
    const rowH = FRAME_H; // fixed landscape tile height for every strip

    if (filmEdge) {
      // ── FILMSTRIP mode ──────────────────────────────────────────────────
      const stripW = stripContentW;
      const stripH = REBATE_TOP_H + rowH + REBATE_BOT_H;

      // TOP REBATE (background #131210)
      ctx.fillStyle = "#131210";
      ctx.fillRect(leftX, cursorY, stripW, REBATE_TOP_H);

      // Sprocket holes — top band
      drawSprocketBand(ctx, leftX, cursorY, stripW, SPROCKET_H);

      // Frame numbers
      ctx.fillStyle = "#a39a82";
      ctx.font = "600 18px 'Spline Sans Mono', ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const numY = cursorY + SPROCKET_H + FRAME_NUM_H / 2;
      for (let fi = 0; fi < STRIP_SIZE; fi++) {
        const frameLeft = leftX + FRAME_PAD + fi * (FRAME_W + FRAME_GAP);
        const frameCenterX = frameLeft + FRAME_W / 2;
        if (fi < strip.nums.length) {
          ctx.fillText(strip.nums[fi], frameCenterX, numY);
        }
      }

      cursorY += REBATE_TOP_H;

      // FRAMES ROW (black background) — height = rowH for this strip
      ctx.fillStyle = "#000";
      ctx.fillRect(leftX, cursorY, stripW, rowH);

      // Draw each frame fit (contained) inside its fixed landscape tile, flush left
      // (no leading gap) + vertically centered. Slack letterboxes against the black row.
      for (let fi = 0; fi < strip.imgs.length; fi++) {
        const img = strip.imgs[fi];
        const frameLeft = leftX + FRAME_PAD + fi * (FRAME_W + FRAME_GAP);
        const { dx, dy, dw, dh } = fitContain(img.naturalWidth, img.naturalHeight, FRAME_W, rowH, "left");
        ctx.drawImage(img, frameLeft + dx, cursorY + dy, dw, dh);
      }

      cursorY += rowH;

      // BOTTOM REBATE (background #131210)
      ctx.fillStyle = "#131210";
      ctx.fillRect(leftX, cursorY, stripW, REBATE_BOT_H);

      // Info row: barcode + edge text + arrow
      const infoY = cursorY;
      const infoMidY = infoY + BARCODE_INFO_H / 2;

      // Barcode (34×11px)
      const barcodeW = 34;
      const barcodeX = leftX + 12;
      const barcodeY = infoY + (BARCODE_INFO_H - 11) / 2;
      drawBarcode(ctx, barcodeX, barcodeY, barcodeW, 11);

      // Arrow "→" on the right
      ctx.fillStyle = "#7a7464";
      ctx.font = "600 16px 'Spline Sans Mono', ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const arrowX = leftX + stripW - 12;
      ctx.fillText("→", arrowX, infoMidY);

      // Edge text — repeated and evenly distributed between the barcode and arrow
      ctx.fillStyle = "#968f7c";
      ctx.font = "600 15px 'Spline Sans Mono', ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.letterSpacing = "0.24em";
      const trackLeft = barcodeX + barcodeW + 16;
      const trackRight = arrowX - 24;
      const trackW = Math.max(0, trackRight - trackLeft);
      for (let r = 0; r < EDGE_REPEATS; r++) {
        const cx = trackLeft + (trackW * (r + 0.5)) / EDGE_REPEATS;
        ctx.fillText(edgeText, cx, infoMidY);
      }
      ctx.letterSpacing = "0px";

      // Sprocket holes — bottom band
      drawSprocketBand(ctx, leftX, cursorY + BARCODE_INFO_H, stripW, SPROCKET_H);

      cursorY += REBATE_BOT_H;
      cursorY += STRIP_GAP;

    } else {
      // ── PROOF GRID mode ─────────────────────────────────────────────────
      // Each cell: proof-frame (shadow + #d8d3c4 bg + 3px padding + image at true aspect) + caption below
      const proofCellW = FRAME_W;
      const proofFrameH = PROOF_PADDING * 2 + rowH;

      for (let fi = 0; fi < STRIP_SIZE; fi++) {
        const cellLeft = leftX + fi * (proofCellW + FRAME_GAP);

        if (fi < strip.imgs.length) {
          const img = strip.imgs[fi];

          // Shadow (dark rect behind)
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(cellLeft + 2, cursorY + 2, proofCellW, proofFrameH);

          // Warm-white background
          ctx.fillStyle = "#d8d3c4";
          ctx.fillRect(cellLeft, cursorY, proofCellW, proofFrameH);

          // Image fit (contained) inside the padded tile, flush left + vertically
          // centered. Slack letterboxes against the warm-white background.
          const innerW = proofCellW - PROOF_PADDING * 2;
          const innerH = proofFrameH - PROOF_PADDING * 2;
          const { dx, dy, dw, dh } = fitContain(img.naturalWidth, img.naturalHeight, innerW, innerH, "left");
          ctx.drawImage(
            img,
            cellLeft + PROOF_PADDING + dx,
            cursorY + PROOF_PADDING + dy,
            dw,
            dh,
          );

          // Caption below frame
          ctx.fillStyle = "#6f6a5e";
          ctx.font = "600 12px 'Spline Sans Mono', ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(strip.nums[fi], cellLeft + proofCellW / 2, cursorY + proofFrameH + 8);
        }
        // Pad cells: leave empty (background shows through)
      }

      cursorY += proofFrameH + PROOF_CAPTION_H;
      cursorY += STRIP_GAP;
    }
  }

  // ── Encode to PNG base64 ──────────────────────────────────────────────────
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

  // ── OS save dialog ────────────────────────────────────────────────────────
  const path = await save({
    defaultPath: "contact-sheet.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!path) return; // user cancelled

  // Write via the same Rust command used by AiEnhancePanel for PNG bytes.
  await api.saveEnhanced(path, base64, { kind: "png", bitDepth: 8 });
}
