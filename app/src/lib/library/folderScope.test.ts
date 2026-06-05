import { describe, it, expect } from "vitest";
import { imageDir, inFolder, scopeToFolder } from "./folderScope";

describe("imageDir", () => {
  it("returns the parent directory of a path", () => {
    expect(imageDir({ path: "/Volumes/Disk2/scan/1.dng" })).toBe("/Volumes/Disk2/scan");
  });
  it("normalizes backslashes", () => {
    expect(imageDir({ path: "C:\\film\\ny\\2.tif" })).toBe("C:/film/ny");
  });
});

describe("inFolder", () => {
  const dir = "/film_scan/ny2026-2";

  it("matches the exact folder", () => {
    expect(inFolder(dir, "/film_scan/ny2026-2")).toBe(true);
  });
  it("matches a parent folder (recursive)", () => {
    expect(inFolder(dir, "/film_scan")).toBe(true);
  });
  it("excludes a sibling folder", () => {
    expect(inFolder(dir, "/film_scan/ny2026-1")).toBe(false);
  });
  it("does not treat a name prefix as a parent", () => {
    // "/film_scan/ny2026" must NOT capture "/film_scan/ny2026-2"
    expect(inFolder(dir, "/film_scan/ny2026")).toBe(false);
  });
  it("null selection shows everything", () => {
    expect(inFolder(dir, null)).toBe(true);
  });
});

describe("scopeToFolder", () => {
  const imgs = [
    { id: "a", path: "/film_scan/ny2026-1/1.dng" },
    { id: "b", path: "/film_scan/ny2026-2/2.dng" },
    { id: "c", path: "/film_scan/ny2026-2/3.dng" },
  ];
  it("keeps only the selected folder", () => {
    expect(scopeToFolder(imgs, "/film_scan/ny2026-2").map((i) => i.id)).toEqual(["b", "c"]);
  });
  it("a parent selection keeps the whole subtree", () => {
    expect(scopeToFolder(imgs, "/film_scan").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  it("null keeps everything", () => {
    expect(scopeToFolder(imgs, null).length).toBe(3);
  });
});
