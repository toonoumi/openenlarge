import type { Action } from "svelte/action";

/**
 * Drag-to-scrub: turn a slider's *displayed number* into a fine value control.
 *
 * Two modes, chosen by the params shape:
 *
 * - **Input mode** (`{ input }`): the number remote-controls its sibling
 *   <input type="range"> — a drag sets `input.value` and re-dispatches the same
 *   DOM events the thumb would (`input` per move, `change` on release). Downstream
 *   `bind:value`, `on:input`/`on:change` handlers (incl. ones reading
 *   `e.target.value`) and the window-delegated `commitActive()` all fire exactly
 *   as if the thumb were dragged, with no per-call-site plumbing. Steps come from
 *   the input's own `step`, so this stays correct for plain linear sliders.
 *
 * - **Controller mode** (`{ get, set, min, max, step }`): the drag works directly
 *   in a value domain you supply, with an explicit `step`. Use this when the
 *   displayed value is not the input's value — e.g. the reciprocal colour-
 *   temperature slider, whose <input> is in mired-position units but which should
 *   scrub in whole kelvin. `set` is called per move; optional `commit` once on
 *   release. The host is responsible for any side effects (e.g. firing on:input).
 */

const BASE_PX_PER_STEP = 10; // super-micro: 10 px of travel per step (1/10 the change per px)
const DEAD_ZONE = 3; // px before a press counts as a drag (preserves plain clicks)
const FINE_FACTOR = 8; // hold the fine key → 8× slower (8 px per step), never sub-step

interface CommonScrubOpts {
  /** Modifier that engages fine (slower) scrubbing. Default "Shift". */
  fineKey?: "Shift" | "Alt" | "Control" | "Meta";
  /** Pixels per step when the fine key is held. Default 8. */
  fineFactor?: number;
  /** Pixels of travel per step. Default 10. */
  pxPerStep?: number;
}

export interface InputScrubParams extends CommonScrubOpts {
  /** The range input this number mirrors. May be undefined on first run (bind:this). */
  input: HTMLInputElement | null | undefined;
}

export interface ControllerScrubParams extends CommonScrubOpts {
  /** Current value in the scrub's own domain. */
  get: () => number;
  /** Push a new value (called live, per move). */
  set: (v: number) => void;
  /** Bounds and increment, all in the same domain as get/set. */
  min: number;
  max: number;
  step: number;
  /** Called once on release after a real net change (e.g. history commit). */
  commit?: () => void;
  /** When true, scrubbing is inert (e.g. a disabled control). */
  disabled?: boolean;
}

export type ScrubParams = InputScrubParams | ControllerScrubParams;

function isController(p: ScrubParams): p is ControllerScrubParams {
  return typeof (p as ControllerScrubParams).get === "function";
}

/** Geometry for {@link computeScrubValue}. All values share one numeric domain. */
export interface ScrubGeometry {
  /** Value at pointer-down. */
  startValue: number;
  /** Effective horizontal travel in px (dead-zone already removed). */
  dx: number;
  /** Pixels per step (>0). */
  pxPerStep: number;
  /** Step grid (falls back to 1 upstream). */
  step: number;
  /** Lower bound (grid is anchored here). */
  min: number;
  /** Upper bound. */
  max: number;
}

/** Strip binary-float dust (e.g. 0.30000000000000004 → 0.3) without assuming decimals. */
function clean(n: number): number {
  return n === 0 ? 0 : parseFloat(n.toPrecision(12));
}

/**
 * Pure scrub math: map drag distance to a snapped, clamped value. Recomputed
 * absolutely from `startValue` each move (never accumulated) so long drags and
 * repeated micro-adjusts don't drift. Snapping is anchored to `min`, matching how
 * a native range input quantises relative to its minimum.
 */
export function computeScrubValue({ startValue, dx, pxPerStep, step, min, max }: ScrubGeometry): number {
  const s = step || 1;
  const raw = startValue + Math.round(dx / pxPerStep) * s;
  const snapped = Math.round((raw - min) / s) * s + min;
  return clean(Math.min(max, Math.max(min, snapped)));
}

/** Resolved, mode-independent handle to the value being scrubbed (read at pointer-down). */
interface ScrubSession {
  write: (v: number) => void;
  commit: () => void;
  min: number;
  max: number;
  step: number;
  pxBase: number;
}

