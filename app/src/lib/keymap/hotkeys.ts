// Central keyboard-shortcut registry: the SINGLE source of truth for both the
// handlers (Develop.svelte onKey, +page undo/redo) and the editable Keyboard
// Shortcuts UI. Every action carries its default binding(s); user overrides live
// in the `hotkeyBindings` store (persisted via prefs) and are merged on top.
//
// Two binding shapes:
//   • combo  — a key plus modifiers, matched on a single keydown (nav, rotate,
//              flip, copy/paste, undo/redo, crop commit/discard/swap).
//   • chord  — a bare "selector" key you HOLD while tapping ← / → to nudge a
//              develop parameter down/up (1·temp, 2·tint, q·exposure, …).
//   • modifier — a lone modifier used as a flag (Shift = fine step / lock aspect).

/** The platform-modifier resolves to ⌘ on macOS, Ctrl elsewhere. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator.platform || navigator.userAgent || "").toLowerCase();
  return p.includes("mac");
}

/** A single key combination. `mod` is the platform modifier (⌘/Ctrl). */
export interface Binding {
  key: string;        // canonical token: lowercase letter/digit, or "ArrowLeft"/"Enter"/"["…
  mod?: boolean;      // ⌘ on macOS, Ctrl elsewhere
  shift?: boolean;
  alt?: boolean;
}

/** Develop parameters reachable via a hold-selector + arrow chord. */
export type AdjustParam =
  | "temp" | "tint" | "exposure" | "contrast"
  | "highlights" | "shadows" | "whites" | "blacks";

export interface HotkeyAction {
  id: string;
  group: string;                 // i18n heading key
  label: string;                 // i18n label key
  kind: "combo" | "chord" | "modifier";
  defs: Binding[];               // default binding(s); first is primary
  rebindable: boolean;
  context?: "crop";              // active only inside the crop tool
  param?: AdjustParam;           // for chord actions
}

/** Override map: action id → its replacement binding list (empty/absent = default). */
export type BindingOverrides = Record<string, Binding[]>;

// ---- The registry -----------------------------------------------------------

