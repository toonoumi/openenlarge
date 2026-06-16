<script lang="ts">
  // A small "?" help chip with a hover/focus tooltip. Matches the .help/.tip look
  // used across the develop panels, but self-positions its bubble so it works inline
  // next to a button (native `title` tooltips are unreliable in the Tauri webview).
  export let text: string;
</script>

<button type="button" class="help" aria-label={text}>
  ?
  <span class="tip" role="tooltip">{text}</span>
</button>

<style>
  .help { position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; padding: 0; border-radius: 50%;
    border: 1px solid var(--glass-brd); background: transparent;
    color: var(--text-dim); font-size: 10px; font-weight: 600; line-height: 1;
    cursor: help; user-select: none; }
  .help:hover, .help:focus-visible { color: var(--text); border-color: var(--accent); outline: none; }
  .tip { position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 50;
    width: max-content; max-width: 220px; padding: 8px 10px; border-radius: 8px;
    background: var(--bg-1); border: 1px solid var(--glass-brd);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    color: var(--text-dim); font-size: 11px; font-weight: 400; line-height: 1.5;
    text-align: left; opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity 0.14s ease; }
  .help:hover .tip, .help:focus-visible .tip { opacity: 1; visibility: visible; }
</style>
