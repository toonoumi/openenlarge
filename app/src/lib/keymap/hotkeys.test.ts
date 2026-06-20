import { describe, it, expect } from "vitest";
import {
  ACTIONS, actionById, matchCombo, selectorParam, findConflict,
  captureBinding, bindingMatches, type Binding,
} from "./hotkeys";

// Minimal KeyboardEvent stand-in for the pure matchers.
function ev(key: string, mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {}) {
  return { key, metaKey: !!mods.mod, ctrlKey: false, shiftKey: !!mods.shift, altKey: !!mods.alt } as KeyboardEvent;
}

describe("bindingMatches", () => {
  it("requires the modifier flags to match exactly", () => {
    const b: Binding = { key: "z", mod: true };
    expect(bindingMatches(b, ev("z", { mod: true }))).toBe(true);
    expect(bindingMatches(b, ev("z", { mod: true, shift: true }))).toBe(false); // that is redo
    expect(bindingMatches(b, ev("z"))).toBe(false);
  });
  it("is case-insensitive for letters", () => {
    expect(bindingMatches({ key: "z", mod: true }, ev("Z", { mod: true }))).toBe(true);
  });
});

describe("matchCombo (defaults)", () => {
  const none = {};
  it("resolves undo vs redo by the shift flag", () => {
    expect(matchCombo(ev("z", { mod: true }), none, false)).toBe("edit.undo");
    expect(matchCombo(ev("z", { mod: true, shift: true }), none, false)).toBe("edit.redo");
  });
  it("maps Mod+arrows to rotate/flip", () => {
    expect(matchCombo(ev("ArrowLeft", { mod: true }), none, false)).toBe("edit.rotateCCW");
    expect(matchCombo(ev("ArrowRight", { mod: true }), none, false)).toBe("edit.rotateCW");
    expect(matchCombo(ev("ArrowUp", { mod: true }), none, false)).toBe("edit.flipV");
    expect(matchCombo(ev("ArrowDown", { mod: true }), none, false)).toBe("edit.flipH");
  });
  it("maps plain arrows to navigation", () => {
    expect(matchCombo(ev("ArrowLeft"), none, false)).toBe("nav.prev");
    expect(matchCombo(ev("ArrowRight"), none, false)).toBe("nav.next");
  });
  it("only matches crop-context combos inside the crop tool", () => {
    expect(matchCombo(ev("x"), none, false)).toBeNull();      // blacks selector, not a combo
    expect(matchCombo(ev("x"), none, true)).toBe("crop.swap"); // swap only in crop
    expect(matchCombo(ev("Enter"), none, true)).toBe("crop.commit");
  });
  it("honours a user override", () => {
    const overrides = { "edit.copySettings": [{ key: "y", mod: true }] };
    expect(matchCombo(ev("c", { mod: true }), overrides, false)).toBeNull();
    expect(matchCombo(ev("y", { mod: true }), overrides, false)).toBe("edit.copySettings");
  });
});

describe("selectorParam (chord defaults)", () => {
  it("maps held selector keys to develop params", () => {
    expect(selectorParam("1", {})).toBe("temp");
    expect(selectorParam("q", {})).toBe("exposure");
    expect(selectorParam("a", {})).toBe("highlights");
    expect(selectorParam("x", {})).toBe("blacks");
    expect(selectorParam("k", {})).toBeNull();
  });
  it("follows a rebinding", () => {
    expect(selectorParam("1", { "adjust.temp": [{ key: "t" }] })).toBeNull();
    expect(selectorParam("t", { "adjust.temp": [{ key: "t" }] })).toBe("temp");
  });
});

describe("findConflict", () => {
  it("flags a combo that another combo already owns", () => {
    const undo = actionById("edit.undo")!;
    const c = findConflict(undo, { key: "c", mod: true }, {});
    expect(c?.id).toBe("edit.copySettings");
  });
  it("flags a chord selector that another adjustment owns", () => {
    const temp = actionById("adjust.temp")!;
    expect(findConflict(temp, { key: "q" }, {})?.id).toBe("adjust.exposure");
  });
  it("does not flag across namespaces (a chord key vs an arrow combo)", () => {
    const temp = actionById("adjust.temp")!;
    expect(findConflict(temp, { key: "ArrowLeft" }, {})).toBeNull();
  });
  it("returns null when the binding is free", () => {
    const temp = actionById("adjust.temp")!;
    expect(findConflict(temp, { key: "5" }, {})).toBeNull();
  });
});

describe("captureBinding", () => {
  it("strips modifiers for chord actions", () => {
    expect(captureBinding(ev("q", { mod: true, shift: true }), true)).toEqual({ key: "q" });
  });
  it("keeps modifiers for combo actions", () => {
    expect(captureBinding(ev("z", { mod: true, shift: true }), false)).toEqual({ key: "z", mod: true, shift: true });
  });
  it("ignores a bare modifier press", () => {
    expect(captureBinding({ key: "Shift", metaKey: false, ctrlKey: false, shiftKey: true, altKey: false } as KeyboardEvent, false)).toBeNull();
  });
});

describe("registry integrity", () => {
  it("has unique action ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every chord action declares a param", () => {
    for (const a of ACTIONS) if (a.kind === "chord") expect(a.param).toBeTruthy();
  });
});
