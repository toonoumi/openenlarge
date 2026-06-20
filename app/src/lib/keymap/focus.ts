// Focus helpers shared by every global keydown handler (Develop, +page undo/redo).
//
// The crux of the Develop-view shortcut bugs (A/B): a range <input> keeps keyboard
// focus after you drag/click its thumb, so a handler that treats ANY focused
// <input> as "typing" silently swallows every shortcut until you click elsewhere.
// A range slider has no text to edit — letter nudges, Ctrl+C/V and image-nav must
// keep working while it is focused. Only GENUINE text entry should win the key.

/** True when focus is in a real text-entry field (so native typing/undo/copy wins).
 *  Range sliders are <input> too but carry no text, so they are NOT counted here. */
export function inTextField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.isContentEditable) return true;
  if (el.tagName === "INPUT") {
    const t = (el as HTMLInputElement).type;
    return ["text", "number", "search", "email", "url", "tel", "password", "datetime-local"].includes(t);
  }
  return false;
}

/** True when a range slider currently holds focus. Plain arrow keys should nudge
 *  the focused slider (native) rather than step images; our chord/combo shortcuts
 *  still fire (they preventDefault, so the slider never also moves). */
export function isRangeFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && el.tagName === "INPUT" && (el as HTMLInputElement).type === "range";
}
