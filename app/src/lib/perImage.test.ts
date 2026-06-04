import { describe, it, expect } from "vitest";
import { get, writable, type Writable } from "svelte/store";
import { entryFor, createPerImageParams } from "./perImage";
import type { InvertParams } from "./api";

// Minimal stand-in default; the real defaultParams is injected in app code.
const mk = (): InvertParams => ({ exposure: 0 } as InvertParams);

describe("entryFor", () => {
  it("returns the stored entry for a known id", () => {
    const a = { exposure: 5 } as InvertParams;
    expect(entryFor({ A: a }, "A", mk)).toBe(a);
  });
  it("returns a fresh default for an unknown id or null", () => {
    expect(entryFor({}, "X", mk).exposure).toBe(0);
    expect(entryFor({}, null, mk).exposure).toBe(0);
  });
});

describe("createPerImageParams", () => {
  it("isolates edits per active image and restores them on switch", () => {
    const activeId = writable<string | null>(null);
    const { params } = createPerImageParams(activeId, mk);

    activeId.set("A");
    params.update((p) => ({ ...p, exposure: 5 }));
    expect(get(params as unknown as Writable<InvertParams>).exposure).toBe(5);

    activeId.set("B");
    expect(get(params as unknown as Writable<InvertParams>).exposure).toBe(0);
    params.set({ exposure: -3 } as InvertParams);
    expect(get(params as unknown as Writable<InvertParams>).exposure).toBe(-3);

    activeId.set("A");
    expect(get(params as unknown as Writable<InvertParams>).exposure).toBe(5);
    activeId.set("B");
    expect(get(params as unknown as Writable<InvertParams>).exposure).toBe(-3);
  });

  it("ignores writes when no image is active", () => {
    const activeId = writable<string | null>(null);
    const { params, editsById } = createPerImageParams(activeId, mk);
    params.update((p) => ({ ...p, exposure: 9 }));
    expect(get(editsById)).toEqual({});
  });
});
