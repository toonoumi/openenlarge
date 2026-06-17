<script lang="ts">
  import { reciprocalPos, reciprocalValue, reciprocalSpan } from "./sliderScale";
  import { scrubValue } from "$lib/actions/scrubValue";
  import { createEventDispatcher } from "svelte";

  export let label: string;
  export let min: number;
  export let max: number;
  export let step = 1;                 // for scale="reciprocal", in position units
  export let value: number;
  export let def = 0;                 // double-click reset target
  export let gradient = "";           // CSS background for the track
  export let format: (v: number) => string = (v) => `${Math.round(v)}`;
  export let scale: "linear" | "reciprocal" = "linear";
  // Number-scrub increment for a non-linear (reciprocal) scale, in natural units
  // (e.g. kelvin) — `step` is in position units there so it can't be reused. Linear
  // sliders ignore this and scrub by the <input>'s own `step`.
  export let scrubStep: number | undefined = undefined;

  const dispatch = createEventDispatcher();

  // `value`, `def`, `min`/`max` and `format` stay in natural units; only the
  // <input> domain is transformed so a non-linear scale is fully contained here.
  $: recip = scale === "reciprocal";
  $: inMin = recip ? 0 : min;
  $: inMax = recip ? reciprocalSpan(min, max) : max;
  $: pos = recip ? reciprocalPos(value, min) : value;
  let inputEl: HTMLInputElement;
  function onInput(e: Event) {
    const p = +(e.currentTarget as HTMLInputElement).value;
    value = recip ? reciprocalValue(p, min) : p;
  }
  // Controller-mode scrub for the reciprocal scale: set the natural value and mirror
  // the on:input side effects a real <input> event would (thumb follows via `pos`).
  function scrubSet(v: number) {
    value = v;
    dispatch("input");
  }
</script>

<div class="slider">
  <div class="row">
    <span class="label" on:dblclick={() => (value = def)}>{label}</span>
    <span class="val"
      use:scrubValue={recip
        ? { get: () => value, set: scrubSet, min, max, step: scrubStep ?? step }
        : { input: inputEl }}>{format(value)}</span>
  </div>
  <input
    bind:this={inputEl}
    type="range" min={inMin} max={inMax} {step} value={pos}
    class:grad={!!gradient}
    style={gradient ? `--track:${gradient}` : ""}
    on:input={onInput}
    on:dblclick={() => (value = def)}
    on:input
  />
</div>

<style>
  .slider { margin: 7px 0; }
  .row { display: flex; justify-content: space-between; font-size: 11px;
    color: var(--text-dim); margin-bottom: 2px; }
  .val { color: var(--text); font-variant-numeric: tabular-nums; }
  .label { cursor: default; }
  input[type="range"] { width: 100%; height: 3px; border-radius: 3px;
    -webkit-appearance: none; appearance: none; background: var(--glass-brd);
    accent-color: var(--accent); }
  input.grad { background: var(--track); }
  input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none;
    width: 12px; height: 12px; border-radius: 50%; background: #fff;
    border: 1px solid rgba(0,0,0,0.3); box-shadow: 0 1px 3px rgba(0,0,0,0.4); cursor: grab; }
  input[type="range"]:active::-webkit-slider-thumb { cursor: grabbing; }
</style>
