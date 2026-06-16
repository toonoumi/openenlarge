// Anonymous, opt-in usage analytics. Nothing is sent unless the user opted in;
// the backend gates again on its own consent flag, so track() is best-effort and
// never throws. Events carry no PII — Aptabase attaches only app version + OS.
import { get } from "svelte/store";
import { api } from "./api";
import { telemetryEnabled, telemetryDecided } from "./store";

/** Record the user's analytics choice from the first-run prompt or Settings:
 *  update the stores, sync the backend gate, and persist the `telemetry` pref.
 *  Persists directly (not via the value-change subscription) so choosing "off"
 *  on the first run still writes a decision and won't re-prompt next launch. */
export function setTelemetryChoice(enabled: boolean): void {
  telemetryEnabled.set(enabled);
  telemetryDecided.set(true);
  void api.setTelemetry(enabled).catch(() => {});
  void api.savePref("telemetry", enabled ? "on" : "off").catch(() => {});
}

/** Fire an anonymous event if the user has opted in; a no-op otherwise. */
export function track(name: string, props?: Record<string, unknown>): void {
  if (!get(telemetryEnabled)) return;
  void api.telemetryEvent(name, props).catch(() => {});
}
