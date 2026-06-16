//! Local AI dust & hair removal. ALL ONNX/model/download logic lives under this
//! module — the rest of the app only sees the commands in `commands.rs`.
//!
//! Pipeline: a learned detector U-Net produces a per-pixel defect probability
//! map (`engine::detect`), `film_core::dust::prob_defect_mask` turns that into a
//! windowed `Mask`, and a learned inpainter (MI-GAN, `engine::inpaint`) fills the
//! masked pixels. Mirrors the IR removal flow but driven by the visible image.

pub mod assets;
pub mod engine;

/// Tiling for both nets (256px tiles, 16px overlap), matching the upscaler.
pub const TILE: usize = 256;
pub const TILE_PAD: usize = 16;

/// Connected-component pixel cap above which a region is treated as a real
/// feature, not a defect, and dropped from the mask. This is the base value for
/// a ~2k-long image; callers scale it with image area so the size-gate stays
/// resolution-independent.
pub const MAX_BLOB: usize = 600;
