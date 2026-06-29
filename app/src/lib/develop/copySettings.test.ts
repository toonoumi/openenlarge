import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./thumbRegen", () => ({ markThumbsStale: vi.fn() }));
vi.mock("../toast", () => ({ showToast: vi.fn() }));
vi.mock("./historyStore", () => ({ commitActive: vi.fn() }));

import { activeId, editsById, cropById, images, invalidatePreview } from "../store";
import { markThumbsStale } from "./thumbRegen";
import { applySelectedTo } from "./copySettings";
import { PASTE_DEFAULT_GROUPS } from "./copySettings";

beforeEach(() => {
  editsById.set({ a: {} as any, b: {} as any, c: {} as any });
  cropById.set({});
  images.set([
    { id: "a", developed: true } as any,
    { id: "b", developed: true } as any,
    { id: "c", developed: true } as any,
  ]);
  activeId.set("a");
  vi.clearAllMocks();
});

describe("applySelectedTo", () => {
  it("marks the non-active applied frames stale (persisted)", async () => {
    const src = { params: { exposure: 1 } as any, crop: null, tempOffset: 0 };
    await applySelectedTo(["a", "b", "c"], src, { ...PASTE_DEFAULT_GROUPS });
    // Active frame "a" rebakes via Develop.refreshThumb, so it is excluded.
    expect(markThumbsStale).toHaveBeenCalledWith(["b", "c"], { persist: true });
  });
});
