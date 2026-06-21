use serde::Deserialize;

#[derive(Deserialize)]
pub struct WedgeManifest {
    pub dir: String,
    pub reference: String,
    pub frames: Vec<WedgeFrame>,
}

#[derive(Deserialize)]
pub struct WedgeFrame {
    pub file: String,
    pub base_ev: f32,
    pub corners: [[f32; 2]; 4],
}

#[derive(Deserialize)]
pub struct RefData {
    pub patches: Vec<RefPatch>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct RefPatch {
    pub ev: f32,
    pub value: f32,
}

pub fn load_manifest(path: &str) -> Result<WedgeManifest, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&t).map_err(|e| format!("parse {path}: {e}"))
}

pub fn load_reference(path: &str) -> Result<Vec<RefPatch>, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let d: RefData = serde_json::from_str(&t).map_err(|e| format!("parse {path}: {e}"))?;
    Ok(d.patches)
}

/// Convert a digital-SDR reference `数値` to a target CIE L*.
///
/// `数値` is the digital reference's display-referred response (it is NOT linear: it
/// spans ~10× over ~8.6 EV, far less than 2^8.6, so it is gamma-encoded, not raw DN).
/// We treat it as an sRGB-display code: normalize against the brightest patch
/// (`value_max`, the 0-EV anchor → ~display white), apply the sRGB EOTF to recover
/// luminance, then CIE L*. Black level (~512) is small vs `value_max` and folds into
/// the normalization. ONLY the absolute L* anchor depends on this assumption; the
/// curve *shape* comparison does not. (Confirm `数値`'s true encoding with the data
/// author to sharpen the anchor.)
pub fn target_lstar(value: f32, value_max: f32) -> f32 {
    let s = (value / value_max).clamp(0.0, 1.0); // sRGB-encoded display value
    let lin = if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) };
    // CIE L* from luminance Y=lin (D65), matching film_core::color::xyz_to_lab.
    let f = if lin > 0.008_856 { lin.cbrt() } else { 7.787 * lin + 16.0 / 116.0 };
    116.0 * f - 16.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wedge_manifest() {
        let j = r#"{
            "dir": "/x", "reference": "/x/ref.json",
            "frames": [
                {"file": "a.raf", "base_ev": 0.0, "corners": [[1,2],[3,4],[5,6],[7,8]]},
                {"file": "b.raf", "base_ev": 6.0, "corners": [[1,2],[3,4],[5,6],[7,8]]}
            ]
        }"#;
        let m: WedgeManifest = serde_json::from_str(j).unwrap();
        assert_eq!(m.frames.len(), 2);
        assert_eq!(m.frames[1].base_ev, 6.0);
        assert_eq!(m.frames[0].corners[2], [5.0, 6.0]);
    }

    #[test]
    fn parses_reference_and_anchors_lstar() {
        let j = r#"{"patches":[{"ev":0.0,"value":10000.0},{"ev":-3.0,"value":3000.0}]}"#;
        let d: RefData = serde_json::from_str(j).unwrap();
        assert_eq!(d.patches.len(), 2);
        // Brightest patch (value==value_max) anchors near display white → high L*.
        assert!(target_lstar(10000.0, 10000.0) > 95.0);
        // A darker patch is dimmer.
        assert!(target_lstar(3000.0, 10000.0) < target_lstar(10000.0, 10000.0));
        // Black anchors to L*0.
        assert!(target_lstar(0.0, 10000.0).abs() < 1e-3);
    }
}
