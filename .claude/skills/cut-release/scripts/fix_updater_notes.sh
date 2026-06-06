#!/usr/bin/env bash
# Replace the in-app updater notes on a release's latest.json asset.
#
# Why this script exists: tauri-action bakes the workflow's generic `releaseBody`
# into latest.json's `notes` field at BUILD time, so the auto-updater modal shows
# "Download the installer for your OS below" — nonsense inside an in-app updater.
# We rewrite just the `notes` field, leaving every per-platform signature intact.
#
# Two traps this script handles for you:
#   1. `gh release upload` names the asset after the LOCAL filename. The file must
#      literally be named latest.json, or you create a stray `whatever.json` asset
#      and the real latest.json is untouched. We work in a temp dir named latest.json.
#   2. `gh release upload --clobber` is unreliable on draft releases. We delete the
#      old asset by id via the API first, then upload.
#
# The notes file should be PLAIN TEXT (the modal renders it in a <pre>, no Markdown).
#
# Usage: fix_updater_notes.sh <tag> <repo> <plain-text-notes-file>
#   e.g. fix_updater_notes.sh v0.2.1 MohaElder/openenlarge /tmp/updater_notes.txt
set -euo pipefail

TAG="${1:?tag required, e.g. v0.2.1}"
REPO="${2:?repo required, e.g. MohaElder/openenlarge}"
NOTES_FILE="${3:?plain-text notes file required}"

[ -f "$NOTES_FILE" ] || { echo "notes file not found: $NOTES_FILE" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

gh release download "$TAG" -R "$REPO" -p latest.json -O "$TMP/latest.json" --clobber

python3 - "$TMP/latest.json" "$NOTES_FILE" <<'PY'
import json, sys
path, notes = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d["notes"] = open(notes, encoding="utf-8").read().rstrip("\n")
json.dump(d, open(path, "w"), indent=2, ensure_ascii=False)
print("version:", d.get("version"))
print("platforms intact:", list(d.get("platforms", {}).keys()))
PY

ASSET_ID="$(gh api "repos/$REPO/releases" \
  --jq ".[] | select(.tag_name==\"$TAG\") | .assets[] | select(.name==\"latest.json\") | .id")"
if [ -n "$ASSET_ID" ]; then
  gh api -X DELETE "repos/$REPO/releases/assets/$ASSET_ID"
  echo "deleted old latest.json asset ($ASSET_ID)"
fi

gh release upload "$TAG" "$TMP/latest.json" -R "$REPO"
echo "✅ latest.json notes updated on $TAG"
