// Deep-zoom tier debounce policy (P1 / feedback #8).
//
// The viewport keeps a cheap, always-resident proxy texture and only upgrades to a
// heavy high-res decode once you zoom in past the proxy's native pixels. That upgrade
// is expensive (RAW/TIFF decode + a large GPU upload), so it must NEVER fire mid-
// gesture — otherwise pressing/holding/dragging at 100% stalls the UI.
//
// This module is the pure decision the component applies on every tier reconsideration.
// `wantHi` is the desired tier from the live zoom math; `hiTier` is the committed tier
// that actually drives the upload. The contract this encodes:
//   • upgrade (lo→hi) is ALWAYS deferred ("arm") — never synchronous;
//   • downgrade (hi→lo) is ALWAYS immediate (the proxy is resident, so it's free) and
//     cancels any pending upgrade;
//   • already at the desired tier → do nothing.
export type HiTierAction =
  | "downgrade" // commit lo now, cancel any pending upgrade
  | "arm" // start/restart the settle timer; commit hi only after it fires
  | "noop"; // already at the desired tier

export function hiTierAction(wantHi: boolean, hiTier: boolean): HiTierAction {
  if (!wantHi) return "downgrade";
  if (hiTier) return "noop";
  return "arm";
}
