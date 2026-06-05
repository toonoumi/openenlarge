import { describe, it, expect } from "vitest";
import { extFor, outName } from "./naming";

describe("export naming", () => {
  it("maps format kind to extension", () => {
    expect(extFor("jpeg")).toBe("jpg");
    expect(extFor("tiff")).toBe("tiff");
    expect(extFor("png")).toBe("png");
  });

  it("replaces the original extension with the format extension", () => {
    expect(outName("photo.dng", "jpeg")).toBe("photo.jpg");
    expect(outName("photo.RAF", "tiff")).toBe("photo.tiff");
    expect(outName("scan.tif", "png")).toBe("scan.png");
  });

  it("preserves dotted stems and handles no extension", () => {
    expect(outName("a.b.dng", "jpeg")).toBe("a.b.jpg");
    expect(outName("noext", "png")).toBe("noext.png");
  });
});
