import { describe, it, expect } from "vitest";
import { undevelopedIds, applyStockToIds } from "./workflow";
import type { ImageEntry } from "./api";
import { defaultParams } from "./api";

const mk = (id: string, developed: boolean): ImageEntry => ({
  id, path: "", file_name: id, thumbnail: "", developed, has_ir: false, offline: false,
  metadata: { width: 0, height: 0, file_size: 0 },
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

describe("applyStockToIds", () => {
  it("sets stock on the listed ids, seeding from defaults when absent", () => {
    const map = { a: { ...defaultParams(), exposure: 1.2 } };
    const out = applyStockToIds(map, ["a", "b"], "portra400", defaultParams);
    expect(out.a.stock).toBe("portra400");
    expect(out.a.exposure).toBe(1.2); // existing fields preserved
    expect(out.b.stock).toBe("portra400"); // absent id seeded from defaults
    expect(out.b.exposure).toBe(0);
  });

  it("leaves out-of-scope ids untouched and does not mutate the input", () => {
    const map = { a: { ...defaultParams(), stock: "none" as const }, z: { ...defaultParams(), stock: "fujic200" as const } };
    const out = applyStockToIds(map, ["a"], "portra400", defaultParams);
    expect(out.z.stock).toBe("fujic200"); // untouched
    expect(map.a.stock).toBe("none"); // input not mutated
    expect(out).not.toBe(map);
  });

  it("returns the map unchanged-shape for an empty id list", () => {
    const map = { a: defaultParams() };
    const out = applyStockToIds(map, [], "portra400", defaultParams);
    expect(out.a.stock).toBe("none");
  });
});
