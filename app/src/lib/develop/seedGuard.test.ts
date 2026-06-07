import { describe, it, expect } from "vitest";
import { createSeedGuard } from "./seedGuard";

describe("createSeedGuard", () => {
  it("seeds a key only the first time it is seen", () => {
    const shouldSeed = createSeedGuard();
    expect(shouldSeed("A")).toBe(true);
    expect(shouldSeed("A")).toBe(false);
  });

  it("does not re-seed a key when revisited after another image (the reset bug)", () => {
    const shouldSeed = createSeedGuard();
    expect(shouldSeed("A")).toBe(true); // first show of A → seed
    expect(shouldSeed("B")).toBe(true); // switch to B → seed
    expect(shouldSeed("A")).toBe(false); // back to A → must NOT clobber manual edits
  });

  it("never seeds a null key", () => {
    const shouldSeed = createSeedGuard();
    expect(shouldSeed(null)).toBe(false);
  });

  it("re-seeds when forced (Auto button), even if already seen", () => {
    const shouldSeed = createSeedGuard();
    expect(shouldSeed("A")).toBe(true);
    expect(shouldSeed("A")).toBe(false);
    expect(shouldSeed("A", true)).toBe(true); // forced re-seed
    expect(shouldSeed("A")).toBe(false); // and remembered again afterwards
  });
});
