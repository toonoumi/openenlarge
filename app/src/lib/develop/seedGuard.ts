/**
 * One-shot-per-key guard for auto-seeding white balance.
 *
 * Auto-WB seeds Temp/Tint from the as-shot white point the first time an image
 * is shown. The guard must remember EVERY key it has seeded, not just the last
 * one: with a single "last key" variable, visiting image A, then B, then A again
 * re-seeds A (its key no longer equals the stored B key) and clobbers any manual
 * Temp/Tint the user set on A. Tracking all seen keys makes the revisit a no-op.
 *
 * `force` re-arms a key on demand (the Auto button), re-seeding even if seen.
 */
export function createSeedGuard(): (key: string | null, force?: boolean) => boolean {
  const seen = new Set<string>();
  return function shouldSeed(key: string | null, force = false): boolean {
    if (!key) return false;
    if (force) {
      seen.add(key);
      return true;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
