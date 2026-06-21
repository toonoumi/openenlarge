import { describe, it, expect, vi, beforeEach } from "vitest";

// Order log shared by the api mock.
const calls: string[] = [];

vi.mock("./api", () => ({
  defaultParams: () => ({ mode: "d", stock: "none", base_override: null, d_max_override: null, exposure: 0, temp: 5500, tint: 0, positive: false, wb_mode: "gain", wb_manual: false }),
  api: {
    developImage: vi.fn(async (id: string) => { calls.push(`develop:${id}`); return { id, path: `/roll/${id}.dng`, file_name: `${id}.dng`, thumbnail: "", developed: true, positive: false }; }),
    rollBase: vi.fn(async (ids: string[]) => { calls.push(`rollBase:${ids.length}`); return { base: [0.42, 0.23, 0.14], frames_used: ids.length }; }),
    asShotWb: vi.fn(async () => { calls.push("asShotWb"); return { temp: 5800, tint: 5 }; }),
    autoBrightness: vi.fn(async () => { calls.push("autoBrightness"); return { exposure: -0.9 }; }),
    thumbnail: vi.fn(async () => "data:image/jpeg;base64,x"),
    saveThumbnail: vi.fn(async () => {}),
  },
}));

// setFolderBase records ordering; folderBaseByPath stays empty so seeds read it live.
const setFolderBaseSpy = vi.fn((_dir: unknown, _base: unknown) => { calls.push("setFolderBase"); });
vi.mock("./develop/base", () => ({
  withEffectiveBase: (p: unknown, _dir: string) => p,
  setFolderBase: (dir: unknown, base: unknown) => setFolderBaseSpy(dir, base),
}));
vi.mock("./library/folderScope", () => ({ imageDir: () => "/roll", scopeToFolder: (imgs: unknown[]) => imgs }));
vi.mock("./library/gridHiRes", () => ({ gridThumbView: () => ({}), GRID_STATIC_EDGE: 320 }));
vi.mock("./telemetry", () => ({ track: () => {} }));

import { images, editsById, module, selectedFolder } from "./store";
import { developAll } from "./workflow";

describe("developAll two-phase roll base", () => {
  beforeEach(() => {
    calls.length = 0;
    setFolderBaseSpy.mockClear();
    editsById.set({});
    selectedFolder.set("/roll");
    images.set([
      { id: "a", path: "/roll/a.dng", file_name: "a.dng", thumbnail: "", developed: false, positive: false } as never,
      { id: "b", path: "/roll/b.dng", file_name: "b.dng", thumbnail: "", developed: false, positive: false } as never,
    ]);
  });

  it("sets the roll base before any WB seed runs", async () => {
    await developAll("develop");
    const firstSeed = calls.indexOf("asShotWb");
    const setBase = calls.indexOf("setFolderBase");
    expect(setBase).toBeGreaterThanOrEqual(0);
    expect(firstSeed).toBeGreaterThan(setBase); // WB seeded AFTER the roll base is set
    // Both frames developed before the roll base was computed.
    expect(calls.indexOf("rollBase:2")).toBeGreaterThan(calls.indexOf("develop:b"));
  });
});
