<script lang="ts">
  export let pad = 12;
  /** When false, drop the shadows and keep only the border (stroke). */
  export let shadow = true;
</script>

<div class="glass" class:flat={!shadow} style="padding:{pad}px">
  <slot />
</div>

<style>
  .glass {
    background: var(--glass-bg);
    border: 1px solid var(--glass-brd);
    border-radius: var(--radius);
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    box-shadow: inset 0 1px 0 var(--glass-hi), 0 8px 30px rgba(0,0,0,0.35);
    overflow: auto;
    height: 100%;
  }
  /* Flat: no shadow and blended into the page background (stroke only). The solid
     fill makes the backdrop blur a no-op, so drop it. */
  .glass.flat { box-shadow: none; background: #111111; backdrop-filter: none; -webkit-backdrop-filter: none; }
</style>
