# Debug Mode + Log Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in debug mode that records frontend + backend logs, errors, and performance timings to a single continuous log file, exportable as a `.txt` via a button left of the gear — built to diagnose a Windows user's "app is really slow" report.

**Architecture:** A `debug_mode` pref (persisted like `telemetry`) gates a backend-owned log file at `<app_data>/debug.log`. Both Rust and JS funnel into it through the backend writer so entries are unified and time-ordered. Backend stamps every line with milliseconds-since-process-start (monotonic; no clock-skew between FE and BE, no date dependency). Export builds a session-summary header (per-op avg/max ms, peak RSS) followed by the raw log.

**Tech Stack:** Rust (Tauri 2), Svelte/TypeScript, `sysinfo` (new, for RSS), `@tauri-apps/plugin-dialog` (save dialog, already present), existing catalog prefs path, i18n CSV + `scripts/gen-i18n.py`.

## Global Constraints

- Work directly on `main` (no feature branch) — user preference for this repo.
- i18n: add strings to `/i18n-strings.csv` and run `python3 scripts/gen-i18n.py`; NEVER edit `app/src/lib/i18n/dict.ts` by hand (regen wipes it).
- All logging is best-effort: it MUST never throw, panic, or block the app. Swallow every writer/IPC error.
- Log line format (exact): `[+NNNNNNNNms] <SRC> <LEVEL> <msg>` where `SRC` ∈ `BE`/`FE`, `LEVEL` ∈ `INFO`/`WARN`/`ERROR`/`PERF`/`MEM`/`PANIC`. Newlines in `msg` are replaced with spaces.
- PERF line body: `<op> <ms>ms` (e.g. `develop_image 980ms`). MEM line body: `rss=<MB> cache=<bytes>` (rss in whole MB, cache in raw bytes).
- Log file cap: 10 MB (`CAP_BYTES = 10 * 1024 * 1024`); on overflow keep the last 5 MB (`KEEP_BYTES = 5 * 1024 * 1024`) from a newline boundary.
- The export button is visible ONLY when debug mode is on.
- The Tauri app exposes the model as state `Session`/`Catalog`; new state `DebugLog` is `app.manage(...)`d at setup, always (writer stays inactive until enabled).

---

## File Structure

**Backend (`app/src-tauri/`):**
- Create `src/debug_log.rs` — `DebugLog` state (writer + gating + rotation + elapsed stamping), panic hook, memory sampler, summary builder, `time_op!`/`dlog!` macros. One module owns all debug-logging responsibility.
- Modify `src/lib.rs` — `mod debug_log;`, manage `DebugLog`, enable-on-pref + panic hook at setup, register new commands.
- Modify `src/commands.rs` — `debug_set`, `debug_log_append`, `debug_clear`, `save_log` commands; `time_op!` instrumentation in heavy commands.
- Modify `Cargo.toml` — add `sysinfo`.

**Frontend (`app/src/`):**
- Create `lib/debug.ts` — console/error/perf hooks, batch flush, `setDebugMode`, `installDebugHooks`/`removeDebugHooks`.
- Create `lib/debug.test.ts` — vitest for the above.
- Modify `lib/store.ts` — `debugMode` writable.
- Modify `lib/api.ts` — `debugSet`, `debugLogAppend`, `debugClear`, `saveLog`.
- Modify `lib/catalog.ts` — seed `debugMode` from prefs + install hooks on hydrate.
- Modify `lib/settings/SettingsMenu.svelte` — debug on/off segmented control + hint.
- Modify `lib/icons/Icon.svelte` — add `file-text` icon.
- Modify `routes/+page.svelte` — export-log button left of gear (gated on `$debugMode`).
- Modify `/i18n-strings.csv` — new strings; regen `dict.ts`.

---

## Task 1: Backend `DebugLog` core (writer, gating, elapsed stamp, rotation)

**Files:**
- Create: `app/src-tauri/src/debug_log.rs`
- Modify: `app/src-tauri/src/lib.rs` (add `mod debug_log;` near other `mod` lines, and `app.manage(...)` in setup)
- Test: inline `#[cfg(test)]` in `app/src-tauri/src/debug_log.rs`

**Interfaces:**
- Produces:
  - `pub struct DebugLog` (`#[derive(Clone)]`, wraps `Arc<DebugLogInner>`) with:
    - `pub fn new(path: PathBuf) -> DebugLog`
    - `pub fn enable(&self)` — open file in append mode, set writer
    - `pub fn disable(&self)` — flush + drop writer
    - `pub fn clear(&self)` — truncate file to empty, reset byte counter
    - `pub fn is_on(&self) -> bool`
    - `pub fn write(&self, src: &str, level: &str, msg: &str)` — gated, best-effort, rotates when over cap
    - `pub fn path(&self) -> &Path`
  - `pub const CAP_BYTES: u64`, `pub const KEEP_BYTES: usize`

- [ ] **Step 1: Write the failing test**

