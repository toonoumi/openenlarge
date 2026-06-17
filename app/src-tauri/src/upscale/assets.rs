//! Download + integrity-check the ONNX Runtime native library and the model file.
//! Assets live under <app_data>/upscaler/ and are fetched on first use.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// One downloadable asset (the runtime lib or the model).
pub struct Asset {
    /// File name as stored on disk under the upscaler dir.
    pub file_name: &'static str,
    /// Absolute download URL (a GitHub release asset).
    pub url: &'static str,
    /// Lowercase hex SHA-256 of the file's bytes.
    pub sha256: &'static str,
    /// Expected size in bytes (for the progress total before Content-Length).
    pub size: u64,
}

// ============================================================================
// RELEASE CONFIG — hosted as GitHub release assets on the `upscaler-assets-v1`
// tag of MohaElder/openenlarge (public repo, so the unauthenticated download
// path works). The macOS dylib is the ONNX Runtime 1.26.0 osx-arm64 build
// RE-SIGNED with "Developer ID Application: Aako, Inc (N7BMGT3KJY)" + hardened
// runtime, so it passes library validation when dlopen'd by the same-team app.
// CoreML accelerates macOS. The hosted Windows `onnxruntime.dll` is actually a
// DirectML build (imports dxgi.dll, contains DmlExecutionProvider) — NOT the
// stock CPU build once assumed — so its DirectML EP does not fall back to CPU and
// crashes on our models; we therefore run CPU on Windows by not requesting it
// (see upscale/autodust `make_session`). Linux is the stock CPU build. Bump the
// tag + these values only when the runtime/model changes, NOT on every release.
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

const MODEL: Asset = Asset {
    file_name: "realesr-general-x4v3.onnx",
    url: "https://github.com/MohaElder/openenlarge/releases/download/upscaler-assets-v1/realesr-general-x4v3.onnx",
    sha256: "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4",
    size: 4_871_181,
};

/// All assets required on the current platform (runtime first, then model).
pub fn required() -> [&'static Asset; 2] {
    [&RUNTIME, &MODEL]
}

/// Total download size across required assets (for the gate's "~NN MB" label).
pub fn total_download_bytes() -> u64 {
    required().iter().map(|a| a.size).sum()
}

/// The upscaler asset directory: <app_data>/upscaler/.
pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("upscaler")
}

/// Absolute on-disk path to the runtime library (for ORT_DYLIB_PATH).
pub fn runtime_path(app_data: &Path) -> PathBuf {
    dir(app_data).join(RUNTIME.file_name)
}

/// Absolute on-disk path to the model file.
pub fn model_path(app_data: &Path) -> PathBuf {
    dir(app_data).join(MODEL.file_name)
}

/// Lowercase hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// True when every required asset exists on disk with a matching checksum.
pub fn installed(app_data: &Path) -> bool {
    required().iter().all(|a| {
        let p = dir(app_data).join(a.file_name);
        match std::fs::read(&p) {
            Ok(bytes) => sha256_hex(&bytes) == a.sha256,
            Err(_) => false,
        }
    })
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
        download_bytes: total_download_bytes(),
    }
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
        let tmp = std::env::temp_dir().join("oe_upscale_test_missing");
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(!installed(&tmp));
    }

    #[test]
    fn required_lists_runtime_then_model() {
        let r = required();
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].file_name, "realesr-general-x4v3.onnx");
    }
}

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// Progress payload emitted on `upscale://download-progress`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    pub total: u64,
}

/// Download + verify all required assets into the upscaler dir, emitting
/// cumulative progress. Each asset is SHA-256-verified in memory BEFORE any file
/// is written, so a mismatch installs nothing (no `.part`, no half-installed state)
/// and returns an error.
pub async fn download(app: &AppHandle, app_data: &Path) -> Result<(), String> {
    let assets = required();
    let total: u64 = assets.iter().map(|a| a.size).sum();
    let dir = dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create upscaler dir: {e}"))?;
    let client = reqwest::Client::new();
    let mut received: u64 = 0;

    for a in assets {
        let resp = client
            .get(a.url)
            .send()
            .await
            .map_err(|e| format!("download {}: {e}", a.file_name))?;
        if !resp.status().is_success() {
            return Err(format!("download {}: HTTP {}", a.file_name, resp.status()));
        }
        let tmp = dir.join(format!("{}.part", a.file_name));
        let mut buf: Vec<u8> = Vec::with_capacity(a.size as usize);
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("read {}: {e}", a.file_name))?;
            buf.extend_from_slice(&chunk);
            received += chunk.len() as u64;
            let _ = app.emit("upscale://download-progress", DownloadProgress { received, total });
        }
        let got = sha256_hex(&buf);
        if got != a.sha256 {
            return Err(format!("checksum mismatch for {} (got {got})", a.file_name));
        }
        std::fs::write(&tmp, &buf).map_err(|e| format!("write {}: {e}", a.file_name))?;
        std::fs::rename(&tmp, dir.join(a.file_name))
            .map_err(|e| format!("install {}: {e}", a.file_name))?;
    }
    Ok(())
}
