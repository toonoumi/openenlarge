import { describe, it, expect } from "vitest";
import { buildTree, countImages, type FolderNode } from "./folderTree";
import { scopeToFolder } from "./folderScope";

const find = (nodes: FolderNode[], name: string): FolderNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const f = find(n.children, name);
    if (f) return f;
  }
};

describe("buildTree", () => {
  const tree = buildTree([
    { id: "a", path: "/Volumes/Disk2/Film Scans/ny2026/1.dng" },
    { id: "b", path: "/Volumes/Disk2/Film Scans/ny2026/2.dng" },
    { id: "c", path: "/Volumes/Disk2/Film Scans/ny2027/3.dng" },
    { id: "d", path: "/Users/me/scans/4.dng" },
  ]);

  it("creates a volume root and a Macintosh HD root", () => {
    expect(tree.map((n) => n.name).sort()).toEqual(["Disk2", "Macintosh HD"]);
  });
  it("groups images by their folder", () => {
    expect(find(tree, "ny2026")!.imageIds.sort()).toEqual(["a", "b"]);
    expect(find(tree, "ny2027")!.imageIds).toEqual(["c"]);
    expect(find(tree, "scans")!.imageIds).toEqual(["d"]);
  });
  it("countImages sums the subtree", () => {
    expect(countImages(find(tree, "Film Scans")!)).toBe(3);
    expect(countImages(find(tree, "Disk2")!)).toBe(3);
  });
  it("uses real path prefixes (no synthetic root) so they match an image's directory", () => {
    expect(find(tree, "ny2026")!.fullPath).toBe("/Volumes/Disk2/Film Scans/ny2026");
    expect(find(tree, "scans")!.fullPath).toBe("/Users/me/scans");
  });
});

describe("buildTree on Windows drive-letter paths", () => {
  const win = buildTree([
    { id: "a", path: "B:\\CAM RAW\\2026-05\\C200\\1.dng" },
    { id: "b", path: "B:\\CAM RAW\\2026-05\\C200\\2.dng" },
  ]);

  it("keeps the drive letter slash-free so fullPath matches an image's directory", () => {
    // imageDir of these images is "B:/CAM RAW/2026-05/C200" (no leading slash);
    // the tree must produce the same prefixes or folder selection finds nothing.
    expect(find(win, "B:")!.fullPath).toBe("B:");
    expect(find(win, "CAM RAW")!.fullPath).toBe("B:/CAM RAW");
    expect(find(win, "C200")!.fullPath).toBe("B:/CAM RAW/2026-05/C200");
  });

  it("selecting a parent folder scopes to its descendant images", () => {
    const imgs = [
      { id: "a", path: "B:\\CAM RAW\\2026-05\\C200\\1.dng" },
      { id: "b", path: "B:\\CAM RAW\\2026-05\\C200\\2.dng" },
    ];
    const camRaw = find(win, "CAM RAW")!.fullPath;
    expect(scopeToFolder(imgs, camRaw).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
