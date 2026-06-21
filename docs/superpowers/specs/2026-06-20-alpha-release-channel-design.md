# Alpha release channel — design

## Goal

Let people download pre-release ("alpha") builds to test, without any risk of
those builds reaching stable users. Alpha is **download-only**: testers grab an
installer from the website's testing section (or the GitHub pre-release) and
install it manually. The in-app auto-updater is unchanged and continues to serve
only stable.

## Background (current release setup)

- `.github/workflows/release.yml` fires on `v*` tags.
  - `build` job: `tauri-action` builds macOS (aarch64), Windows, Linux and
    creates a **draft**, non-prerelease GitHub release with installers + updater
    artifacts (`.sig`, `latest.json`) attached.
  - `publish-manifest` job: downloads the release assets, mirrors them to
    Cloudflare R2 at `download.aako.world/<tag>/`, **rewrites and overwrites the
    root `latest.json`** at `download.aako.world/latest.json` (the in-app updater
    endpoint), regenerates `web/releases.json` (the download page's same-origin
    manifest), commits it, and deploys the Pages site.
- The in-app updater polls `download.aako.world/latest.json` (R2 root), NOT the
  GitHub "latest" release.
- The download page (`web/index.html` + `web/releases.js`) fetches same-origin
  `./releases.json` (`{ tag, assets: { macos, windows, linux } }`) and points the
  OS-detected download buttons at the R2 URLs.

**Risk this design must prevent:** today, ANY `v*` tag — including an alpha —
would overwrite the root `latest.json` and `releases.json`, pushing the alpha to
every stable user via auto-update and the main download buttons.

## Decisions

- **Tag convention:** stable `vX.Y.Z`; alpha `vX.Y.Z-alpha.N` (e.g.
  `v0.6.0-alpha.1`). Channel detection: a tag whose name contains `-` is a
  pre-release (alpha/beta/rc), else stable. (`-beta`/`-rc` ride the same alpha
  path — only the stable-vs-prerelease split matters.)
- **No version-file bump for alpha.** The workflow derives the bundle version
  from the tag (strip leading `v`) and passes it to `tauri-action` via
  `--config {"version":"<derived>"}` for pre-release tags only. `main` stays on
  its stable version across the four version files. Stable releases keep their
  explicit 4-file bump (the `cut-release` flow), unchanged — the override is not
  applied for stable tags.
- **Alpha auto-publishes** as a GitHub **pre-release** (`prerelease: true`,
  `releaseDraft: false`). GitHub never marks a pre-release as "latest". Stable
  stays a draft (manual publish), unchanged.
- **Isolation:** alpha builds never write the root `latest.json` or
  `web/releases.json`. They write a separate `web/releases-alpha.json`.
- **In-app updater:** unchanged; alpha is download-only. An alpha tester rejoins
  stable automatically when a stable release ≥ their installed version ships.

## Changes

### 1. `release.yml` — `build` job

Compute the channel once from `github.ref_name`:

- `IS_PRERELEASE = (tag contains "-")`.
- For pre-release tags, derive `ALPHA_VERSION = tag without leading "v"` and add
  `--config {"version":"<ALPHA_VERSION>"}` to the existing `TAURI_ARGS` (merged
  with the Windows cert config that may already be appended).
- `tauri-action` inputs become channel-aware:
  - `prerelease: ${{ IS_PRERELEASE }}`
  - `releaseDraft: ${{ !IS_PRERELEASE }}` (stable draft; alpha published)

Everything else in `build` (signing, matrix, caching) is unchanged.

### 2. `release.yml` — `publish-manifest` job

Branch on `IS_PRERELEASE` (re-derived from `github.ref_name`):

- **Always:** mirror every asset (except `latest.json`) to
  `s3://$R2_BUCKET/<tag>/` — already isolated by tag.
- **Stable only** (current behavior, now guarded): rewrite `latest.json` URLs to
  the R2 mirror and upload to `s3://$R2_BUCKET/latest.json` + `<tag>/latest.json`;
  build `web/releases.json`; commit it.
- **Alpha only:** build `web/releases-alpha.json` with the same shape
  (`{ tag, assets: { macos, windows, linux } }`) from the mirrored URLs; commit
  it. Do NOT upload the root `latest.json`, the versioned `latest.json`, or
  `web/releases.json`.
- **Always:** deploy the Pages site (so whichever manifest changed goes live).

Asset-picking logic (dmg/msi/AppImage globs) is shared between the two manifest
builders.

### 3. Download page (`web/`)

- `web/index.html`: add a small "Testing builds" block (heading + one OS-detected
  link + the alpha tag), placed below the main download area. Marked hidden by
  default.
- `web/releases.js`: after wiring the stable buttons, `fetch('./releases-alpha.json')`;
  on success with a non-empty `assets`, reveal the testing block, set the link to
  the visitor's-OS alpha URL (fallback: GitHub releases page), and show the alpha
  tag. On failure/absence, leave the block hidden. Stable wiring is untouched.
- `web/i18n.js`: add EN + ZH strings for the testing block (heading, "download
  alpha for <OS>", a one-line "unstable, for testing" caveat). Keep EN/ZH key
  counts in sync.

### 4. Docs / process

- Add a short "Cutting an alpha" note (README or the release docs): push a
  `vX.Y.Z-alpha.N` tag; no version bump; the build publishes a pre-release and
  the site's testing section updates. (A dedicated `cut-alpha` skill is out of
  scope for this change — tagging is the whole flow.)

## Out of scope

- In-app alpha update channel / "receive alpha updates" toggle.
- Promoting an alpha to stable automatically (cutting stable stays the existing
  `cut-release` flow).
- Beta/RC as distinct surfaced channels (they build as pre-releases and land in
  the same testing section).

## Testing / verification

- **Dry verification of isolation (most important):** confirm in the workflow
  logic that an alpha tag path never executes the root-`latest.json` upload or
  the `web/releases.json` write. (Stable users' updater + main buttons are driven
  solely by those two artifacts.)
- After implementation, cut a real `v0.6.0-alpha.1`: verify (a) a GitHub
  pre-release with installers, (b) assets at `download.aako.world/v0.6.0-alpha.1/`,
  (c) `web/releases-alpha.json` updated and the site's testing section showing it,
  (d) root `latest.json` and `web/releases.json` **unchanged** (compare before/after).
- Confirm the website testing block stays hidden when `releases-alpha.json` is
  absent (e.g. before the first alpha).
