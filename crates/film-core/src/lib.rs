pub mod bench;
pub mod calibrate;
pub mod chart;
pub mod classify;
pub mod color;
pub mod colorchecker;
pub mod curve;
pub mod decode;
pub mod dust;
pub mod engine;
pub mod export;
pub mod finish;
pub mod image;
pub mod tone;
pub mod wb;

pub use image::Image;
pub use engine::WbMode;
pub use engine::ToneMode;

/// Render-engine version: bump whenever the inversion/finish math that bakes a
/// cached display thumbnail changes (e.g. the filmic display curve). The catalog
/// stamps the version it last rendered thumbnails with; on load, a mismatch
/// triggers a background regeneration so the contact-sheet / grid / filmstrip
/// thumbnails stop showing the old look. See `commands.rs::load_catalog`.
///
/// History: 1 = filmic display S-curve + auto-WB-seeded develop-time thumbnails
/// (2026-06-20), replacing the pre-filmic paper encode + neutral-WB thumbnails.
pub const ENGINE_VERSION: u32 = 1;
