import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { rollDraft, rollReferenceId, resetRollDraft } from "./draft";
import { defaultParams } from "../api";

describe("rollDraft", () => {
  beforeEach(() => resetRollDraft());

  it("seeds from default params with no crop", () => {
    expect(get(rollDraft)).toEqual({ params: defaultParams(), crop: null });
  });

  it("resetRollDraft clears edits back to defaults", () => {
    rollDraft.update((d) => ({ ...d, params: { ...d.params, exposure: 2 } }));
    expect(get(rollDraft).params.exposure).toBe(2);
    resetRollDraft();
    expect(get(rollDraft).params.exposure).toBe(0);
    expect(get(rollDraft).crop).toBeNull();
  });

  it("rollReferenceId defaults to null", () => {
    expect(get(rollReferenceId)).toBeNull();
  });
});