Add to `app/src-tauri/src/debug_log.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);
    fn temp_path(tag: &str) -> std::path::PathBuf {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("oe-dbg-{}-{}-{}.log", std::process::id(), tag, n))
    }

    #[test]
    fn write_is_noop_until_enabled() {
        let p = temp_path("noop");
        let log = DebugLog::new(p.clone());
        log.write("BE", "INFO", "should not appear");
        assert!(!p.exists(), "no file should be created while disabled");

        log.enable();
        log.write("BE", "INFO", "hello world");
        log.disable();
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("BE INFO hello world"), "got: {body}");
        assert!(body.starts_with("[+"), "line is elapsed-stamped: {body}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn newlines_in_msg_become_spaces() {
        let p = temp_path("nl");
        let log = DebugLog::new(p.clone());
        log.enable();
        log.write("FE", "ERROR", "line one\nline two");
        log.disable();
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("FE ERROR line one line two"), "got: {body}");
        assert_eq!(body.lines().count(), 1);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rotation_keeps_file_bounded_and_preserves_tail() {
        let p = temp_path("rot");
        let log = DebugLog::new(p.clone());
        log.enable();
        // Write well past the cap; final marker must survive.
        let big = "x".repeat(2000);
        for i in 0..(CAP_BYTES / 1000 + 50) {
            log.write("BE", "INFO", &format!("{i} {big}"));
        }
        log.write("BE", "INFO", "FINAL_MARKER");
        log.disable();
        let meta = std::fs::metadata(&p).unwrap();
        assert!(meta.len() <= CAP_BYTES, "file {} exceeds cap", meta.len());
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("FINAL_MARKER"), "tail must be preserved");
        assert!(body.lines().next().unwrap().starts_with("[+"), "tail starts at a line boundary");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn clear_truncates() {
        let p = temp_path("clr");
        let log = DebugLog::new(p.clone());
        log.enable();
        log.write("BE", "INFO", "before clear");
        log.clear();
        log.write("BE", "INFO", "after clear");
        log.disable();
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(!body.contains("before clear"));
        assert!(body.contains("after clear"));
        std::fs::remove_file(&p).ok();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/src-tauri && cargo test --lib debug_log::tests 2>&1 | tail -20`
Expected: FAIL — `DebugLog` / `CAP_BYTES` not found (module has no implementation yet).

- [ ] **Step 3: Write minimal implementation**

At the TOP of `app/src-tauri/src/debug_log.rs` (above the `#[cfg(test)]` block):

```rust
//! Opt-in debug logging. When enabled, both the Rust backend and the JS
//! frontend append timestamped lines to a single capped file. Every write is
//! best-effort and never panics — debug logging must not destabilize the app.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const CAP_BYTES: u64 = 10 * 1024 * 1024;
pub const KEEP_BYTES: usize = 5 * 1024 * 1024;

struct DebugLogInner {
    path: PathBuf,
    start: Instant,
    writer: Mutex<Option<BufWriter<File>>>,
    bytes: AtomicU64,
}

#[derive(Clone)]
pub struct DebugLog(Arc<DebugLogInner>);

impl DebugLog {
    pub fn new(path: PathBuf) -> DebugLog {
        DebugLog(Arc::new(DebugLogInner {
            path,
            start: Instant::now(),
            writer: Mutex::new(None),
            bytes: AtomicU64::new(0),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.0.path
    }

    pub fn is_on(&self) -> bool {
        self.0.writer.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn enable(&self) {
        let mut g = match self.0.writer.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.is_some() {
            return;
        }
        let len = std::fs::metadata(&self.0.path).map(|m| m.len()).unwrap_or(0);
        if let Ok(f) = OpenOptions::new().create(true).append(true).open(&self.0.path) {
            self.0.bytes.store(len, Ordering::Relaxed);
            *g = Some(BufWriter::new(f));
        }
    }

    pub fn disable(&self) {
        if let Ok(mut g) = self.0.writer.lock() {
            if let Some(mut w) = g.take() {
                let _ = w.flush();
            }
        }
    }

    pub fn clear(&self) {
        let mut g = match self.0.writer.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let was_on = g.is_some();
        if let Some(mut w) = g.take() {
            let _ = w.flush();
        }
        let _ = std::fs::write(&self.0.path, b"");
        self.0.bytes.store(0, Ordering::Relaxed);
        if was_on {
            if let Ok(f) = OpenOptions::new().create(true).append(true).open(&self.0.path) {
                *g = Some(BufWriter::new(f));
            }
        }
    }

    pub fn write(&self, src: &str, level: &str, msg: &str) {
        let mut g = match self.0.writer.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if g.is_none() {
            return;
        }
        let ms = self.0.start.elapsed().as_millis();
        let line = format!("[+{:08}ms] {} {} {}\n", ms, src, level, msg.replace('\n', " "));
        if self.0.bytes.load(Ordering::Relaxed) + line.len() as u64 > CAP_BYTES {
            self.rotate(&mut g);
        }
        if let Some(w) = g.as_mut() {
            if w.write_all(line.as_bytes()).is_ok() {
                let _ = w.flush();
                self.0.bytes.fetch_add(line.len() as u64, Ordering::Relaxed);
            }
        }
    }

    /// Drop the writer, rewrite the file to its last `KEEP_BYTES` (trimmed to a
    /// line boundary), then reopen in append mode. Caller holds the lock.
    fn rotate(&self, g: &mut Option<BufWriter<File>>) {
        if let Some(mut w) = g.take() {
            let _ = w.flush();
        }
        if let Ok(data) = std::fs::read(&self.0.path) {
            let tail: Vec<u8> = if data.len() > KEEP_BYTES {
                let start = data.len() - KEEP_BYTES;
                let nl = data[start..]
                    .iter()
                    .position(|&b| b == b'\n')
                    .map(|p| start + p + 1)
                    .unwrap_or(start);
                data[nl..].to_vec()
            } else {
                data
            };
            if std::fs::write(&self.0.path, &tail).is_ok() {
                self.0.bytes.store(tail.len() as u64, Ordering::Relaxed);
            }
        }
        if let Ok(f) = OpenOptions::new().create(true).append(true).open(&self.0.path) {
            *g = Some(BufWriter::new(f));
        }
    }
}
```

