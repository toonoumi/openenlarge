import { describe, it, expect } from "vitest";
import { hiTierAction } from "./hiTier";

describe("hiTierAction", () => {
  it("never upgrades synchronously — lo→hi is always deferred via 'arm'", () => {
    // The whole point of P1: crossing into deep-zoom must not commit the heavy
    // hi-res tier immediately; it only arms the settle timer.
    expect(hiTierAction(true, false)).toBe("arm");
  });

  it("downgrades immediately when the desired tier drops back to proxy", () => {
    // Proxy is always resident, so leaving deep-zoom is free and must be instant —
    // this also cancels any pending (armed) upgrade in the caller.
    expect(hiTierAction(false, true)).toBe("downgrade");
  });

  it("downgrades (cancels pending) even when not yet at hi-res", () => {
    // wantHi flipped back off before the timer fired → drop the pending upgrade.
    expect(hiTierAction(false, false)).toBe("downgrade");
  });

  it("is a no-op once already committed to hi-res", () => {
    // Re-arming while already hi (e.g. continued panning at 100%) must not retrigger
    // a decode/upload.
    expect(hiTierAction(true, true)).toBe("noop");
  });
});
