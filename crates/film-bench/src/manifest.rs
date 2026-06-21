use serde::Deserialize;

#[derive(Deserialize)]
pub struct Manifest {
    pub chart: String,
    pub roll: String,
    pub dir: String,
    pub frames: Vec<Frame>,
}

#[derive(Deserialize)]
pub struct Frame {
    pub file: String,
    pub role: String,
    #[serde(default)]
    pub corners: Option<[[f32; 2]; 4]>,
    #[serde(default)]
    pub n_steps: Option<usize>,
    #[serde(default)]
    pub ev_per_step: Option<f32>,
    #[serde(default)]
    pub mid_step: Option<usize>,
    #[serde(default)]
    pub drop_last: Option<usize>,
    #[serde(default)]
    pub flags: Vec<String>,
}

pub fn load(path: &str) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_manifest() {
        let json = r#"{
            "chart": "colorchecker24",
            "roll": "EKTAR 100",
            "dir": "/tmp/x",
            "frames": [
                {"file": "a.dng", "role": "d_min"},
                {"file": "b.dng", "role": "color", "corners": [[1,2],[3,4],[5,6],[7,8]]},
                {"file": "c.dng", "role": "wedge", "corners": [[0,0],[9,0],[9,1],[0,1]], "n_steps": 10, "ev_per_step": 1.0, "mid_step": 4, "flags": ["last_unreliable"]}
            ]
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.frames.len(), 3);
        assert_eq!(m.frames[1].corners.unwrap()[2], [5.0, 6.0]);
        assert_eq!(m.frames[2].n_steps, Some(10));
        assert_eq!(m.frames[0].corners, None);
    }
}