In `app/src-tauri/src/lib.rs`, add the module declaration next to the other `mod` statements (e.g. after `mod commands;`):

```rust
mod debug_log;
```

And in the `setup` closure, right after the `app_data_dir` block creates `dir` (after `std::fs::create_dir_all(&dir)...`), manage the state:

```rust
            app.manage(debug_log::DebugLog::new(dir.join("debug.log")));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/src-tauri && cargo test --lib debug_log::tests 2>&1 | tail -20`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/debug_log.rs app/src-tauri/src/lib.rs
git commit -m "feat(debug): DebugLog writer with gating, elapsed stamps, rotation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 2: Memory-line formatter, memory sampler, panic hook

**Files:**
- Modify: `app/src-tauri/src/debug_log.rs`
- Modify: `app/src-tauri/Cargo.toml` (add `sysinfo`)
- Test: inline `#[cfg(test)]` in `debug_log.rs`

**Interfaces:**
- Consumes: `DebugLog` (Task 1).
- Produces:
  - `pub fn format_mem_line(rss_mb: u64, cache_bytes: u64) -> String` → `"rss=<MB> cache=<bytes>"`
  - `pub fn start_mem_sampler(log: DebugLog, cache_bytes: impl Fn() -> u64 + Send + 'static)` — spawns a thread that samples every 10s while `log.is_on()`, writes a `MEM` line, and self-exits once `log.is_on()` is false.
  - `pub fn install_panic_hook(log: DebugLog)` — chains a panic hook that writes a `PANIC` line.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `debug_log.rs`:

```rust
    #[test]
    fn mem_line_format() {
        assert_eq!(format_mem_line(512, 1288490188), "rss=512 cache=1288490188");
    }

    #[test]
    fn mem_line_is_written_via_log() {
        let p = temp_path("mem");
        let log = DebugLog::new(p.clone());
        log.enable();
        log.write("BE", "MEM", &format_mem_line(128, 4096));
        log.disable();
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("BE MEM rss=128 cache=4096"), "got: {body}");
        std::fs::remove_file(&p).ok();
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/src-tauri && cargo test --lib debug_log::tests::mem 2>&1 | tail -20`
Expected: FAIL — `format_mem_line` not found.

- [ ] **Step 3: Write minimal implementation**

Add `sysinfo` to `app/src-tauri/Cargo.toml` under `[dependencies]`:

```bash
cd app/src-tauri && cargo add sysinfo --no-default-features --features system
```

(The `system` feature is enough for process RSS; this avoids pulling disk/network probes.)

Add to `debug_log.rs` (after the `impl DebugLog` block, before the test module):

```rust
/// `MEM` line body. rss in whole MB, cache in raw bytes — both integers so the
/// summary parser can read them back trivially.
pub fn format_mem_line(rss_mb: u64, cache_bytes: u64) -> String {
    format!("rss={} cache={}", rss_mb, cache_bytes)
}

/// Sample this process's resident memory every 10s while debug logging is on,
/// writing a `MEM` line each tick. Exits on its own once logging is disabled.
pub fn start_mem_sampler<F>(log: DebugLog, cache_bytes: F)
where
    F: Fn() -> u64 + Send + 'static,
{
    std::thread::spawn(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let pid = Pid::from_u32(std::process::id());
        let mut sys = System::new();
        while log.is_on() {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[pid]),
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            let rss_mb = sys
                .process(pid)
                .map(|p| p.memory() / (1024 * 1024))
                .unwrap_or(0);
            log.write("BE", "MEM", &format_mem_line(rss_mb, cache_bytes()));
            // Sleep in short slices so disable() is honored within ~1s.
            for _ in 0..10 {
                if !log.is_on() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    });
}

/// Chain a panic hook that records the panic to the debug log (when on) before
/// delegating to the previous hook (so default crash behavior is unchanged).
pub fn install_panic_hook(log: DebugLog) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".into());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic>".into());
        log.write("BE", "PANIC", &format!("{loc} {payload}"));
        prev(info);
    }));
}
```

> Note on the `sysinfo` API: the calls above target `sysinfo` 0.33/0.34. If `cargo add` pulls a version whose `refresh_processes_specifics` / `ProcessRefreshKind` signature differs, adjust to that version's equivalent for "refresh memory of one pid and read `process.memory()` (bytes)". The contract this task must satisfy: `rss_mb` = this process's resident set in whole MB.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/src-tauri && cargo test --lib debug_log::tests 2>&1 | tail -20`
Expected: PASS (all debug_log tests, including the two new mem tests).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/debug_log.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat(debug): memory sampler, panic hook, sysinfo dep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 3: Summary builder (pure parser)

**Files:**
- Modify: `app/src-tauri/src/debug_log.rs`
- Test: inline `#[cfg(test)]` in `debug_log.rs`

