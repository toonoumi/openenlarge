import { describe, it, expect, vi } from "vitest";
import { debounce, perKeySaver, applySnapshot } from "./catalog";
import { get } from "svelte/store";
import {
  images, editsById, cropById, dustById, metaById,
  selectedFolder, gridZoom, module as moduleStore, activeId, folderBaseByPath,
} from "./store";
import type { CatalogSnapshot } from "./api";
import { defaultParams } from "./api";

describe("debounce", () => {
  it("coalesces rapid calls into one trailing invocation", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d("a"); d("b"); d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c"); // last args win
    vi.useRealTimers();
  });

  it("flush() invokes the pending call immediately", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d("x");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x");
    vi.useRealTimers();
  });
});

describe("perKeySaver", () => {
  it("persists every distinct key (different keys don't clobber each other)", () => {
    vi.useFakeTimers();
    const apiSave = vi.fn(() => Promise.resolve());
    const saver = perKeySaver(apiSave);
    // module + active_id changing in the same tick — a shared debounce would drop one.
    saver.save("module", "develop");
    saver.save("active_id", "img-7");
    vi.advanceTimersByTime(400);
    expect(apiSave).toHaveBeenCalledTimes(2);
    expect(apiSave).toHaveBeenCalledWith("module", "develop");
    expect(apiSave).toHaveBeenCalledWith("active_id", "img-7");
    vi.useRealTimers();
  });

  it("coalesces repeated writes to the SAME key (last value wins)", () => {
    vi.useFakeTimers();
    const apiSave = vi.fn(() => Promise.resolve());
    const saver = perKeySaver(apiSave);
    saver.save("active_id", "a");
    saver.save("active_id", "b");
    saver.save("active_id", "c");
    vi.advanceTimersByTime(400);
    expect(apiSave).toHaveBeenCalledTimes(1);
    expect(apiSave).toHaveBeenCalledWith("active_id", "c");
    vi.useRealTimers();
  });
});

describe("applySnapshot", () => {
  it("populates every store from a catalog snapshot", () => {
    const snap: CatalogSnapshot = {
      images: [{
        id: "a", path: "/x/a.dng", file_name: "a.dng", thumbnail: "t",
        metadata: { width: 100, height: 100, file_size: 0 }, offline: false,
        developed: true, has_ir: false, positive: false,
      }],
      edits: [{
        image_id: "a",
        params: { ...defaultParams(), exposure: 1.5 },
        crop: null,
        dust: { strokes: [], irRemoval: { enabled: false, sensitivity: 50 }, autoDust: { enabled: false, sensitivity: 50 }, brushMigan: false, aiApplied: false, autoDustExclusions: [], showSpots: true },
        meta: { camera: "Leica M6", note: "roll 12" },
      }],
      prefs: {},
      app_state: { selected_folder: "/x", grid_zoom: "70", module: "develop", active_id: "a" },
    };
    applySnapshot(snap);
    expect(get(images).length).toBe(1);
    expect(get(images)[0].developed).toBe(true);
    expect(get(editsById)["a"].exposure).toBe(1.5);
    expect(get(dustById)["a"].irRemoval.sensitivity).toBe(50);
    expect(get(metaById)["a"].camera).toBe("Leica M6");
    expect(get(selectedFolder)).toBe("/x");
    expect(get(gridZoom)).toBe(70);
    expect(get(moduleStore)).toBe("develop");
    expect(get(activeId)).toBe("a");
  });

  it("hydrates folder bases from app_state folder_base: keys", () => {
    const snap: CatalogSnapshot = {
      images: [], edits: [],
      prefs: {},
      app_state: { "folder_base:/x/roll1": "[0.42,0.19,0.11]" },
    };
    applySnapshot(snap);
    expect(get(folderBaseByPath)["/x/roll1"]).toEqual([0.42, 0.19, 0.11]);
  });
});
