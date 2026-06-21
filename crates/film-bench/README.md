# film-bench: Film Inversion Baseline Benchmark

An objective, GUI-free benchmark scoring the current film-inversion engine against the calibrated EKTAR test roll. **Measurement only** — does not change the engine.

## Quick Start

```bash
cargo run --release -p film-bench -- crates/film-bench/benchdata/ektar.roi.json /tmp/bench-ektar
```

Outputs to `<output-dir>/`:
- `metrics.json` — color ΔE and tone metrics (structured data)
- `tone_curve.csv` — per-step brightness and lightness values
- `overlay_<frame>.png` — per-frame ROI verification (color & wedge frames)

## Manifest Format

Define benchmark frames in `benchdata/<roll>.roi.json`:

```json
{
  "chart": "colorchecker24",
  "roll": "EKTAR 100",
  "dir": "path/to/frames",
  "frames": [
    {
      "file": "EKTAR_100--13.dng",
      "role": "color",
      "corners": [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
    },
    {
      "file": "EKTAR_100--07.dng",
      "role": "wedge",
      "n_steps": 14,
      "ev_per_step": 1.0,
      "mid_step": 6,
      "corners": [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
    }
  ]
}
```

**Roles:** `d_min` (film base), `d_max` (density reference), `color` (ColorChecker patch), `wedge` (step density), `resolution`, `scene`.

**Corners:** `[[TL], [TR], [BR], [BL]]` in full-resolution pixels. **TL = Dark-Skin patch** (top-left of 6×4 grid). Verify alignment via `overlay_*.png` (green windows inside patches; RED marks patch 0).

## Measurement Conventions

- **Color reference:** Canonical ColorChecker Classic 24 (sRGB-8, D65)
- **Color metric:** CIE ΔE2000 in Lab(D65)
- **Neutralized ΔE:** WB locked on 6 gray patches (isolates chroma rendering)
- **As-shipped ΔE:** Engine auto-WB applied as a `WbMode::Gain` per-channel multiply on the filmic positive (engine-exact for Gain mode; an approximation if the app ships `WbMode::Subtractive`)
- **Tone reference:** Per-roll film base from `d_min` frame via `sample_base_clearfilm` (rejects blown-lightbox surround; recovers orange mask)
- **Tone metrics:** mid-gray L*, shadow/highlight latitude (EV), monotonicity

## Baseline: EKTAR 100, Current Engine

| metric | value |
|---|---|
| color ΔE2000 neutralized (mean / max) | 27.05 / 55.57 |
| color ΔE2000 chroma-only (mean) | 30.02 |
| color ΔE2000 as-shipped (mean) | 27.86 |
| tone mid-gray L* | 42.2 |
| tone shadow / highlight latitude | −5 / +5 EV |
| tone monotonic | yes |
| per-roll base (orange mask) | [0.43, 0.55, 0.26] |

**Finding:** High color ΔE (~27) reflects the inversion engine's lack of **colorimetric (matrix/profile) correction**. The engine applies per-channel Cineon density + fixed filmic curve + WB gains, placing chromatic patches far from reference. This is the primary target for follow-up tuning.