**Interfaces:**
- Consumes: the log line format from Task 1.
- Produces: `pub fn build_summary(log_text: &str, app_version: &str, os: &str) -> String` — a fixed header block summarizing counts and per-op PERF stats, peak RSS, final cache.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
    #[test]
    fn summary_counts_and_perf_table() {
        let log = "\
[+00000001ms] BE INFO startup
[+00000100ms] BE PERF develop_image 1000ms
[+00000200ms] BE PERF develop_image 3000ms
[+00000300ms] BE PERF render_view 40ms
[+00000400ms] FE ERROR boom
[+00000500ms] BE PANIC src/x.rs:1 kaboom
[+00000600ms] BE MEM rss=300 cache=1048576
[+00000700ms] BE MEM rss=512 cache=2097152
";
        let s = build_summary(log, "0.1.0", "windows");
        assert!(s.contains("app: 0.1.0"));
        assert!(s.contains("os: windows"));
        assert!(s.contains("errors: 1"));
        assert!(s.contains("panics: 1"));
        // develop_image: count 2, avg 2000, max 3000
        assert!(s.contains("develop_image"));
        assert!(s.contains("2000"), "avg ms missing in: {s}");
        assert!(s.contains("3000"), "max ms missing in: {s}");
        // peak rss = 512 (MB)
        assert!(s.contains("peak rss: 512"), "peak rss missing in: {s}");
    }

    #[test]
    fn summary_handles_empty_log() {
        let s = build_summary("", "0.1.0", "macos");
        assert!(s.contains("no entries") || s.contains("errors: 0"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app/src-tauri && cargo test --lib debug_log::tests::summary 2>&1 | tail -20`
Expected: FAIL — `build_summary` not found.

- [ ] **Step 3: Write minimal implementation**

Add to `debug_log.rs` (before the test module):

```rust
/// Parse a debug log and produce a human-readable summary header. Pure function
/// over the log text so it is unit-testable without any I/O.
pub fn build_summary(log_text: &str, app_version: &str, os: &str) -> String {
    use std::collections::BTreeMap;
    let (mut errors, mut warnings, mut panics) = (0u32, 0u32, 0u32);
    let mut peak_rss: u64 = 0;
    let mut final_cache: u64 = 0;
    // op -> (count, sum_ms, max_ms)
    let mut perf: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
    let mut entries = 0u32;

    for raw in log_text.lines() {
        // Strip the `[+...] ` prefix.
        let rest = match raw.split_once("] ") {
            Some((_, r)) => r,
            None => continue,
        };
        entries += 1;
        let mut it = rest.splitn(3, ' ');
        let _src = it.next().unwrap_or("");
        let level = it.next().unwrap_or("");
        let body = it.next().unwrap_or("");
        match level {
            "ERROR" => errors += 1,
            "WARN" => warnings += 1,
            "PANIC" => panics += 1,
            "PERF" => {
                // body = "<op> <ms>ms"
                if let Some((op, mss)) = body.rsplit_once(' ') {
                    if let Ok(ms) = mss.trim_end_matches("ms").parse::<u64>() {
                        let e = perf.entry(op.to_string()).or_insert((0, 0, 0));
                        e.0 += 1;
                        e.1 += ms;
                        e.2 = e.2.max(ms);
                    }
                }
            }
            "MEM" => {
                // body = "rss=<MB> cache=<bytes>"
                for tok in body.split_whitespace() {
                    if let Some(v) = tok.strip_prefix("rss=") {
                        if let Ok(n) = v.parse::<u64>() {
                            peak_rss = peak_rss.max(n);
                        }
                    } else if let Some(v) = tok.strip_prefix("cache=") {
                        if let Ok(n) = v.parse::<u64>() {
                            final_cache = n;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let cache_gb = final_cache as f64 / (1024.0 * 1024.0 * 1024.0);
    let mut out = String::new();
    out.push_str("=== OpenEnlarge debug log ===\n");
    out.push_str(&format!("app: {app_version}   os: {os}\n"));
    if entries == 0 {
        out.push_str("(no entries — debug mode may have just been enabled)\n");
    }
    out.push_str(&format!("errors: {errors}   warnings: {warnings}   panics: {panics}\n"));
    out.push_str(&format!("peak rss: {peak_rss} MB   final cache: {cache_gb:.2} GB\n"));
    out.push_str(&format!("{:<24}{:>7}{:>9}{:>9}\n", "operation", "count", "avg ms", "max ms"));
    for (op, (count, sum, max)) in &perf {
        let avg = if *count > 0 { sum / count } else { 0 };
        out.push_str(&format!("{:<24}{:>7}{:>9}{:>9}\n", op, count, avg, max));
    }
    out.push_str("=============================\n");
    out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app/src-tauri && cargo test --lib debug_log::tests 2>&1 | tail -20`
Expected: PASS (all debug_log tests).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/debug_log.rs
git commit -m "feat(debug): session summary builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 4: Backend commands + startup wiring + perf instrumentation

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (new commands + `time_op!` in heavy commands)
- Modify: `app/src-tauri/src/debug_log.rs` (add `time_op!` + `dlog!` macros)
- Modify: `app/src-tauri/src/lib.rs` (register commands; enable-on-pref + panic hook + mem sampler at setup)
- Test: compile + existing tests (commands are thin glue over Task 1–3, already unit-tested)

**Interfaces:**
- Consumes: `DebugLog` (Task 1–3).
- Produces (Tauri commands, called from `api.ts` in Task 6):
  - `debug_set(enabled: bool, app: AppHandle)` → enable/disable writer, (re)install panic hook + mem sampler on enable
  - `debug_log_append(lines: Vec<DebugLine>, log: State<DebugLog>)`, `DebugLine { level: String, msg: String }`
  - `debug_clear(log: State<DebugLog>)`
  - `save_log(out_path: String, app: AppHandle) -> Result<(), String>`
  - macro `time_op!(app_or_log, "op_name", { ... })` returning the block's value

- [ ] **Step 1: Add the macros (no test — exercised by Step 4 build + Task 1–3 cover the writer)**

Add to `debug_log.rs` (top-level, after the consts):

```rust
/// Write a debug line if `$log` (a `&DebugLog`) is on. Best-effort.
#[macro_export]
macro_rules! dlog {
    ($log:expr, $level:expr, $($arg:tt)*) => {
        $log.write("BE", $level, &format!($($arg)*))
    };
}

/// Time a block and emit a `PERF <op> <ms>ms` line. Returns the block's value.
#[macro_export]
macro_rules! time_op {
    ($log:expr, $op:expr, $body:block) => {{
        let __t = std::time::Instant::now();
        let __r = $body;
        let __ms = __t.elapsed().as_millis();
        $log.write("BE", "PERF", &format!("{} {}ms", $op, __ms));
        __r
    }};
}
```

- [ ] **Step 2: Add the commands**

In `app/src-tauri/src/commands.rs`, add (near the other small commands like `save_pref`):

```rust
#[derive(serde::Deserialize)]
pub struct DebugLine {
    pub level: String,
    pub msg: String,
}

#[tauri::command]
pub fn debug_set(enabled: bool, app: tauri::AppHandle) {
    let log = app.state::<crate::debug_log::DebugLog>().inner().clone();
    if enabled {
        log.enable();
        crate::debug_log::install_panic_hook(log.clone());
        let app2 = app.clone();
        crate::debug_log::start_mem_sampler(log.clone(), move || {
            // Current image-cache size on disk; 0 on any error.
            crate::cache::dir_size(
                &app2
                    .state::<crate::session::Session>()
                    .cache_dir
                    .lock()
                    .map(|d| d.clone())
                    .unwrap_or_default(),
            )
            .unwrap_or(0)
        });
        crate::dlog!(log, "INFO", "debug mode enabled");
    } else {
        crate::dlog!(log, "INFO", "debug mode disabled");
        log.disable();
    }
}

#[tauri::command]
pub fn debug_log_append(lines: Vec<DebugLine>, log: tauri::State<crate::debug_log::DebugLog>) {
    for l in &lines {
        log.write("FE", &l.level, &l.msg);
    }
}

#[tauri::command]
pub fn debug_clear(log: tauri::State<crate::debug_log::DebugLog>) {
    log.clear();
}

#[tauri::command]
pub fn save_log(out_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let log = app.state::<crate::debug_log::DebugLog>();
    let body = std::fs::read_to_string(log.path()).unwrap_or_default();
    let version = app.package_info().version.to_string();
    let summary = crate::debug_log::build_summary(&body, &version, std::env::consts::OS);
    std::fs::write(&out_path, format!("{summary}\n{body}")).map_err(|e| e.to_string())
}
```

> The mem-sampler closure needs a function that returns the cache directory size in bytes. Check `app/src-tauri/src/cache.rs` for the existing size helper used by the `cache_size` command (it already computes this for Settings). If it is named differently than `cache::dir_size`, use that name; if it takes different args, adapt. Do NOT write a second directory-walker — reuse the existing one (DRY).

- [ ] **Step 3: Register commands + startup wiring in `lib.rs`**

In the `tauri::generate_handler![...]` list, add:

```rust
            commands::debug_set,
            commands::debug_log_append,
            commands::debug_clear,
            commands::save_log,
```

In the `setup` closure, after the `app.manage(debug_log::DebugLog::new(...))` line AND after the catalog prefs are loaded (the existing `if let Ok(prefs) = catalog.load_prefs()` block that seeds telemetry), enable debug logging when the pref is on — reuse the same `prefs` map:

```rust
            if let Ok(prefs) = catalog.load_prefs() {
                if prefs.get("telemetry").map(|v| v == "on").unwrap_or(false) {
                    app.state::<telemetry::TelemetryState>().set(true);
                }
                if prefs.get("debug_mode").map(|v| v == "on").unwrap_or(false) {
                    let log = app.state::<debug_log::DebugLog>().inner().clone();
                    log.enable();
                    debug_log::install_panic_hook(log.clone());
                    debug_log::dlog_startup(&log);
                    let app2 = app.handle().clone();
                    debug_log::start_mem_sampler(log, move || {
                        cache::dir_size(
                            &app2.state::<session::Session>().cache_dir.lock()
                                .map(|d| d.clone()).unwrap_or_default(),
                        ).unwrap_or(0)
                    });
                }
            }
```

Add a small helper in `debug_log.rs` so startup logging is consistent:

```rust
pub fn dlog_startup(log: &DebugLog) {
    log.write("BE", "INFO", "debug mode enabled at startup");
}
```

> If `load_prefs()` is already consumed by the existing telemetry block (the `prefs` binding moved), keep a single `if let Ok(prefs)` block and add the `debug_mode` check inside it as shown — do not call `load_prefs()` twice.

- [ ] **Step 4: Instrument the heavy commands**

Wrap the body of each of these commands in `commands.rs` with `time_op!`, pulling the `DebugLog` from the `AppHandle`/state the command already has. Pattern (apply to each): obtain `let __log = app.state::<crate::debug_log::DebugLog>().inner().clone();` (or via an added `log: State<DebugLog>` arg if the command has no `app`/`State` access), then wrap the existing logic:

```rust
    let result = crate::time_op!(__log, "develop_image", { /* existing body */ });
```

Apply to: `import_image`, `develop_image`, `render_view`, `thumbnail`, `export_image`, `export_image_hdr`, `load_catalog`, `ai_enhance_image`, and the autodust detect/inpaint command(s). For commands that already return early via `?`, keep `?` inside the block (the block evaluates to the `Result`/value). Where adding a `State<DebugLog>` parameter, remember Tauri injects state by type — no frontend change needed.

> Keep this minimal and mechanical: only wrap the outermost work. Do not restructure command logic. If a command lacks any `AppHandle`/`State` to reach `DebugLog`, add `log: tauri::State<'_, crate::debug_log::DebugLog>` to its signature.

- [ ] **Step 5: Build + run existing tests**

Run: `cd app/src-tauri && cargo build 2>&1 | tail -20 && cargo test --lib 2>&1 | tail -20`
Expected: builds clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/debug_log.rs app/src-tauri/src/lib.rs
git commit -m "feat(debug): commands, startup enable, perf instrumentation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 5: Frontend `api.ts` bindings

**Files:**
- Modify: `app/src/lib/api.ts`

**Interfaces:**
- Consumes: Tauri commands from Task 4.
- Produces (added to the `api` object):
  - `debugSet(enabled: boolean): Promise<void>`
  - `debugLogAppend(lines: { level: string; msg: string }[]): Promise<void>`
  - `debugClear(): Promise<void>`
  - `saveLog(outPath: string): Promise<void>`

- [ ] **Step 1: Add bindings**

In `app/src/lib/api.ts`, alongside `savePref` (around line 302), add:

```typescript
  debugSet: (enabled: boolean) => invoke<void>("debug_set", { enabled }),
  debugLogAppend: (lines: { level: string; msg: string }[]) =>
    invoke<void>("debug_log_append", { lines }),
  debugClear: () => invoke<void>("debug_clear"),
  saveLog: (outPath: string) => invoke<void>("save_log", { outPath }),
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: no new errors from `api.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/api.ts
git commit -m "feat(debug): api bindings for debug commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 6: Frontend `debug.ts` (hooks, batching, perf, setDebugMode)

**Files:**
- Modify: `app/src/lib/store.ts` (add `debugMode`)
- Create: `app/src/lib/debug.ts`
- Test: `app/src/lib/debug.test.ts`

**Interfaces:**
- Consumes: `api.debugSet/debugLogAppend/debugClear` (Task 5), `api.savePref`.
- Produces:
  - store `debugMode: Writable<boolean>`
  - `installDebugHooks(): void`, `removeDebugHooks(): void`
  - `enqueue(level: string, msg: string): void`, `flushDebugQueue(): Promise<void>`
  - `perf<T>(label: string, fn: () => T): T`, `perfAsync<T>(label: string, fn: () => Promise<T>): Promise<T>`
  - `setDebugMode(enabled: boolean, clearLog?: boolean): Promise<void>`

- [ ] **Step 1: Add the store**

In `app/src/lib/store.ts`, near `telemetryEnabled` (around line 208), add:

```typescript
/** Debug logging consent. When on, FE hooks forward logs/errors/perf to the
 *  backend log file. Persisted via prefs as `debug_mode` ("on"/"off"). */
export const debugMode = writable<boolean>(false);
```

- [ ] **Step 2: Write the failing test**

Create `app/src/lib/debug.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/debug.test.ts 2>&1 | tail -20`
Expected: FAIL — `./debug` has no such exports.

- [ ] **Step 4: Write the implementation**

Create `app/src/lib/debug.ts`:

```typescript
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
  onError = (e: ErrorEvent) => enqueue("ERROR", `uncaught ${e.message} @ ${e.filename}:${e.lineno}`);
  onRej = (e: PromiseRejectionEvent) => enqueue("ERROR", `unhandled rejection ${stringify([e.reason])}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRej);
}

export function removeDebugHooks(): void {
  if (!installed) return;
  installed = false;
  console.log = orig.log;
  console.warn = orig.warn;
  console.error = orig.error;
  if (onError) window.removeEventListener("error", onError);
  if (onRej) window.removeEventListener("unhandledrejection", onRej);
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/debug.test.ts 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/debug.ts app/src/lib/debug.test.ts
git commit -m "feat(debug): frontend hooks, perf, setDebugMode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 7: Seed debug mode on hydrate

**Files:**
- Modify: `app/src/lib/catalog.ts`

**Interfaces:**
- Consumes: `debugMode` store, `installDebugHooks` (Task 6), `snap.prefs.debug_mode`.

- [ ] **Step 1: Add hydrate seeding**

In `app/src/lib/catalog.ts`, add `debugMode` to the store import and `installDebugHooks` to a `./debug` import. In the prefs-application block (right after the telemetry lines around line 87–88), add:

```typescript
  // Debug logging: install FE hooks immediately when the pref is on so this
  // session is captured from hydrate onward. Backend was already enabled at
  // startup via the same pref.
  if (snap.prefs.debug_mode === "on") {
    debugMode.set(true);
    installDebugHooks();
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/catalog.ts
git commit -m "feat(debug): seed debug mode + hooks on hydrate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 8: i18n strings

**Files:**
- Modify: `/i18n-strings.csv`
- Regenerate: `app/src/lib/i18n/dict.ts` (via script — do not hand-edit)

**Interfaces:**
- Produces translation keys consumed by Tasks 9–10.

- [ ] **Step 1: Add rows to the CSV**

Append these rows to `/i18n-strings.csv` (keep the column order `key,en,zh,ja,ko,file,note`). Use these translations:

```csv
settings.debug.heading,Debug mode,调试模式,デバッグモード,디버그 모드,src/lib/settings/SettingsMenu.svelte,heading
settings.debug.on,On,开启,オン,켜기,src/lib/settings/SettingsMenu.svelte,button
settings.debug.off,Off,关闭,オフ,끄기,src/lib/settings/SettingsMenu.svelte,button
settings.debug.hint,Records logs and performance timings to a file you can export to help diagnose problems. Restart and reproduce the issue to also capture startup timing.,将日志和性能计时记录到可导出的文件中以帮助诊断问题。重启并复现问题还可捕获启动计时。,問題の診断に役立つログとパフォーマンス計測をエクスポート可能なファイルに記録します。起動時の計測も取得するには、再起動して問題を再現してください。,문제 진단에 도움이 되도록 로그와 성능 측정을 내보낼 수 있는 파일에 기록합니다. 시작 시간도 캡처하려면 앱을 다시 시작하고 문제를 재현하세요.,src/lib/settings/SettingsMenu.svelte,hint
settings.debug.clearLogConfirm,Turn off debug mode and clear the existing log file?,关闭调试模式并清除现有日志文件吗？,デバッグモードをオフにして既存のログファイルを消去しますか？,디버그 모드를 끄고 기존 로그 파일을 지우시겠습니까?,src/lib/settings/SettingsMenu.svelte,confirm
app.debug.exportAriaLabel,Export debug log,导出调试日志,デバッグログをエクスポート,디버그 로그 내보내기,src/routes/+page.svelte,aria-label
app.debug.exported,Debug log exported,已导出调试日志,デバッグログをエクスポートしました,디버그 로그를 내보냈습니다,src/routes/+page.svelte,toast
app.debug.exportFailed,Could not export debug log,无法导出调试日志,デバッグログをエクスポートできませんでした,디버그 로그를 내보낼 수 없습니다,src/routes/+page.svelte,toast
```

- [ ] **Step 2: Regenerate the dictionary**

Run: `python3 scripts/gen-i18n.py && cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -10`
Expected: `dict.ts` regenerated; the new keys present; no typecheck errors.

Verify keys landed: `grep -c "settings.debug" app/src/lib/i18n/dict.ts` → expect ≥ 5 per locale block (non-zero).

- [ ] **Step 3: Commit**

```bash
git add i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "i18n: debug mode + log export strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 9: Settings toggle UI

**Files:**
- Modify: `app/src/lib/settings/SettingsMenu.svelte`

**Interfaces:**
- Consumes: `debugMode` store, `setDebugMode` (Task 6), i18n keys (Task 8).

- [ ] **Step 1: Add imports and toggle handler**

In the `<script>` block of `SettingsMenu.svelte`, add to the store import line `debugMode`, and import `setDebugMode`:

```typescript
  import { openaiApiKey, telemetryEnabled, debugMode } from "../store";
  import { setDebugMode } from "../debug";
```

Add a handler (near `onReset`):

```typescript
  async function onDebugToggle(on: boolean) {
    if (on) { await setDebugMode(true); return; }
    // Turning off: offer to also clear the log.
    const clear = await confirm($t("settings.debug.clearLogConfirm"),
      { title: "OpenEnlarge", kind: "warning" });
    await setDebugMode(false, clear);
  }
```

- [ ] **Step 2: Add the UI group**

In the template, after the Storage `.grp` block (after line ~116, before the `.shortcuts` buttons), add:

```svelte
  <div class="grp">
    <div class="head">{$t("settings.debug.heading")}</div>
    <div class="seg">
      <button class:on={!$debugMode} on:click={() => onDebugToggle(false)}>{$t("settings.debug.off")}</button>
      <button class:on={$debugMode} on:click={() => onDebugToggle(true)}>{$t("settings.debug.on")}</button>
    </div>
    <div class="hint">{$t("settings.debug.hint")}</div>
  </div>
```

- [ ] **Step 3: Typecheck + build**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/settings/SettingsMenu.svelte
git commit -m "feat(debug): settings toggle for debug mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 10: Export-log button (left of gear)

**Files:**
- Modify: `app/src/lib/icons/Icon.svelte` (add `file-text` icon)
- Modify: `app/src/routes/+page.svelte` (button + handler)

**Interfaces:**
- Consumes: `debugMode` store, `api.saveLog`, `flushDebugQueue` (Task 6), `@tauri-apps/plugin-dialog` `save`, `showToast`, i18n keys (Task 8).

- [ ] **Step 1: Add the icon**

In `app/src/lib/icons/Icon.svelte`, add to the `paths` map (e.g. after `"sun"`):

```typescript
    "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/>',
```

- [ ] **Step 2: Add imports + handler in `+page.svelte`**

In the `<script>`: add `debugMode` to the `$lib/store` import; and add:

```typescript
  import { save } from "@tauri-apps/plugin-dialog";
  import { flushDebugQueue } from "$lib/debug";
  import { showToast } from "$lib/toast";
```

(If `showToast` is already imported, don't duplicate.) Add the handler:

```typescript
  async function exportDebugLog() {
    try {
      await flushDebugQueue();
      const path = await save({
        defaultPath: `openenlarge-debug-${Date.now()}.txt`,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return; // user cancelled
      await api.saveLog(path);
      showToast($t("app.debug.exported"));
    } catch {
      showToast($t("app.debug.exportFailed"));
    }
  }
```

> Confirm `api` and `$t` are already imported in `+page.svelte` (they are used widely). If `Date.now()` for the filename is undesirable, any unique suffix works — this runs in the app, not a workflow script, so `Date.now()` is fine here.

- [ ] **Step 3: Add the button left of the gear**

In the header, immediately BEFORE the `.gear` button (line ~146), add:

```svelte
    {#if $debugMode}
      <button class="gear" on:click={exportDebugLog} aria-label={$t('app.debug.exportAriaLabel')}>
        <Icon name="file-text" size={18} />
      </button>
    {/if}
```

(Reusing the `.gear` button style keeps it visually consistent and positioned just left of the settings gear, since both sit after `.spacer`.)

- [ ] **Step 4: Typecheck + build the frontend**

Run: `cd app && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -15 && npm run build 2>&1 | tail -15`
Expected: no errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/icons/Icon.svelte app/src/routes/+page.svelte
git commit -m "feat(debug): export-log button left of settings gear

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Task 11: Full build + manual smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Full workspace build + tests**

Run: `cd app/src-tauri && cargo test --lib 2>&1 | tail -15 && cargo build 2>&1 | tail -5`
Run: `cd app && npx vitest run 2>&1 | tail -15`
Expected: all green.

- [ ] **Step 2: Manual GUI smoke (document results)**

Launch the app (`/run` skill or the project's dev command). Verify:
1. Settings → Debug mode → On. The export button (file-text icon) appears left of the gear.
2. Import a photo, develop it, export it.
3. Click the export button → save dialog → save `.txt`. Open it: confirm a `=== OpenEnlarge debug log ===` summary header with a per-op table (e.g. `develop_image`, `render_view`), `peak rss`, then raw `[+...] BE PERF ...`, `BE MEM ...`, and any `FE ...` lines.
4. Settings → Debug mode → Off → confirm the clear prompt. The export button disappears.
5. (Startup-timing check) With debug on, restart the app, then export: confirm `load_catalog` / early `BE INFO debug mode enabled at startup` lines are present.

- [ ] **Step 3: Final commit (if any smoke fixes were needed)**

```bash
git add -A && git commit -m "fix(debug): smoke-test corrections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0126fWjmR7KJmDGqE8eGCXPD"
```

---

## Self-Review Notes

- **Spec coverage:** capture both FE+BE (Tasks 1–4, 6) ✓; continuous file (Task 1) ✓; operation timings (Task 4 `time_op!`) ✓; memory usage (Task 2 sampler) ✓; session summary (Task 3) ✓; export `.txt` summary+raw (Tasks 4 `save_log`, 10 button) ✓; toggle in settings persisted like telemetry (Tasks 6, 9) ✓; button left of gear, visible only when on (Task 10) ✓; size cap/rotation (Task 1) ✓; crash survival via per-line flush + startup enable + panic hook (Tasks 1, 2, 4) ✓; i18n via CSV+script (Task 8) ✓; backend + frontend tests (Tasks 1–3, 6) ✓.
- **Type consistency:** `DebugLog`, `DebugLine {level,msg}`, `debug_set/debug_log_append/debug_clear/save_log`, `build_summary`, `format_mem_line`, `time_op!`, `dlog!`, FE `setDebugMode/installDebugHooks/removeDebugHooks/flushDebugQueue/enqueue/perf/perfAsync`, store `debugMode`, i18n keys — all consistent across tasks.
- **Known build-time confirmations (flagged inline, not blocking):** exact `sysinfo` process-memory API for the resolved version; the existing cache-size helper name in `cache.rs` (reuse, don't duplicate); `save` from `@tauri-apps/plugin-dialog` (plugin already a dependency).
