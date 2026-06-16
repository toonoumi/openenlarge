//! Download + integrity-check the two ONNX models for AI dust removal.
//! Assets live under <app_data>/autodust/. The ONNX Runtime native library is
//! SHARED with the upscaler: it is stored at `upscale::assets::runtime_path` and
//! only fetched here if the upscaler hasn't already installed it.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// One downloadable asset (a model file or the shared runtime).
pub struct Asset {
    /// File name as stored on disk.
    pub file_name: &'static str,
    /// Absolute download URL (a GitHub release asset).
    pub url: &'static str,
    /// Lowercase hex SHA-256 of the file's bytes.
    pub sha256: &'static str,
    /// Expected size in bytes (for the progress total before Content-Length).
    pub size: u64,
}

// ============================================================================
// RELEASE CONFIG — MI-GAN + runtime are hosted and real. The RUNTIME asset is
// the SAME ONNX Runtime dylib as the upscaler (upscaler-assets-v1 tag), reused
// here so a runtime installed by either feature satisfies both. MI-GAN is the
// `migan_pipeline_v2.onnx` inpainting pipeline (autodust-assets-v1 tag).
// The DETECTOR is the BOPBTL scratch/dust U-Net (leonelhs/zeroscratches, MIT)
// converted to ONNX and hosted on autodust-assets-v1. All three assets are real.
// ============================================================================
#[cfg(target_os = "macos")]
const RUNTIME: Asset = Asset {
    file_name: "libonnxruntime.dylib",
    url: "https://github.com/MohaElder/openenlarge/releases/download/upscaler-assets-v1/libonnxruntime.dylib",
    sha256: "ba6ff4015f593fa87682b0e7d36164c1f7fa05148b7dff442efb34e13a60bf1a",
    size: 37_078_528,
};
#[cfg(target_os = "windows")]
const RUNTIME: Asset = Asset {
    file_name: "onnxruntime.dll",
    url: "https://github.com/MohaElder/openenlarge/releases/download/upscaler-assets-v1/onnxruntime.dll",
    sha256: "b2ba7ca16e0e4fe71ad5148744ab885a2f5809e52a0c3de4d9ba3853a03977f9",
    size: 14_897_976,
};
#[cfg(target_os = "linux")]
const RUNTIME: Asset = Asset {
    file_name: "libonnxruntime.so",
    url: "https://github.com/MohaElder/openenlarge/releases/download/upscaler-assets-v1/libonnxruntime.so",
    sha256: "5bd5bedf736fc501692435d0ec4f6e8b2bdf48cd30af8e6d00d61b3ddc9a7ab8",
    size: 23_023_576,
};

/// Learned defect detector — BOPBTL scratch/dust U-Net exported to ONNX from
/// leonelhs/zeroscratches (Microsoft BOPBTL, MIT). Input: grayscale [1,1,h,w]
/// normalized to [-1,1]; output `logits` [1,1,h,w] (apply sigmoid).
const DETECTOR: Asset = Asset {
    file_name: "detector.onnx",
    url: "https://github.com/MohaElder/openenlarge/releases/download/autodust-assets-v1/detector.onnx",
    sha256: "61e4a93d4e94b4fc6212e2e9b785fa12b5cbc9654724b02aaf8b212075bb729f",
    size: 150_747_327,
};

/// Learned inpainter — MI-GAN `migan_pipeline_v2.onnx` (uint8 image+mask in →
/// uint8 RGB out). From huggingface.co/andraniksargsyan/migan (MIT).
const MIGAN: Asset = Asset {
    file_name: "migan.onnx",
    url: "https://github.com/MohaElder/openenlarge/releases/download/autodust-assets-v1/migan_pipeline_v2.onnx",
    sha256: "6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b",
    size: 28_079_181,
};

/// The two model assets required by this module (runtime is handled separately
/// because it is shared with the upscaler).
pub fn models() -> [&'static Asset; 2] {
    [&DETECTOR, &MIGAN]
}

/// The autodust asset directory: <app_data>/autodust/.
pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("autodust")
}

/// Absolute on-disk path to the detector model.
pub fn detector_path(app_data: &Path) -> PathBuf {
    dir(app_data).join(DETECTOR.file_name)
}

