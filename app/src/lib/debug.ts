// Frontend half of debug mode. When enabled, console output, uncaught errors,
// and perf spans are batched and forwarded to the backend log file via IPC.
// Everything here is best-effort and must never throw into the app.
import { api } from "./api";
import { debugMode } from "./store";

type Line = { level: string; msg: string };

let queue: Line[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

// Saved originals so removal fully restores the console.
const orig = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
let onError: ((e: ErrorEvent) => void) | null = null;
let onRej: ((e: PromiseRejectionEvent) => void) | null = null;

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function enqueue(level: string, msg: string): void {
  queue.push({ level, msg });
  if (queue.length >= 50) {
    void flushDebugQueue();
  } else if (!timer) {
    timer = setTimeout(() => void flushDebugQueue(), 1000);
  }
}

export async function flushDebugQueue(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    await api.debugLogAppend(batch);
  } catch {
    /* best-effort: drop on failure */
  }
}

export function installDebugHooks(): void {
  if (installed) return;
  installed = true;
  console.log = (...args: unknown[]) => {
    enqueue("INFO", stringify(args));
    orig.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    enqueue("WARN", stringify(args));
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    enqueue("ERROR", stringify(args));
    orig.error(...args);
  };
  if (typeof window !== "undefined") {
    onError = (e: ErrorEvent) => enqueue("ERROR", `uncaught ${e.message} @ ${e.filename}:${e.lineno}`);
    onRej = (e: PromiseRejectionEvent) => enqueue("ERROR", `unhandled rejection ${stringify([e.reason])}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRej);
  }
}

export function removeDebugHooks(): void {
  if (!installed) return;
  installed = false;
  console.log = orig.log;
  console.warn = orig.warn;
  console.error = orig.error;
  if (typeof window !== "undefined") {
    if (onError) window.removeEventListener("error", onError);
    if (onRej) window.removeEventListener("unhandledrejection", onRej);
  }
  onError = onRej = null;
}

export function perf<T>(label: string, fn: () => T): T {
  const t = performance.now();
  try {
    return fn();
  } finally {
    enqueue("PERF", `${label} ${Math.round(performance.now() - t)}ms`);
  }
}

export async function perfAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    enqueue("PERF", `${label} ${Math.round(performance.now() - t)}ms`);
  }
}

/** Mirror of setTelemetryChoice: persist the pref, flip the backend writer,
 *  install/remove FE hooks, and (optionally) clear the existing log. */
export async function setDebugMode(enabled: boolean, clearLog = false): Promise<void> {
  debugMode.set(enabled);
  void api.savePref("debug_mode", enabled ? "on" : "off").catch(() => {});
  if (enabled) {
    installDebugHooks();
    await api.debugSet(true).catch(() => {});
  } else {
    await flushDebugQueue();
    await api.debugSet(false).catch(() => {});
    if (clearLog) await api.debugClear().catch(() => {});
    removeDebugHooks();
  }
}
