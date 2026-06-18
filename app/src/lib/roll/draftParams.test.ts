import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { rollDraft, resetRollDraft } from "./draft";
import { draftParamsStore } from "./draftParams";

describe("draftParamsStore", () => {
  beforeEach(() => resetRollDraft());

  it("reads rollDraft.params", () => {
    const ps = draftParamsStore();
    expect(get(ps).exposure).toBe(0);
    rollDraft.update((d) => ({ ...d, params: { ...d.params, exposure: 1.5 } }));
    expect(get(ps).exposure).toBe(1.5);
  });

  it("update writes back into rollDraft.params as a new reference", () => {
    const ps = draftParamsStore();
    const before = get(rollDraft).params;
    ps.update((p) => ({ ...p, contrast: 25 }));
    expect(get(rollDraft).params.contrast).toBe(25);
    expect(get(rollDraft).params).not.toBe(before);
  });

  it("set replaces rollDraft.params", () => {
    const ps = draftParamsStore();
    const next = { ...get(rollDraft).params, saturation: 40 };
    ps.set(next);
    expect(get(rollDraft).params.saturation).toBe(40);
  });
});
