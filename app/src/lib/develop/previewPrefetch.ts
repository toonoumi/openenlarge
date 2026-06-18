import { get, type Unsubscriber } from "svelte/store";
import {
  activeId, folderImages, images, editsById, cropById, dustById, developRev, module,
  previewById, cachePreview,
} from "../store";
import { api, defaultParams, type ViewSpec, type InvertParams } from "../api";
import { withEffectiveBase } from "./base";
import { imageDir } from "../library/folderScope";
import { orientDims } from "../crop/transforms";
import { emptyDust } from "./dust";

/**
 * Idle preview prefetcher: while the user isn't interacting, render ~1080p finished
 * previews for the *already-developed* images nearest the active one and stash them in
 * `previewById`, so a first click shows them instantly via the Viewport's switch overlay.
 *
 * Deliberately conservative: developed images only (never speculatively develops),
 * one render at a time off the UI thread (`render_view` → spawn_blocking), nearest-first,
 * and cancelled the moment the user navigates or edits. Display-only — never touches export.
 */

export interface PrefetchOpts {
  /** Quiet period (ms) after the last interaction before prefetching starts. */
  idleMs?: number;
  /** Max images to keep warm around the active one. */
  budget?: number;
  /** Long-edge target for the rendered preview. */
  longEdge?: number;
  /** Pause (ms) between renders so the loop never hogs the backend. */
  gapMs?: number;
}

/** Build the (params, ViewSpec) for one image's full fit-view preview — the same inputs
 *  Develop's active path feeds `render_view`, but assembled for an arbitrary id. */
function previewInputsFor(id: string, longEdge: number): { params: InvertParams; view: ViewSpec } | null {
  const img = get(images).find((i) => i.id === id);
  if (!img || !img.developed) return null;
  const params = withEffectiveBase(get(editsById)[id] ?? defaultParams(), imageDir(img));
  const c = get(cropById)[id] ?? null;
  const d = get(dustById)[id] ?? emptyDust();
  const cRot = c?.rot90 ?? 0;
  const [coW, coH] = orientDims(img.metadata.width, img.metadata.height, cRot);
  const effW = c ? Math.max(1, Math.round(c.rect.w * coW)) : coW;
  const effH = c ? Math.max(1, Math.round(c.rect.h * coH)) : coH;
  const scale = Math.min(1, longEdge / Math.max(effW, effH));
  const out_w = Math.max(1, Math.round(effW * scale));
  const out_h = Math.max(1, Math.round(effH * scale));
  const view: ViewSpec = {
    crop: [0, 0, effW, effH], out_w, out_h, raw: false, finish: true,
    image_crop: c ? [c.rect.x, c.rect.y, c.rect.w, c.rect.h] : null,
    rot90: cRot, flip_h: c?.flipH ?? false, flip_v: c?.flipV ?? false, angle: c?.angle ?? 0,
    dust: d.strokes, ir_removal: d.irRemoval,
  };
  return { params, view };
}

export function createPreviewPrefetcher(opts: PrefetchOpts = {}): { stop: () => void } {
  const idleMs = opts.idleMs ?? 1200;
  const budget = opts.budget ?? 24;
  const longEdge = opts.longEdge ?? 1080;
  const gapMs = opts.gapMs ?? 30;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let token = 0; // bumped on every interaction; an in-flight loop bails when it changes
  let running = false;
  let stopped = false;
  const unsubs: Unsubscriber[] = [];

  // Developed, not-yet-cached images, ordered by distance from the active one.
  function queue(): string[] {
    const imgs = get(folderImages);
    const active = get(activeId);
    const cache = get(previewById);
    const ai = imgs.findIndex((i) => i.id === active);
    const base = ai >= 0 ? ai : 0;
    return imgs
      .map((img, i) => ({ img, i }))
      .filter(({ img }) => img.developed && img.id !== active && !cache[img.id])
      .sort((a, b) => Math.abs(a.i - base) - Math.abs(b.i - base))
      .slice(0, budget)
      .map(({ img }) => img.id);
  }

  async function runLoop() {
    if (stopped || running || get(module) !== "develop") return;
    running = true;
    const myToken = token;
    try {
      for (const id of queue()) {
        if (stopped || token !== myToken) break; // interaction → abandon this pass
        try {
          const inputs = previewInputsFor(id, longEdge);
          if (!inputs) continue;
          const url = await api.renderView(id, inputs.params, inputs.view);
          if (stopped || token !== myToken) break;
          cachePreview(id, url);
        } catch (e) {
          // "not developed" can happen if the buffer was evicted and re-decode failed;
          // just skip — this is best-effort warming, never user-facing.
          if (!(typeof e === "string" && e === "not developed")) console.error("preview prefetch failed", id, e);
        }
        await new Promise((r) => setTimeout(r, gapMs)); // breathe between renders
      }
    } finally {
      running = false;
    }
  }

  function bumpIdle() {
    if (stopped) return;
    token++; // cancel any running pass; it'll be rescheduled once things settle
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(runLoop, idleMs);
  }

  // Any of these changing = "the user is doing something" → reset the idle clock.
  // (Each subscribe fires once immediately, which just arms the initial timer.)
  for (const s of [activeId, folderImages, developRev, editsById, cropById, dustById, module]) {
    unsubs.push(s.subscribe(() => bumpIdle()));
  }

  return {
    stop() {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      unsubs.forEach((u) => u());
    },
  };
}
