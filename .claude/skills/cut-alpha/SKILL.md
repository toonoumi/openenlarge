---
name: cut-alpha
description: >
  Cut an OpenEnlarge (filmrev) ALPHA / pre-release (testing) build: push a
  vX.Y.Z-alpha.N tag (no version-file bump) to trigger an auto-published GitHub
  pre-release that mirrors to R2 and appears in the website's "Testing builds"
  section — fully isolated from stable. Use this whenever the user wants to "cut/
  ship/trigger an alpha", "make a test build", "push a pre-release", "let people
  test", "beta/rc build", or tag a vX.Y.Z-alpha/-beta/-rc version. This is the
  PRE-RELEASE counterpart to cut-release: for a stable vX.Y.Z release use
  cut-release instead. Project-specific to this repo (Tauri 2 + tauri-action,
  Cloudflare R2 + Pages). The big risk it guards: a mistagged build clobbering
  the stable auto-updater, so verify isolation every time.
---

# Cut an OpenEnlarge alpha (pre-release) build

Alpha builds are **download-only pre-releases** for testers. They auto-publish as
GitHub pre-releases, mirror installers to Cloudflare R2, and surface in the
website's "Testing builds" section — and they **never** touch the stable in-app
auto-updater or the main download buttons. The whole feature exists to keep stable
users safe, so the one thing you must always confirm is that isolation held.

The design + plan live at:
- `docs/superpowers/specs/2026-06-20-alpha-release-channel-design.md`
- `docs/superpowers/plans/2026-06-20-alpha-release-channel.md`

## How it differs from a stable release (cut-release)

| | Stable (`cut-release`) | Alpha (this skill) |
|---|---|---|
| Tag | `vX.Y.Z` | `vX.Y.Z-alpha.N` (any `-` suffix) |
| Version bump in the 4 files | **Required** | **None** — the workflow derives the bundle version from the tag |
| GitHub release | draft (you publish) | auto-published **pre-release** |
| Stable `latest.json` (updater) | rewritten + published | **never written** |
| `web/releases.json` (main buttons) | regenerated + committed | **never written** |
| Download manifest | `web/releases.json` | `web/releases-alpha.json` |

Channel detection in `.github/workflows/release.yml` is purely the tag shape:
`[[ "$TAG" == *-* ]]` → pre-release. `-beta.N` / `-rc.N` ride the same alpha path.

## Key facts about this repo

- **Repo:** `MohaElder/openenlarge`. Work directly on `main`.
- **No version-file edits for an alpha.** Do NOT bump `app/package.json`,
  `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`. The build passes
  `--config {"version":"<tag minus v>"}` to tauri-action, so the bundle/updater
  version matches the tag without committing an alpha version to `main`.
- **Trigger:** pushing the `vX.Y.Z-alpha.N` tag. The release publishes itself.
- **Download base:** `https://download.aako.world/<tag>/`.
- **The first alpha** also commits `web/releases-alpha.json` to `main` (the
  workflow does this) which makes the site's "Testing builds" section appear; it
  stays hidden until then.

## Procedure

Track these as todos.

### 1. Decide the alpha version

Alpha tags are `vX.Y.Z-alpha.N` where `vX.Y.Z` is the stable version this alpha is
working toward, and `N` increments per alpha of that version:

- First alpha for the next minor: `v0.6.0-alpha.1`.
- Next iteration: `v0.6.0-alpha.2`.
- `-beta.N` / `-rc.N` are valid too (same channel) when you want to signal maturity.

Look at what's on `main` since the last stable tag to pick the target version
(`git describe --tags --abbrev=0` for the last stable; read `LAST..HEAD`). The
version number is the user's call — recommend one with a one-line rationale and
let them confirm.

### 2. Make sure the code is on main first

The tag points at a commit, so everything you want testers to get must already be
committed and pushed to `main`:

```bash
git push origin main      # if there are unpushed commits
git log --oneline -1      # confirm HEAD is what you want to tag
```

No version bump, no extra commit — go straight to tagging.

### 3. Tag and push (this is the whole release)

Annotated tag, with a short human-readable note in the message:

```bash
git tag -a vX.Y.Z-alpha.N -m "OpenEnlarge X.Y.Z-alpha.N — <one-line headline>

<short bullets: what testers should look at>"
git push origin vX.Y.Z-alpha.N
```

Confirm the run started, then wait for it (≈6–13 min, three platforms):

```bash
gh run list --workflow=release.yml --limit 2
gh run watch <run-id> --exit-status   # run in the background; you'll be notified
```

If it goes red, read the failing job (`gh run view <run-id> --log-failed`) and fix
forward.

### 4. Verify the build + the pre-release

```bash
gh release view vX.Y.Z-alpha.N --json isDraft,isPrerelease,assets \
  --jq '{isPrerelease, isDraft, assets:[.assets[].name]}'
```

Expect `isPrerelease: true`, `isDraft: false`, and the full asset set (dmg +
`.app.tar.gz`, Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`/`.rpm`, each with a
`.sig`). A missing `.sig` means updater-signing secrets weren't set — fine for a
download-only alpha, but flag it.

Confirm the mirror + the site manifest:

```bash
curl -sI "https://download.aako.world/vX.Y.Z-alpha.N/" >/dev/null && echo "R2 path reachable"
git -c core.pager=cat show origin/main:web/releases-alpha.json   # tag + alpha asset URLs
```

The website's "Testing builds" section should now show the alpha (the page reads
`web/releases-alpha.json`).

### 5. Verify isolation (the important part — do this every time)

An alpha must not have moved stable. Capture before/after, or just confirm the
stable artifacts still point at the last STABLE version:

```bash
# Updater endpoint — must still be the latest STABLE version, NOT the alpha:
curl -s https://download.aako.world/latest.json | python3 -c "import json,sys; print('updater version:', json.load(sys.stdin)['version'])"
# Main download manifest — must still be the last stable tag:
git -c core.pager=cat show origin/main:web/releases.json | python3 -c "import json,sys; print('download page tag:', json.load(sys.stdin)['tag'])"
```

Both must report the **stable** version, never `…-alpha.N`. If either shows the
alpha, stop — the isolation broke (check that the `Publish stable updater
manifest` step's `if: … env.IS_PRERELEASE != 'true'` guard and the manifest
builder's channel branch are intact in `release.yml`).

### 6. Hand off

Alpha is published and downloadable immediately. Share the testing link
(`https://openenlarge.io/#download` testing section, or the GitHub pre-release).
Optionally edit the GitHub pre-release body with what to test — the auto body is
generic. There are **no** in-app updater notes to fix (alpha is download-only; the
updater serves only stable).

## Notes on judgment

- **No `latest.json` notes step here.** Unlike `cut-release`, the in-app updater is
  not involved — don't waste time rewriting `latest.json`; an alpha never publishes
  one.
- **Promoting an alpha to stable** is a separate, normal `cut-release`: bump the
  four files to `vX.Y.Z`, tag `vX.Y.Z`. The alpha tag/artifacts can stay as-is.
- If `web/releases-alpha.json` ever needs clearing (e.g. retiring the testing
  section), remove it from `main` and redeploy Pages — the section hides itself
  when the file is absent.
