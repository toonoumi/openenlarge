import { describe, it, expect, vi, beforeEach } from "vitest";

const seedFrameSpy = vi.fn(async () => {});
vi.mock("../workflow", () => ({ seedFrame: (...a: unknown[]) => (seedFrameSpy as (...x: unknown[]) => unknown)(...a) }));

const setFolderBaseSpy = vi.fn();
vi.mock("../develop/base", async () => {
  const { writable } = await import("svelte/store");
  return { setFolderBase: (...a: unknown[]) => setFolderBaseSpy(...a) };
});
vi.mock("../library/folderScope", () => ({ imageDir: () => "/roll" }));
vi.mock("../api", () => ({ api: { rollBase: vi.fn(async () => ({ base: [0.42, 0.23, 0.14], frames_used: 3 })) } }));

import { get } from "svelte/store";
import { folderBaseByPath, editsById } from "../store";
import { api } from "../api";
import { ensureRollBase } from "./rollBase";

const dev = (id: string) => ({ id, path: `/roll/${id}.dng`, file_name: `${id}.dng`, thumbnail: "", developed: true, positive: false } as never);

describe("ensureRollBase migration", () => {
  beforeEach(() => {
    seedFrameSpy.mockClear(); setFolderBaseSpy.mockClear();
    (api.rollBase as ReturnType<typeof vi.fn>).mockClear();
    folderBaseByPath.set({});
    editsById.set({});
  });

  it("computes + sets the roll base and reseeds protected-free frames", async () => {
    editsById.set({
      b: { base_override: [0.5, 0.3, 0.2] } as never,       // protected (override)
      c: { wb_manual: true } as never,                       // protected (manual WB)
    });
    await ensureRollBase("/roll", [dev("a"), dev("b"), dev("c")]);
    expect(setFolderBaseSpy).toHaveBeenCalledWith("/roll", [0.42, 0.23, 0.14]);
    expect(seedFrameSpy).toHaveBeenCalledTimes(1);           // only "a" reseeded
    const firstCall = seedFrameSpy.mock.calls[0] as unknown[];
    expect(firstCall[0]).toBe("a");
    expect(firstCall[2]).toBe(false);       // WB-only, keep exposure
  });

  it("skips entirely when a folder base already exists", async () => {
    folderBaseByPath.set({ "/roll": [0.4, 0.2, 0.1] });
    await ensureRollBase("/roll", [dev("a")]);
    expect(api.rollBase).not.toHaveBeenCalled();
    expect(setFolderBaseSpy).not.toHaveBeenCalled();
    expect(seedFrameSpy).not.toHaveBeenCalled();
  });

  it("does nothing on a rebate-less roll (rollBase returns null)", async () => {
    (api.rollBase as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await ensureRollBase("/roll", [dev("a")]);
    expect(setFolderBaseSpy).not.toHaveBeenCalled();
    expect(seedFrameSpy).not.toHaveBeenCalled();
  });
});
