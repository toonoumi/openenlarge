//! Tethered watch-folder: watch a directory, emit an event per fully-written scan.

/// File extensions we treat as scans, lowercase, no dot. Mirrors the import
/// dialog filter in `panels/Source.svelte`.
const SCAN_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "dng", "tif", "tiff", "raf", "rw2", "nef", "arw", "cr3", "3fr", "raw",
];

/// True if `file_name` is a scan we should auto-develop: a known image extension,
/// not a hidden dotfile, not an editor/OS temp, not an XMP sidecar.
pub fn is_accepted_scan(file_name: &str) -> bool {
    // Hidden dotfiles and tilde temp files are never scans.
    if file_name.starts_with('.') || file_name.starts_with('~') {
        return false;
    }
    let lower = file_name.to_ascii_lowercase();
    // Reject common in-progress/temp suffixes that wrap a real name.
    if lower.ends_with(".tmp") || lower.ends_with(".part") || lower.ends_with(".xmp") {
        return false;
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => SCAN_EXTS.contains(&ext),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_raw_and_image_extensions() {
        assert!(is_accepted_scan("DSCF1234.RAF"));
        assert!(is_accepted_scan("IMG_0001.dng"));
        assert!(is_accepted_scan("scan.tiff"));
        assert!(is_accepted_scan("frame.JPG"));
    }

    #[test]
    fn rejects_unknown_extensions_and_no_extension() {
        assert!(!is_accepted_scan("notes.txt"));
        assert!(!is_accepted_scan("Makefile"));
        assert!(!is_accepted_scan("movie.mov"));
    }

    #[test]
    fn rejects_sidecars_hidden_and_temp_files() {
        assert!(!is_accepted_scan("DSCF1234.xmp"));
        assert!(!is_accepted_scan(".DS_Store"));
        assert!(!is_accepted_scan(".hidden.dng"));
        assert!(!is_accepted_scan("DSCF1234.dng.tmp"));
        assert!(!is_accepted_scan("~temp.dng"));
    }
}