/// Absolute on-disk path to the MI-GAN model.
pub fn migan_path(app_data: &Path) -> PathBuf {
    dir(app_data).join(MIGAN.file_name)
}

/// Lowercase hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// True when a file exists on disk with a matching checksum.
fn file_ok(path: &Path, sha256: &str) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => sha256_hex(&bytes) == sha256,
        Err(_) => false,
    }
}

/// The shared runtime is considered present if the file exists at the upscaler's
/// runtime path. (Checksum is verified on download; here we only require
/// presence so a runtime installed by the upscaler counts.)
fn runtime_present(app_data: &Path) -> bool {
    crate::upscale::assets::runtime_path(app_data).exists()
}

/// True when both models verify AND the shared runtime is present.
pub fn installed(app_data: &Path) -> bool {
    runtime_present(app_data)
        && models()
            .iter()
            .all(|a| file_ok(&dir(app_data).join(a.file_name), a.sha256))
}

/// Bytes still needing download given what is already installed (for the gate's
/// "~NN MB" label): both models if missing/mismatched, plus the runtime if the
/// upscaler hasn't installed it.
pub fn total_download_bytes(app_data: &Path) -> u64 {
    let mut total = 0;
    if !runtime_present(app_data) {
        total += RUNTIME.size;
    }
    for a in models() {
        if !file_ok(&dir(app_data).join(a.file_name), a.sha256) {
            total += a.size;
        }
    }
    total
}

/// Status payload for the frontend gate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub download_bytes: u64,
}

pub fn status(app_data: &Path) -> Status {
    Status {
        installed: installed(app_data),
        download_bytes: total_download_bytes(app_data),
    }
}

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// Progress payload emitted on `autodust://download-progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// Download + verify the two models (into the autodust dir) and, if missing, the
/// shared runtime (into the upscaler dir). Each asset is SHA-256-verified in
/// memory BEFORE any file is written, so a mismatch installs nothing and errors.
pub async fn download(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    // Build the work list: (asset, destination path). Skip already-valid files.
    let mut jobs: Vec<(&Asset, PathBuf)> = Vec::new();
    if !runtime_present(app_data) {
        jobs.push((&RUNTIME, crate::upscale::assets::runtime_path(app_data)));
    }
    for a in models() {
        let dest = dir(app_data).join(a.file_name);
        if !file_ok(&dest, a.sha256) {
            jobs.push((a, dest));
        }
    }
    let total: u64 = jobs.iter().map(|(a, _)| a.size).sum();
    std::fs::create_dir_all(dir(app_data)).map_err(|e| format!("create autodust dir: {e}"))?;
    std::fs::create_dir_all(crate::upscale::assets::dir(app_data))
        .map_err(|e| format!("create upscaler dir: {e}"))?;
    let client = reqwest::Client::new();
    let mut received: u64 = 0;

    for (a, dest) in jobs {
        let resp = client
            .get(a.url)
            .send()
            .await
            .map_err(|e| format!("download {}: {e}", a.file_name))?;
        if !resp.status().is_success() {
            return Err(format!("download {}: HTTP {}", a.file_name, resp.status()));
        }
        let mut buf: Vec<u8> = Vec::with_capacity(a.size as usize);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read {}: {e}", a.file_name))?;
            buf.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            let _ = app.emit("autodust://download-progress", DownloadProgress { received, total });
        }
        let got = sha256_hex(&buf);
        if got != a.sha256 {
            return Err(format!("checksum mismatch for {} (got {got})", a.file_name));
        }
        let tmp = dest.with_extension("part");
        std::fs::write(&tmp, &buf).map_err(|e| format!("write {}: {e}", a.file_name))?;
        std::fs::rename(&tmp, &dest).map_err(|e| format!("install {}: {e}", a.file_name))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn installed_false_when_missing() {
        let tmp = std::env::temp_dir().join("oe_autodust_test_missing");
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(!installed(&tmp));
    }

    #[test]
    fn models_lists_detector_then_migan() {
        let m = models();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].file_name, "detector.onnx");
        assert_eq!(m[1].file_name, "migan.onnx");
    }
}
