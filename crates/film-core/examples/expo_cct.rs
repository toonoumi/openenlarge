//! Measurement harness for the "exposure shifts colour temperature" report.
//!
//! Renders the SAME neutral patch at exposure −5 / 0 / +5 with temp & tint
//! pinned (WB calibrated to neutral at EV 0, then held constant), runs the real
//! `invert_d`, and converts the output display RGB to a correlated colour
//! temperature (CCT) so we can quantify any hue drift in Kelvin.
//!
//! Run: `cargo run -p film-core --example expo_cct`

use film_core::engine::{invert_d, InversionParams};

/// sRGB EOTF (decode display value → linear).
fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear sRGB (D65) → CIE xy chromaticity.
fn rgb_to_xy(rgb: [f32; 3]) -> (f32, f32) {
    let r = srgb_to_linear(rgb[0]);
    let g = srgb_to_linear(rgb[1]);
    let b = srgb_to_linear(rgb[2]);
    let x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    let s = (x + y + z).max(1e-9);
    (x / s, y / s)
}

/// McCamy's CCT approximation from chromaticity.
fn cct(rgb: [f32; 3]) -> f32 {
    let (x, y) = rgb_to_xy(rgb);
    let n = (x - 0.3320) / (0.1858 - y);
    449.0 * n.powi(3) + 3525.0 * n.powi(2) + 6823.3 * n + 5520.33
}

const FILMIC_K: f32 = 5.0;
const FILMIC_PIVOT: f32 = 0.44;
const FILMIC_WHITE_T: f32 = 1.05;

fn filmic_s_raw(t: f32) -> f32 {
    let l = |x: f32| 1.0 / (1.0 + (-FILMIC_K * (x - FILMIC_PIVOT)).exp());
    let l0 = l(0.0);
    let lw = l(FILMIC_WHITE_T);
    (l(t) - l0) / (lw - l0)
}
fn filmic_s(t: f32) -> f32 {
    filmic_s_raw(t).clamp(0.0, 1.0)
}
fn filmic_inv(y: f32) -> f32 {
    let l = |x: f32| 1.0 / (1.0 + (-FILMIC_K * (x - FILMIC_PIVOT)).exp());
    let l0 = l(0.0);
    let lw = l(FILMIC_WHITE_T);
    let big = (y * (lw - l0) + l0).clamp(1e-6, 1.0 - 1e-6); // = l(t)
    FILMIC_PIVOT + (big / (1.0 - big)).ln() / FILMIC_K
}

/// PROPOSED fixed pixel: bake WB into t-space, then let exposure scale the
/// WB-neutralized t. Mirrors the planned engine::invert_d change.
fn invert_fixed(scan: [f32; 3], base: [f32; 3], d_max: f32, wb: [f32; 3], ev: f32) -> [f32; 3] {
    let expo_gain = 2f32.powf(0.14 * ev);
    std::array::from_fn(|c| {
        let d = (base[c] / scan[c].max(1e-9)).log10().max(0.0);
        let t = d / d_max;
        let y = filmic_s_raw(t) * wb[c]; // EV0 WB-neutralized display density (unclamped)
        filmic_s(filmic_inv(y) * expo_gain).min(1.0)
    })
}

fn main() {
    let d_max = 1.5_f32;

    // Neutral patches across the tonal range, each given a realistic per-channel
    // density imbalance (B lower than G/R → blue needs a boost, the usual film
    // case). Expressed as post-base densities `d`; the scan value that yields `d`
    // for a base `dmin` is `dmin / 10^d`.
    let base = [0.90_f32, 0.55, 0.35]; // orange C-41 mask
    let patches: [(&str, [f32; 3]); 3] = [
        ("shadow", [0.34, 0.37, 0.28]),
        ("mid", [0.62, 0.66, 0.54]),
        ("light", [0.95, 1.00, 0.84]),
    ];

    println!("d_max = {d_max}, EXPO_K = 0.14, filmic curve from engine.rs\n");

    for (name, d) in patches {
        // Scan value per channel that produces density d against the base.
        let scan: [f32; 3] = std::array::from_fn(|c| base[c] / 10f32.powf(d[c]));

        // WB calibrated to neutral at EV 0: wb_c = filmic_s(t_G) / filmic_s(t_c)
        // (a post-curve multiply, exactly how auto-WB / the gray-point picker
        // produce gains). This drives v_R = v_G = v_B at EV 0.
        let t0: [f32; 3] = std::array::from_fn(|c| d[c] / d_max);
        let fg = filmic_s(t0[1]);
        let wb: [f32; 3] = std::array::from_fn(|c| fg / filmic_s(t0[c]).max(1e-6));

        println!("patch '{name}'  d={d:?}  wb(EV0)={wb:.4?}");
        println!("   {:>5}   {:^22}  {:^22}", "", "CURRENT (invert_d)", "FIXED (invert_fixed)");
        for ev in [-5.0_f32, 0.0, 5.0] {
            let p = InversionParams {
                base,
                d_max,
                print_exposure: 2f32.powf(ev),
                wb,
                ..Default::default()
            };
            let cur = invert_d(scan, &p);
            let fix = invert_fixed(scan, base, d_max, wb, ev);
            println!(
                "   EV{ev:+.0}   CCT={:7.0}K            CCT={:7.0}K",
                cct(cur),
                cct(fix)
            );
        }
        let span = |f: &dyn Fn(f32) -> [f32; 3]| cct(f(5.0)) - cct(f(-5.0));
        let cur_span = span(&|ev| {
            invert_d(scan, &InversionParams { base, d_max, print_exposure: 2f32.powf(ev), wb, ..Default::default() })
        });
        let fix_span = span(&|ev| invert_fixed(scan, base, d_max, wb, ev));
        println!("   → CCT span EV−5..+5:  current {cur_span:+.0}K   fixed {fix_span:+.0}K\n");
    }

    // --- CPU↔GPU parity probes: print engine::invert_d outputs the JS shader mirror
    // (parity_check.mjs) must reproduce, proving the GLSL transcription matches. ---
    println!("PARITY PROBES (engine::invert_d):");
    let pb = [0.85_f32, 0.55, 0.40];
    let pwb = [1.12_f32, 1.0, 1.38];
    for &(scan, ev) in &[
        ([0.30_f32, 0.22, 0.18], -3.0_f32),
        ([0.30, 0.22, 0.18], 0.0),
        ([0.30, 0.22, 0.18], 4.0),
        ([0.05, 0.04, 0.03], 2.0),
        ([0.012, 0.012, 0.012], -2.0),
    ] {
        let p = InversionParams { base: pb, d_max, wb: pwb, print_exposure: 2f32.powf(ev), ..Default::default() };
        let o = invert_d(scan, &p);
        println!("  scan={scan:?} ev={ev:+.0}  -> [{:.6},{:.6},{:.6}]", o[0], o[1], o[2]);
    }
}