export const scrubValue: Action<HTMLElement, ScrubParams> = (node, initial) => {
  let params = initial;

  let active = false;
  let moved = false;
  let fineActive = false;
  let pressX = 0; // where the press began — fixed dead-zone reference
  let pressValue = 0; // value at pointer-down — fixed net-change reference
  let startX = 0; // travel anchor — re-seated when the drag arms or the fine key toggles
  let startValue = 0; // value at the current anchor
  let lastSet = NaN; // last value we wrote, to avoid redundant updates
  let sess: ScrubSession | null = null;

  function fineHeld(e: PointerEvent): boolean {
    const key = params.fineKey ?? "Shift";
    return (
      (key === "Shift" && e.shiftKey) ||
      (key === "Alt" && e.altKey) ||
      (key === "Control" && e.ctrlKey) ||
      (key === "Meta" && e.metaKey)
    );
  }

  function attrNum(input: HTMLInputElement, attr: string, fallback: number): number {
    const raw = input.getAttribute(attr);
    if (raw === null || raw === "" || raw === "any") return fallback;
    const v = +raw;
    return Number.isFinite(v) ? v : fallback;
  }

  function isDisabled(): boolean {
    if (isController(params)) return !!params.disabled;
    return !params.input || params.input.disabled;
  }

  /** Snapshot the value handle at pointer-down so the drag is immune to re-renders. */
  function openSession(): boolean {
    const pxBase = params.pxPerStep ?? BASE_PX_PER_STEP;
    if (isController(params)) {
      const p = params;
      startValue = p.get();
      sess = { write: p.set, commit: p.commit ?? (() => {}), min: p.min, max: p.max, step: p.step || 1, pxBase };
      return true;
    }
    const input = params.input;
    if (!input) return false;
    startValue = +input.value;
    sess = {
      write: (v) => {
        input.value = String(v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      commit: () => input.dispatchEvent(new Event("change", { bubbles: true })),
      min: attrNum(input, "min", 0),
      max: attrNum(input, "max", 100),
      step: attrNum(input, "step", 1) || 1,
      pxBase,
    };
    return true;
  }

  function onDown(e: PointerEvent) {
    if (isDisabled() || e.button !== 0) return;
    if (!openSession()) return;
    active = true;
    moved = false;
    fineActive = fineHeld(e);
    pressX = startX = e.clientX;
    pressValue = lastSet = startValue;
    node.setPointerCapture(e.pointerId);
    e.preventDefault(); // suppress text selection / focus shifts on the number
  }

  function onMove(e: PointerEvent) {
    if (!active || !sess) return;
    // TODO(rtl): no RTL locale ships today; invert sign here if one is added.
    if (!moved) {
      if (Math.abs(e.clientX - pressX) < DEAD_ZONE) return;
      moved = true;
      startX = e.clientX; // anchor at the threshold crossing so the value ramps from 0, no jump
    }
    const fineNow = fineHeld(e);
    if (fineNow !== fineActive) {
      // Toggling the fine key mid-drag re-anchors travel, so the granularity changes
      // smoothly from here on instead of snapping the value to a new position.
      fineActive = fineNow;
      startX = e.clientX;
      startValue = lastSet;
    }
    const dx = e.clientX - startX;
    const pxPerStep = sess.pxBase * (fineActive ? (params.fineFactor ?? FINE_FACTOR) : 1);
    const next = computeScrubValue({ startValue, dx, pxPerStep, step: sess.step, min: sess.min, max: sess.max });
    if (next !== lastSet) {
      lastSet = next;
      sess.write(next);
    }
  }

  function onUp(e: PointerEvent) {
    if (!active) return;
    active = false;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    // Commit only on a real net change (matches native range): a pure click or a
    // clamped no-op drag stays silent, so expensive consumers don't re-run.
    if (lastSet !== pressValue && sess) sess.commit();
    moved = false;
    sess = null;
  }

  function refreshAffordance() {
    const on = !isDisabled();
    node.classList.toggle("scrubbable", on);
    node.style.cursor = on ? "ew-resize" : "";
    node.style.touchAction = on ? "none" : "";
    node.style.userSelect = on ? "none" : "";
  }

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);
  refreshAffordance();

  return {
    update(p: ScrubParams) {
      params = p;
      refreshAffordance();
    },
    destroy() {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    },
  };
};
