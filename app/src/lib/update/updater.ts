import { writable, get } from "svelte/store";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { updateLastCheck, updateSkipVersion } from "../store";
import { shouldAutoCheck, shouldPrompt } from "./policy";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; pct: number }
  | { kind: "restartReady" }
  | { kind: "upToDate" }
  | { kind: "error"; message: string };

/** Drives UpdatePrompt.svelte. "upToDate"/"error" are only surfaced for manual checks. */
export const updateState = writable<UpdateState>({ kind: "idle" });

let pending: Update | null = null;

/** Launch check: throttled, skip-aware, and silent on failure. */
export async function runAutoCheck(): Promise<void> {
  if (!isTauri()) return;
  const now = Date.now();
  if (!shouldAutoCheck(now, get(updateLastCheck))) return;
  updateLastCheck.set(now); // stamp at attempt start so the throttle holds even offline
  try {
    const u = await check();
    if (u && shouldPrompt(u.version, u.currentVersion, get(updateSkipVersion))) {
      pending = u;
      updateState.set({ kind: "available", version: u.version, notes: u.body ?? "" });
    }
  } catch (e) {
    console.warn("update check failed", e);
  }
}

/** Manual check: ignores throttle + skip; surfaces up-to-date and error states. */
export async function runManualCheck(): Promise<void> {
  if (!isTauri()) return;
  updateLastCheck.set(Date.now());
  try {
    const u = await check();
    if (u) {
      pending = u;
      updateState.set({ kind: "available", version: u.version, notes: u.body ?? "" });
    } else {
      updateState.set({ kind: "upToDate" });
    }
  } catch (e) {
    updateState.set({ kind: "error", message: String(e) });
  }
}

export async function startUpdate(): Promise<void> {
  if (!pending) return;
  updateState.set({ kind: "downloading", pct: 0 });
  let total = 0;
  let got = 0;
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        updateState.set({ kind: "downloading", pct: total ? got / total : 0 });
      }
    });
    updateState.set({ kind: "restartReady" });
  } catch (e) {
    updateState.set({ kind: "error", message: String(e) });
  }
}

export async function restart(): Promise<void> {
  await relaunch();
}

export function skipVersion(version: string): void {
  updateSkipVersion.set(version);
  updateState.set({ kind: "idle" });
}

export function dismiss(): void {
  updateState.set({ kind: "idle" });
}