export const ACTIONS: HotkeyAction[] = [
  // Navigation
  { id: "nav.prev",  group: "keymap.group.navigation", label: "keymap.nav.prev",  kind: "combo", rebindable: true, defs: [{ key: "ArrowLeft" }] },
  { id: "nav.next",  group: "keymap.group.navigation", label: "keymap.nav.next",  kind: "combo", rebindable: true, defs: [{ key: "ArrowRight" }] },
  { id: "nav.first", group: "keymap.group.navigation", label: "keymap.nav.first", kind: "combo", rebindable: true, defs: [{ key: "ArrowUp" }] },
  { id: "nav.last",  group: "keymap.group.navigation", label: "keymap.nav.last",  kind: "combo", rebindable: true, defs: [{ key: "ArrowDown" }] },
  { id: "select.all", group: "keymap.group.navigation", label: "keymap.nav.selectAll", kind: "combo", rebindable: true, defs: [{ key: "a", mod: true }] },
  { id: "nav.delete", group: "keymap.group.navigation", label: "keymap.nav.delete", kind: "combo", rebindable: true, defs: [{ key: "Backspace", mod: true }] },

  // Editing
  { id: "edit.undo", group: "keymap.group.editing", label: "keymap.edit.undo", kind: "combo", rebindable: true, defs: [{ key: "z", mod: true }] },
  { id: "edit.redo", group: "keymap.group.editing", label: "keymap.edit.redo", kind: "combo", rebindable: true, defs: [{ key: "z", mod: true, shift: true }] },
  { id: "edit.rotateCCW", group: "keymap.group.editing", label: "keymap.edit.rotateCCW", kind: "combo", rebindable: true, defs: [{ key: "[", mod: true }, { key: "ArrowLeft", mod: true }] },
  { id: "edit.rotateCW",  group: "keymap.group.editing", label: "keymap.edit.rotateCW",  kind: "combo", rebindable: true, defs: [{ key: "]", mod: true }, { key: "ArrowRight", mod: true }] },
  { id: "edit.flipV", group: "keymap.group.editing", label: "keymap.edit.flipV", kind: "combo", rebindable: true, defs: [{ key: "ArrowUp", mod: true }] },
  { id: "edit.flipH", group: "keymap.group.editing", label: "keymap.edit.flipH", kind: "combo", rebindable: true, defs: [{ key: "ArrowDown", mod: true }] },
  { id: "edit.copySettings",  group: "keymap.group.editing", label: "keymap.edit.copySettings",  kind: "combo", rebindable: true, defs: [{ key: "c", mod: true }] },
  { id: "edit.pasteSettings", group: "keymap.group.editing", label: "keymap.edit.pasteSettings", kind: "combo", rebindable: true, defs: [{ key: "v", mod: true }] },

  // Adjustments (hold the key, tap ← / →; Shift = fine step)
  { id: "adjust.temp",       group: "keymap.group.adjust", label: "keymap.adjust.temp",       kind: "chord", rebindable: true, param: "temp",       defs: [{ key: "1" }] },
  { id: "adjust.tint",       group: "keymap.group.adjust", label: "keymap.adjust.tint",       kind: "chord", rebindable: true, param: "tint",       defs: [{ key: "2" }] },
  { id: "adjust.exposure",   group: "keymap.group.adjust", label: "keymap.adjust.exposure",   kind: "chord", rebindable: true, param: "exposure",   defs: [{ key: "q" }] },
  { id: "adjust.contrast",   group: "keymap.group.adjust", label: "keymap.adjust.contrast",   kind: "chord", rebindable: true, param: "contrast",   defs: [{ key: "w" }] },
  { id: "adjust.highlights", group: "keymap.group.adjust", label: "keymap.adjust.highlights", kind: "chord", rebindable: true, param: "highlights", defs: [{ key: "a" }] },
  { id: "adjust.shadows",    group: "keymap.group.adjust", label: "keymap.adjust.shadows",    kind: "chord", rebindable: true, param: "shadows",    defs: [{ key: "s" }] },
  { id: "adjust.whites",     group: "keymap.group.adjust", label: "keymap.adjust.whites",     kind: "chord", rebindable: true, param: "whites",     defs: [{ key: "z" }] },
  { id: "adjust.blacks",     group: "keymap.group.adjust", label: "keymap.adjust.blacks",     kind: "chord", rebindable: true, param: "blacks",     defs: [{ key: "x" }] },
  { id: "adjust.fine",       group: "keymap.group.adjust", label: "keymap.adjust.fine",       kind: "modifier", rebindable: false, defs: [{ key: "shift", shift: true }] },

  // Crop tool
  { id: "crop.commit",     group: "keymap.group.crop", label: "keymap.crop.commit",  kind: "combo", rebindable: false, context: "crop", defs: [{ key: "Enter" }] },
  { id: "crop.discard",    group: "keymap.group.crop", label: "keymap.crop.discard", kind: "combo", rebindable: false, context: "crop", defs: [{ key: "Escape" }] },
  { id: "crop.swap",       group: "keymap.group.crop", label: "keymap.crop.swap",    kind: "combo", rebindable: true,  context: "crop", defs: [{ key: "x" }] },
  { id: "crop.lockAspect", group: "keymap.group.crop", label: "keymap.crop.lockAspect", kind: "modifier", rebindable: false, defs: [{ key: "shift", shift: true }] },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
export const actionById = (id: string): HotkeyAction | undefined => BY_ID.get(id);

/** Ordered list of groups (heading + actions) for the shortcuts UI. */
export function groupedActions(): { heading: string; items: HotkeyAction[] }[] {
  const order: string[] = [];
  const map = new Map<string, HotkeyAction[]>();
  for (const a of ACTIONS) {
    if (!map.has(a.group)) { map.set(a.group, []); order.push(a.group); }
    map.get(a.group)!.push(a);
  }
  return order.map((heading) => ({ heading, items: map.get(heading)! }));
}

// ---- Normalization & matching -----------------------------------------------

/** Canonical key token: single chars lowercased, named keys kept verbatim. */
export function normKey(k: string): string {
  return k.length === 1 ? k.toLowerCase() : k;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** The effective binding list for an action (override if present, else default). */
export function effectiveDefs(action: HotkeyAction, overrides: BindingOverrides): Binding[] {
  const o = overrides[action.id];
  return o && o.length ? o : action.defs;
}

/** True when a keydown event satisfies a combo binding exactly. */
export function bindingMatches(b: Binding, e: KeyboardEvent): boolean {
  return normKey(e.key) === normKey(b.key)
    && !!b.mod === (e.metaKey || e.ctrlKey)
    && !!b.shift === e.shiftKey
    && !!b.alt === e.altKey;
}

/** Resolve a keydown to a combo action id (respecting crop context), or null. */
export function matchCombo(e: KeyboardEvent, overrides: BindingOverrides, inCrop: boolean): string | null {
  for (const a of ACTIONS) {
    if (a.kind !== "combo") continue;
    if (a.context === "crop" && !inCrop) continue;
    for (const b of effectiveDefs(a, overrides)) {
      if (bindingMatches(b, e)) return a.id;
    }
  }
  return null;
}

/** Resolve a bare held key to the develop parameter it nudges, or null. */
export function selectorParam(key: string, overrides: BindingOverrides): AdjustParam | null {
  const k = normKey(key);
  for (const a of ACTIONS) {
    if (a.kind !== "chord" || !a.param) continue;
    for (const b of effectiveDefs(a, overrides)) {
      if (normKey(b.key) === k) return a.param;
    }
  }
  return null;
}

// ---- Conflict detection (for the rebinding UI) ------------------------------

export function bindingEq(a: Binding, b: Binding): boolean {
  return normKey(a.key) === normKey(b.key)
    && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

// Two actions can collide only within the same namespace: combos with combos
// (whose contexts overlap), chords with chords. A modifier flag (Shift) is shared
// by design, so it never conflicts.
function comparable(a: HotkeyAction, b: HotkeyAction): boolean {
  if (a.kind === "modifier" || b.kind === "modifier") return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "combo") return !a.context || !b.context || a.context === b.context;
  return true; // chord vs chord
}

/** The first OTHER action whose effective bindings already claim `candidate`, or null. */
export function findConflict(
  action: HotkeyAction, candidate: Binding, overrides: BindingOverrides,
): HotkeyAction | null {
  for (const other of ACTIONS) {
    if (other.id === action.id || !comparable(action, other)) continue;
    for (const b of effectiveDefs(other, overrides)) {
      const hit = action.kind === "chord" ? normKey(b.key) === normKey(candidate.key) : bindingEq(b, candidate);
      if (hit) return other;
    }
  }
  return null;
}

// ---- Capture & display ------------------------------------------------------

/** Build a Binding from a keydown during "press a key…" capture. For chord
 *  actions only the bare key is taken (modifiers stripped); returns null while
 *  only a modifier is held. */
export function captureBinding(e: KeyboardEvent, chord: boolean): Binding | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = normKey(e.key);
  if (chord) return { key };
  return {
    key,
    mod: e.metaKey || e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
  };
}

const GLYPH: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Enter: "↵", Escape: "Esc", Backspace: "⌫", " ": "Space",
};

/** Display glyphs for a binding, e.g. ["⌘","⇧","Z"] / ["1"] / ["Ctrl","←"]. */
export function bindingTokens(b: Binding): string[] {
  const t: string[] = [];
  if (b.mod) t.push(isMac() ? "⌘" : "Ctrl");
  if (b.alt) t.push(isMac() ? "⌥" : "Alt");
  if (b.shift) t.push(isMac() ? "⇧" : "Shift");
  // A bare modifier flag (Shift) has no extra key glyph.
  if (b.key !== "shift") t.push(GLYPH[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key));
  return t;
}
