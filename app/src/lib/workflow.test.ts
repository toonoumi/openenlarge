import { describe, it, expect } from "vitest";
import { undevelopedIds, omitPreviewSidecars, mergeEnsured, selectImportPaths } from "./workflow";
import type { ImageEntry } from "./api";

const mk = (id: string, developed: boolean): ImageEntry => ({
  id, path: "", file_name: id, thumbnail: "", developed, has_ir: false, offline: false,
  positive: false, metadata: { width: 0, height: 0, file_size: 0 },
});

describe("undevelopedIds", () => {
  it("returns only not-developed ids in order", () => {
    const list = [mk("a", true), mk("b", false), mk("c", false)];
    expect(undevelopedIds(list)).toEqual(["b", "c"]);
  });
  it("returns empty when all developed", () => {
    expect(undevelopedIds([mk("a", true)])).toEqual([]);
  });
});

describe("mergeEnsured", () => {
  it("keeps the frontend's live (edited) thumbnail, not the backend default render", () => {
    const existing = { ...mk("a", true), thumbnail: "edited-look" };
    const updated = { ...mk("a", true), thumbnail: "default-look", has_ir: true };
    const merged = mergeEnsured(existing, updated);
    expect(merged.thumbnail).toBe("edited-look"); // not clobbered → no filmstrip flash
  });

  it("adopts refreshed status/metadata from the ensure result", () => {
    const existing = { ...mk("a", true), thumbnail: "edited-look" };
    const updated = { ...mk("a", true), thumbnail: "default-look", has_ir: true, positive: true };
    const merged = mergeEnsured(existing, updated);
    expect(merged.has_ir).toBe(true);
    expect(merged.positive).toBe(true);
  });

  it("falls back to the backend thumbnail when the frontend has none", () => {
    const existing = { ...mk("a", true), thumbnail: "" };
    const updated = { ...mk("a", true), thumbnail: "default-look" };
    expect(mergeEnsured(existing, updated).thumbnail).toBe("default-look");
  });
});

describe("omitPreviewSidecars", () => {
  it("drops a jpg with a same-folder, same-name raw sibling", () => {
    expect(omitPreviewSidecars(["/a/img1.raf", "/a/img1.jpg"]))
      .toEqual(["/a/img1.raf"]);
  });

  it("keeps a standalone jpg with no raw twin", () => {
    expect(omitPreviewSidecars(["/a/holiday.jpg", "/a/img1.raf"]))
      .toEqual(["/a/holiday.jpg", "/a/img1.raf"]);
  });

  it("does not drop a jpg whose raw twin is in a different folder", () => {
    expect(omitPreviewSidecars(["/a/img1.jpg", "/b/img1.raf"]))
      .toEqual(["/a/img1.jpg", "/b/img1.raf"]);
  });

  it("matches case-insensitively on extension and stem", () => {
    expect(omitPreviewSidecars(["/a/IMG1.NEF", "/a/img1.JPG"]))
      .toEqual(["/a/IMG1.NEF"]);
  });

  it("treats png as a preview and tif as a master", () => {
    expect(omitPreviewSidecars(["/a/x.tif", "/a/x.png"]))
      .toEqual(["/a/x.tif"]);
  });

  it("keeps a jpg/png pair when neither is a master", () => {
    expect(omitPreviewSidecars(["/a/x.jpg", "/a/x.png"]))
      .toEqual(["/a/x.jpg", "/a/x.png"]);
  });

  it("handles Windows backslash paths and multi-dot names", () => {
    expect(omitPreviewSidecars(["C:\\p\\a.1.arw", "C:\\p\\a.1.jpg"]))
      .toEqual(["C:\\p\\a.1.arw"]);
  });
});

describe("selectImportPaths", () => {
  it("drops non-importable files (e.g. .txt, .xmp) from a folder listing", () => {
    const files = ["/r/img1.raf", "/r/readme.txt", "/r/img1.xmp", "/r/img2.nef"];
    expect(selectImportPaths(files, false)).toEqual(["/r/img1.raf", "/r/img2.nef"]);
  });

  it("omits preview sidecars when the flag is on", () => {
    const files = ["/r/img1.raf", "/r/img1.jpg", "/r/loose.jpg"];
    expect(selectImportPaths(files, true)).toEqual(["/r/img1.raf", "/r/loose.jpg"]);
  });

  it("keeps preview sidecars when the flag is off", () => {
    const files = ["/r/img1.raf", "/r/img1.jpg"];
    expect(selectImportPaths(files, false)).toEqual(["/r/img1.raf", "/r/img1.jpg"]);
  });
});
