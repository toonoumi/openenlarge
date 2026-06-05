import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { folderBaseByPath } from "../store";
import { withEffectiveBase, setFolderBase, clearFolderBase } from "./base";
import { defaultParams } from "../api";

describe("withEffectiveBase", () => {
  beforeEach(() => folderBaseByPath.set({}));

  it("uses per-image override over the folder default", () => {
    folderBaseByPath.set({ "/x": [0.4, 0.2, 0.1] });
    const p = { ...defaultParams(), base_override: [0.9, 0.8, 0.7] as [number, number, number] };
    expect(withEffectiveBase(p, "/x").base_override).toEqual([0.9, 0.8, 0.7]);
  });

  it("falls back to the folder default when no override", () => {
    folderBaseByPath.set({ "/x": [0.4, 0.2, 0.1] });
    const p = defaultParams();
    expect(withEffectiveBase(p, "/x").base_override).toEqual([0.4, 0.2, 0.1]);
  });

  it("is null when neither is set (backend uses dev.base)", () => {
    expect(withEffectiveBase(defaultParams(), "/x").base_override).toBeNull();
  });

  it("setFolderBase / clearFolderBase mutate the store", () => {
    setFolderBase("/x", [0.4, 0.2, 0.1]);
    expect(get(folderBaseByPath)["/x"]).toEqual([0.4, 0.2, 0.1]);
    clearFolderBase("/x");
    expect(get(folderBaseByPath)["/x"]).toBeUndefined();
  });
});
