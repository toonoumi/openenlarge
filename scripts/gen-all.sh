#!/usr/bin/env bash
# Regenerate every localized artifact. Run from repo root before committing site changes.
set -euo pipefail
python3 scripts/gen-i18n.py
python3 scripts/gen-docs.py
python3 scripts/gen-web.py
echo "all generators ran"
