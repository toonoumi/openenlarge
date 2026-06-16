//! Anonymous, opt-in usage analytics via Aptabase.
//!
//! Privacy model: nothing is ever sent unless the user has explicitly opted in.
//! The consent flag lives here, seeded from the persisted `telemetry` pref at
//! startup (so the gate is correct before the frontend even hydrates) and flipped
//! by `set_telemetry`. Every event is gated on it server-side, so a frontend bug
//! can't leak data before consent. Aptabase events are anonymous by design — no
//! PII, no images; the plugin attaches only app version + OS.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};
use tauri_plugin_aptabase::EventTracker;

/// In-memory analytics consent gate. Defaults to off; turned on by the persisted
/// `telemetry` pref at startup and by the `set_telemetry` command.
#[derive(Default)]
pub struct TelemetryState {
    consent: AtomicBool,
}

impl TelemetryState {
    pub fn set(&self, on: bool) {
        self.consent.store(on, Ordering::Relaxed);
    }
    pub fn enabled(&self) -> bool {
        self.consent.load(Ordering::Relaxed)
    }
}

/// Update the runtime consent gate. The matching `telemetry` pref is persisted by
/// the frontend (see catalog.ts), so this only flips the in-memory flag.
#[tauri::command]
pub fn set_telemetry(state: State<TelemetryState>, enabled: bool) {
    state.set(enabled);
}

/// Emit one anonymous event — but only if the user has opted in. A no-op
/// otherwise, so callers never have to check consent themselves.
#[tauri::command]
pub fn telemetry_event(
    app: AppHandle,
    state: State<TelemetryState>,
    name: String,
    props: Option<serde_json::Value>,
) {
    if !state.enabled() {
        return;
    }
    let _ = app.track_event(&name, props);
}
