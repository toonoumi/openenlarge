# Roadmap

Where OpenEnlarge is headed. This is a living document — priorities shift as we learn,
and dates are intentionally absent. For anything concrete in flight, see the
[open issues](https://github.com/mohaelder/openenlarge/issues) and
[milestones](https://github.com/mohaelder/openenlarge/milestones).

Have an idea or a vote? [Open an issue](https://github.com/mohaelder/openenlarge/issues/new)
— what you ask for shapes what gets built next.

## Next

- **RGB narrowband light-source support** — clean orange-mask removal (去色罩) for camera scans
  lit by narrowband RGB LEDs, with per-vendor wavelength presets. Light source becomes its own
  axis (separate from film stock); the correction is data-driven and validated across real rolls.
  See the [design spec](docs/superpowers/specs/2026-06-20-rgb-narrowband-light-source-design.md);
  implementation is gated on sample scans from light-source vendors.
- **Improve HDR** — graduate HDR out of *experimental*: let the develop sliders edit *into* the
  HDR headroom (not just toggle it on), widen export beyond gain-map JPEG, and verify the preview
  across more displays and platforms.

## Later

Ideas on the table, not yet scheduled. Tell us which matter to you:

- Broader HDR export formats (beyond gain-map JPEG)
- More scanner / camera-scan workflows

## Shipped

A sampling of what's already landed — see [Releases](https://github.com/mohaelder/openenlarge/releases)
for the full history.

- Cineon density inversion with per-roll film-base calibration
- Import Roll — develop a whole folder as one roll sharing a single film-base calibration and
  density range, with live roll-wide contact-sheet edits and a manual base recalibrate tool
- Automatic negative/positive detection and crop-aware analysis
- Tethered shooting (watch-folder auto-import + develop)
- Tone Matching, AI Enhance, local 4K/8K upscaling
- AI dust & hair removal (auto detection + MI-GAN inpainting)
- Batch export to 16-bit TIFF / PNG / JPEG
- Experimental HDR preview & gain-map JPEG export
- In-app auto-updates
