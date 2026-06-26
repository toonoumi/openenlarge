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

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.0.path
    }

    #[allow(dead_code)]
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
}
