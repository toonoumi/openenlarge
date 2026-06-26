# Debug Mode + Log Export — Design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)

## Motivation

A Windows user reports the app is "really slow." There is currently no way to see
*where* time goes on a remote machine: backend diagnostics go to `eprintln!`
(stderr, uncaptured), frontend logs go to the dev console, and neither is
reachable on a packaged build. We need an opt-in **debug mode** that records
logs, errors, and performance timings to a file the user can export as a single
`.txt` and send to us.

## Goals

- A `debug_mode` toggle in Settings, persisted like other prefs.
- When on: capture **frontend + backend** logs, errors, and perf timings into a
  single, chronologically-ordered **continuous log file** that survives crashes.
- Measure **operation timings** and **memory usage**; produce a **session
  summary** at the top of the export.
- A new **export-log button** left of the gear, visible only when debug mode is
  on, that saves the log (summary + raw) as a `.txt`.

## Non-goals

- Sending logs anywhere automatically (no network; export is manual).
- Replacing the existing opt-in telemetry (Aptabase) system — unrelated.
- Structured/queryable logging, log levels UI, or live log viewer in-app.

## Architecture

A `debug_mode` pref (string `"on"`/`"off"`, persisted via the existing
`save_pref`/`load_prefs` catalog path, mirrored to a Svelte store) gates a single
**backend-owned log file** at `<app_data>/debug.log`. Both Rust and JS funnel
into this one file through the backend writer, so entries from both sides are
unified and time-ordered.

```
console.* / window.onerror / perf()  ──┐
  (frontend, when debug on, batched)    │  invoke("debug_log_append", lines)
                                        ▼
eprintln-style diag + time_op! +   ──► DebugLog (Mutex<Option<BufWriter<File>>>)
panic hook + mem sampler                │  managed Tauri state
  (backend, when debug on)              ▼
                                  <app_data>/debug.log  (capped ~10 MB)
                                        │  save_log → summary header + raw
                                        ▼
                              save dialog → openenlarge-debug-<ts>.txt
```

### Line format

One line per entry, sortable and greppable:

```
<ISO8601-local-ts> <SRC> <LEVEL> <message>
```

- `SRC` ∈ `BE` (backend) / `FE` (frontend).
- `LEVEL` ∈ `INFO` / `WARN` / `ERROR` / `PERF` / `MEM` / `PANIC`.
- Perf lines: `... BE PERF develop_image 1234ms` (op name + integer ms).
- Mem lines: `... BE MEM rss=512MB cache=1.2GB`.

## Components

### Backend

**`debug_log.rs` (new module)**
- `pub struct DebugLog { inner: Mutex<Option<BufWriter<File>>>, path: PathBuf, bytes: AtomicU64 }`
  managed as Tauri state.
- `DebugLog::enable(&self)` — open/create the file in append mode, install state;
  `disable(&self)` — flush + drop the writer; `clear(&self)` — truncate the file.
- `DebugLog::write(&self, src: &str, level: &str, msg: &str)` — timestamp + format
  + append; no-op when writer is `None` (gate). Increments `bytes`; when over the
  cap (10 MB) performs a **truncation-rotate**: keep the tail (e.g. last ~5 MB)
  by rewriting, so the file stays bounded and the most recent context is kept.
  Never panics, never blocks the caller meaningfully (small buffered writes).
- A `dlog!(app, level, "..")` macro and a `time_op!` RAII guard (records elapsed
  ms on drop and writes a `PERF` line).
- `install_panic_hook(app)` — chain a panic hook that writes a `PANIC` line
  (message + location) before the default hook runs.

**Initialization (`lib.rs` setup)**
- After the catalog opens and prefs load (where telemetry is already seeded),
  read `debug_mode`; if `"on"`, call `DebugLog::enable` and `install_panic_hook`
  **before** the frontend hydrates, so startup/hydrate timing is captured.
- `app.manage(DebugLog::new(dir.join("debug.log")))` always (writer stays `None`
  until enabled).

**New commands (`commands.rs`, registered in `lib.rs`)**
- `debug_set(app, enabled: bool)` — enable/disable the writer + (un)install panic
  hook at runtime; persists nothing itself (frontend persists the pref via
  `save_pref`, matching the telemetry pattern).
- `debug_log_append(app, lines: Vec<DebugLine>)` — write a batch of `FE` lines.
  `DebugLine { level: String, msg: String }`.
- `debug_clear(app)` — truncate the file.
- `save_log(app, out_path: String)` — flush, parse the file to compute the
  **session summary**, write `summary + "\n\n" + raw file contents` to `out_path`.

**Perf instrumentation** — wrap with `time_op!`/`dlog!` in:
`import_image`, `develop_image`, `render_view`, `thumbnail`, `export_image`
(+ hdr), `load_catalog` (hydrate), `ai_enhance_image`, autodust detect/inpaint.

**Memory sampler** — a background thread (spawned on `enable`, stopped on
`disable`) that every ~10s writes a `MEM` line: process RSS via `sysinfo`
(confirm if already a dep; otherwise add `sysinfo`) and the current cache size.

