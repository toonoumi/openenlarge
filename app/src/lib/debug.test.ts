import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const appended: { level: string; msg: string }[][] = [];
vi.mock("./api", () => ({
  api: {
    debugSet: vi.fn(() => Promise.resolve()),
    debugLogAppend: vi.fn((lines: { level: string; msg: string }[]) => {
      appended.push(lines);
      return Promise.resolve();
    }),
    debugClear: vi.fn(() => Promise.resolve()),
    savePref: vi.fn(() => Promise.resolve()),
  },
}));

import { installDebugHooks, removeDebugHooks, flushDebugQueue, enqueue, perf } from "./debug";
import { api } from "./api";

describe("debug hooks", () => {
  beforeEach(() => {
    appended.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => removeDebugHooks());

  it("forwards console.error to the backend on flush", async () => {
    installDebugHooks();
    console.error("kaboom", 42);
    await flushDebugQueue();
    expect(api.debugLogAppend).toHaveBeenCalled();
    const all = appended.flat();
    expect(all.some((l) => l.level === "ERROR" && l.msg.includes("kaboom"))).toBe(true);
  });

  it("restores the original console.error after removal", () => {
    const orig = console.error;
    installDebugHooks();
    expect(console.error).not.toBe(orig);
    removeDebugHooks();
    expect(console.error).toBe(orig);
  });

  it("perf() returns the value and enqueues a PERF line", async () => {
    installDebugHooks();
    const v = perf("calc", () => 7);
    expect(v).toBe(7);
    await flushDebugQueue();
    const all = appended.flat();
    expect(all.some((l) => l.level === "PERF" && l.msg.startsWith("calc "))).toBe(true);
  });
});
