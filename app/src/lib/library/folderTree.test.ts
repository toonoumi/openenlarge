import { describe, it, expect } from "vitest";
import { buildTree, countImages, type FolderNode } from "./folderTree";

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
});
