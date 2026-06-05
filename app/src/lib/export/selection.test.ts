import { describe, it, expect } from "vitest";
import { allSelected, noneSelected, click, isAllSelected, toggleAll } from "./selection";

const ids = ["a", "b", "c", "d"];

describe("selection model", () => {
  it("allSelected selects everything with last as anchor", () => {
    const s = allSelected(ids);
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "d"]);
    expect(s.anchor).toBe("d");
  });

  it("plain click selects only that item", () => {
    const s = click(allSelected(ids), ids, "b", { meta: false, shift: false });
    expect([...s.selected]).toEqual(["b"]);
    expect(s.anchor).toBe("b");
  });

  it("meta-click toggles a single item and moves anchor", () => {
    let s = click(noneSelected(), ids, "a", { meta: true, shift: false });
    expect([...s.selected]).toEqual(["a"]);
    s = click(s, ids, "c", { meta: true, shift: false });
    expect([...s.selected].sort()).toEqual(["a", "c"]);
    expect(s.anchor).toBe("c");
    s = click(s, ids, "a", { meta: true, shift: false });
    expect([...s.selected]).toEqual(["c"]);
  });

  it("shift-click selects the inclusive range from the anchor", () => {
    const base = click(noneSelected(), ids, "b", { meta: false, shift: false });
    const s = click(base, ids, "d", { meta: false, shift: true });
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
  });

  it("shift-click works backwards too", () => {
    const base = click(noneSelected(), ids, "c", { meta: false, shift: false });
    const s = click(base, ids, "a", { meta: false, shift: true });
    expect([...s.selected].sort()).toEqual(["a", "b", "c"]);
  });

  it("toggleAll flips between all and none", () => {
    const all = allSelected(ids);
    expect(isAllSelected(all, ids)).toBe(true);
    const cleared = toggleAll(all, ids);
    expect(cleared.selected.size).toBe(0);
    const refilled = toggleAll(cleared, ids);
    expect(isAllSelected(refilled, ids)).toBe(true);
  });
});
