import { writable } from "svelte/store";

/** A transient status message. `id` lets the view re-trigger its transition when
 *  a new toast replaces a still-visible one. */
export interface Toast { id: number; msg: string }

export const toast = writable<Toast | null>(null);

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Show a transient toast that auto-dismisses after `ms`. A new toast replaces
 *  any currently-showing one and resets the timer. */
export function showToast(msg: string, ms = 2400): void {
  if (timer) clearTimeout(timer);
  const id = ++seq;
  toast.set({ id, msg });
  timer = setTimeout(() => {
    // Only clear if no newer toast has taken over in the meantime.
    toast.update((cur) => (cur && cur.id === id ? null : cur));
    timer = null;
  }, ms);
}
