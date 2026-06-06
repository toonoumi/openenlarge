#!/usr/bin/env python3
"""Bump the OpenEnlarge app version across all four files that must stay in sync.

A Tauri release derives the bundled version from tauri.conf.json, the npm package
from package.json, and the Rust crate from Cargo.toml. Cargo.lock also pins the
`app` crate version — if it drifts, `cargo build` rewrites it and the release build
fails on a dirty lockfile. So all four move together.

Usage:
    python3 bump_version.py 0.2.1            # from repo root, or
    python3 bump_version.py 0.2.1 /path/to/repo

Prints the old -> new transition for each file so the change is auditable.
"""
import json
import re
import sys
from pathlib import Path

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def main() -> int:
    if len(sys.argv) < 2 or not SEMVER.match(sys.argv[1]):
        print("usage: bump_version.py <X.Y.Z> [repo_root]", file=sys.stderr)
        return 2
    new = sys.argv[1]
    root = Path(sys.argv[2] if len(sys.argv) > 2 else ".").resolve()

    pkg = root / "app/package.json"
    conf = root / "app/src-tauri/tauri.conf.json"
    cargo = root / "app/src-tauri/Cargo.toml"
    lock = root / "app/src-tauri/Cargo.lock"
    for f in (pkg, conf, cargo, lock):
        if not f.exists():
            print(f"missing: {f}", file=sys.stderr)
            return 1

    # JSON files: edit the top-level "version" key without reformatting the file.
    for f in (pkg, conf):
        text = f.read_text()
        m = re.search(r'"version":\s*"([^"]+)"', text)
        old = m.group(1) if m else "?"
        text = re.sub(r'("version":\s*")[^"]+(")', rf"\g<1>{new}\g<2>", text, count=1)
        f.write_text(text)
        print(f"{f.relative_to(root)}: {old} -> {new}")

    # Cargo.toml: the first `version = "..."` under [package].
    text = cargo.read_text()
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    old = m.group(1) if m else "?"
    text = re.sub(r'^(version\s*=\s*")[^"]+(")', rf"\g<1>{new}\g<2>", text, count=1, flags=re.M)
    cargo.write_text(text)
    print(f"{cargo.relative_to(root)}: {old} -> {new}")

    # Cargo.lock: the `version` line in the [[package]] block whose name == "app".
    text = lock.read_text()
    m = re.search(r'(\[\[package\]\]\nname = "app"\nversion = ")([^"]+)(")', text)
    if not m:
        print("could not find app package block in Cargo.lock", file=sys.stderr)
        return 1
    old = m.group(2)
    text = text[: m.start(2)] + new + text[m.end(2):]
    lock.write_text(text)
    print(f"{lock.relative_to(root)}: {old} -> {new}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
