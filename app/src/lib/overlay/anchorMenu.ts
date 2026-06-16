/**
 * Svelte action: position a fixed-position menu at a cursor point, flipping and
 * clamping so it never spills past the viewport edges. The element is measured
 * after insertion (transform from a scale transition doesn't affect offsetWidth/
 * Height, so this stays correct mid-animation).
 */
export function anchorMenu(node: HTMLElement, point: { x: number; y: number }) {
  const M = 8; // keep this margin from each edge

  function place({ x, y }: { x: number; y: number }) {
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    // Prefer down-right of the cursor; flip to the other side when it wouldn't fit.
    let left = x + w > window.innerWidth - M ? x - w : x;
    let top = y + h > window.innerHeight - M ? y - h : y;
    // Final clamp in case neither side fully fits (menu taller/wider than space).
    left = Math.max(M, Math.min(left, window.innerWidth - w - M));
    top = Math.max(M, Math.min(top, window.innerHeight - h - M));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  place(point);
  return {
    update(p: { x: number; y: number }) { place(p); },
  };
}