**Session summary (in `save_log`)** — parse `PERF`/`MEM`/`ERROR`/`PANIC` lines
and emit a header block:
```
=== OpenEnlarge debug log ===
app: <version>   os: <platform/version>   exported: <ts>
errors: <n>   warnings: <n>   panics: <n>
peak rss: <MB>   final cache: <GB>
operation       count   avg ms   max ms
develop_image      12      980     2400
render_view        88       40      210
...
=============================
```

### Frontend

**`debug.ts` (new, `app/src/lib/`)**
- `debugMode` store import (from `store.ts`); a module that, when enabled,
  installs hooks and flushes batches; when disabled, restores originals.
- `installDebugHooks()` — wrap `console.error/warn/log`, add `window.onerror` and
  `unhandledrejection` listeners; buffer entries and flush via
  `api.debugLogAppend(lines)` on a short timer / size threshold (avoid one IPC
  per log). `removeDebugHooks()` reverses it.
- `perf(label, fn)` / `await perfAsync(label, fn)` — wrap a few FE spans (preview
  render, hydrate) and emit `PERF`-level FE lines.
- `setDebugMode(enabled)` — mirror of `setTelemetryChoice`: set store, call
  `api.debugSet(enabled)`, persist `save_pref("debug_mode", ...)`, install/remove
  hooks. On disable, optionally call `api.debugClear()` (offer via confirm).

**`store.ts`** — `export const debugMode = writable<boolean>(false);`

**`catalog.ts` hydrate** — seed `debugMode` from `snap.prefs.debug_mode === "on"`,
and if on, install FE hooks immediately.

**`api.ts`** — add `debugSet`, `debugLogAppend`, `debugClear`, `saveLog`
(`saveLog` uses the save dialog to pick `out_path`, then invokes `save_log`).

**`SettingsMenu.svelte`** — new group with a segmented on/off control (telemetry
pattern) bound to `setDebugMode`, plus a hint line ("Records logs & timings to a
file you can export to help diagnose issues. Restart and reproduce to capture
startup timing.").

**`+page.svelte`** — a new icon button rendered immediately left of the `.gear`
button, shown only `{#if $debugMode}`. Click → `api.saveLog()`. New icon
(document/download) added to the icon set. `aria-label` from i18n.

## Data flow

1. User toggles debug on in Settings → store set, pref saved, `debug_set(true)`
   opens the file + panic hook, FE hooks installed. Export button appears.
2. As the app runs, BE `dlog!`/`time_op!`/mem-sampler and FE hooked
   `console`/`onerror`/`perf` append lines to `debug.log` (FE batched via IPC).
3. User clicks export → `saveLog()` → save dialog → `save_log` writes
   summary+raw `.txt`.
4. Toggle off → `debug_set(false)` flushes/closes, FE hooks removed, optional
   clear. Button disappears.

## Error handling

- All logging is best-effort and must never throw/panic into the app: writer
  errors are swallowed (at most a one-time `eprintln!`). FE flush failures are
  caught and dropped (`.catch(() => {})`).
- If `debug.log` is missing/empty at export, `save_log` still writes a summary
  header noting "no entries".
- Truncation-rotate guards against unbounded growth; if rotation fails, fall back
  to truncating to empty rather than letting the file grow without bound.

## i18n

New keys added to `/i18n-strings.csv`, regenerated via `scripts/gen-i18n.py`
(never edit `dict.ts` directly):
- `settings.debug.heading`, `settings.debug.on`, `settings.debug.off`,
  `settings.debug.hint`, `settings.debug.clearLogConfirm`
- `app.debug.exportAriaLabel`, and any export toast/error strings.

## Testing

Backend unit tests (`debug_log.rs` / `catalog.rs`):
- Gating: `write` is a no-op when disabled; appends when enabled.
- `debug_log_append` batch writes FE lines with correct `FE` source.
- Truncation-rotate keeps the file ≤ cap and preserves the tail.
- Summary parsing: given a known log, `save_log` emits correct counts and
  avg/max per op.
- `debug_mode` pref round-trips through the catalog.

Frontend (vitest, matching existing `*.test.ts`):
- `setDebugMode` toggles the store, persists the pref, installs/removes hooks.
- Hooked `console.error` enqueues a line; flush calls `debugLogAppend`.
- Originals are restored after `removeDebugHooks`.

Manual smoke (GUI): toggle on → button appears; run import/develop/export;
export → `.txt` contains summary + BE/FE/PERF/MEM lines; toggle off → button
hides, optional clear works.

## Open implementation checks (resolve during build, not blocking)

- Confirm `sysinfo` (or equivalent) availability for RSS; add if missing.
- Confirm the save-dialog plugin (`@tauri-apps/plugin-dialog`) `save` API is
  available (already used for `confirm`).
- Decide exact cap/tail sizes (default 10 MB cap, keep last 5 MB on rotate).
