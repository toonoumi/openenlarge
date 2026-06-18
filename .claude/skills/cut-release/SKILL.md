---
name: cut-release
description: >
  Ship a new OpenEnlarge (filmrev) desktop release end to end: bump the version
  across all four sync'd files, commit + push main, push a vX.Y.Z tag to trigger
  the Tauri build, then draft the GitHub release AND fix the in-app auto-updater
  notes. Use this whenever the user wants to "cut/ship/trigger/draft a release",
  "push and release", "tag a new version", "publish a build", or asks to write
  release notes for OpenEnlarge — even if they only mention one of those steps,
  because the steps are interdependent (a forgotten Cargo.lock bump or an
  unfixed latest.json silently ships a broken update). Project-specific to this
  repo (Tauri 2 + tauri-action, draft releases, GitHub Pages site).
---

# Cut an OpenEnlarge release

This repo ships a Tauri desktop app. A release is a `vX.Y.Z` git tag — pushing it
triggers `.github/workflows/release.yml` (tauri-action), which builds macOS
(Apple Silicon), Windows, and Linux, signs them, publishes a `latest.json` for the
in-app updater, and creates a **draft** GitHub release with all installers attached.

Your job is the human half: pick the version, bump it everywhere, push, tag, and
then make the two sets of release notes correct before the user publishes. The
auto-updater reads notes from a build artifact that defaults to a useless
placeholder — fixing that is the step people forget, so it is baked in here.

## Key facts about this repo

- **Repo:** `MohaElder/openenlarge`. Work directly on `main` (the maintainer's
  preference) — no release branch.
- **Version lives in FOUR files that must match**, or the build fails on a dirty
  lockfile or ships a mislabeled bundle:
  - `app/package.json`
  - `app/src-tauri/tauri.conf.json`
  - `app/src-tauri/Cargo.toml`
  - `app/src-tauri/Cargo.lock` (the `[[package]] name = "app"` block)
- **Trigger:** pushing a tag matching `v*`. The release is created as a **draft**
  (`releaseDraft: true`) — it is NOT public until the user clicks Publish.
- **Auto-updater endpoint:** `releases/latest/download/latest.json`, which only
  serves the latest **published, non-prerelease** release. So a draft's
  `latest.json` is safe to edit right up until publish.
- **Two different notes, two different formats** (see "Write the notes" below).
- **Commit trailer:** end commit messages with the repo's standard
  `Co-Authored-By: Claude ...` trailer (match recent commits).

## Procedure

Track these as todos so none is skipped — they're interdependent.

### 1. Decide the version

Look at what landed since the last tag:

```bash
git fetch --tags
LAST=$(git describe --tags --abbrev=0)
git log --oneline "$LAST"..HEAD
```

**Derive the scope from this command, never from memory of the current chat.**
Plenty of commits land on `main` between releases that you didn't make in this
session — features merged by the maintainer, fixes from another branch. If you
size the version and write the notes from "what we did today," you will miss them.
The `$LAST..HEAD` range is the source of truth; read every line of it, group the
commits into New / Improvements / Fixes yourself, and resolve anything ambiguous by
reading the code (e.g. `feat(tether): ...` → check `app/src/lib/tether/` and the
i18n strings to describe it accurately). A `feat(...)` you can't explain is a
feature you haven't documented.

Apply semver judgment (pre-1.0, so stay conservative):
- **patch** (`0.2.0 → 0.2.1`): bug fixes, UI polish, docs, perf — no new
  user-facing capability.
- **minor** (`0.2.x → 0.3.0`): **any** new user-facing feature in the range — new
  import formats, a new tool/panel, tethering, auto-update. If the range contains a
  `feat(...)` that adds capability, it's a minor, not a patch.

The version number is the user's call — recommend one with a one-line rationale
*grounded in the commit range* and let them confirm or override.

### 2. Bump the version everywhere

```bash
python3 .claude/skills/cut-release/scripts/bump_version.py <X.Y.Z>
```

It edits all four files in place and prints each `old -> new` so you can eyeball
it. Then commit and push:

```bash
git add app/package.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "chore(release): bump version to <X.Y.Z>

Co-Authored-By: <standard trailer>"
git push origin main
```

> Make sure any feature/fix commits for this release are already committed and
> pushed first — the tag should point at the final state.

### 3. Tag and trigger the build

Use an **annotated** tag and put the human-readable notes in the tag message — it
documents the release at the git level and is a good source for the GitHub body.

```bash
git tag -a v<X.Y.Z> -m "OpenEnlarge <X.Y.Z> — <headline>

<short, grouped notes — New / Fixes>"
git push origin v<X.Y.Z>
```

Confirm the run started, then wait for it (≈6–13 min, three platforms):

```bash
gh run list --workflow=release.yml --limit 2
gh run watch <run-id> --exit-status   # run in the background; you'll be notified
```

If it goes red, read the failing job (`gh run view <run-id> --log-failed`) and fix
forward — don't leave a half-built draft around.

### 4. Verify the build artifacts

```bash
gh release view v<X.Y.Z> --json isDraft,assets --jq '{isDraft, assets:[.assets[].name]}'
```

Expect the dmg (+ `.app.tar.gz`), Windows `.exe`/`.msi`, Linux
`.AppImage`/`.deb`/`.rpm`, each with a `.sig`, **and `latest.json`**. Missing
`.sig`/`latest.json` means updater signing secrets weren't set — flag it; auto-update
won't work but installers are still fine.

### 5. Write the notes (TWO versions — this is the important part)

**Bilingual from 0.4.1 onward — write every set of notes in English AND 简体中文.**
OpenEnlarge ships an EN/ZH UI and has a sizeable Chinese audience, so both the
GitHub body and the in-app updater notes must carry both languages. Match the app's
established 中文 terminology (e.g. 显影 = Develop, 纹理 = Texture, 鲜明度 = Presence,
裁剪 = Crop, 导出 = Export, 自动除尘 = auto-dust, 画质设置 = Quality setting) — grep
`i18n-strings.csv` when unsure. Translate, don't transliterate; keep the same
New/Improvements/Fixes grouping in each language.

- **GitHub body:** lead with the English block, then a `## 中文` heading with the full
  translation (one bilingual body; do not create a second release).
- **Updater notes:** the `<pre>` shows one string, so include both languages in it —
  the English block, a blank line, then the 中文 block (plain text, `•` bullets, no
  Markdown in either).

**a) GitHub release body — Markdown.** Rendered on the releases page. Group as
New / Fixes, lead with the headline, list downloads. Save to a temp file and apply:

```bash
gh release edit v<X.Y.Z> --title "OpenEnlarge <X.Y.Z>" --notes-file /tmp/release_body.md
```

**b) In-app updater notes — PLAIN TEXT.** This is the step that's easy to miss.
The updater modal (`app/src/lib/update/UpdatePrompt.svelte`) renders
`latest.json`'s `notes` field inside a `<pre>` — **no Markdown rendering**, so
`###`/`**` show up as literal characters. And tauri-action seeds that field with
the workflow's generic `releaseBody` ("Download the installer for your OS below"),
which reads as nonsense in an in-app updater. Rewrite it with plain text + `•`
bullets:

```bash
cat > /tmp/updater_notes.txt <<'EOF'
What's new in <X.Y.Z>

New
• ...
Fixes
• ...
EOF
.claude/skills/cut-release/scripts/fix_updater_notes.sh v<X.Y.Z> MohaElder/openenlarge /tmp/updater_notes.txt
```

The script edits only the `notes` field (signatures stay intact), deletes the old
asset by id, and re-uploads a file actually named `latest.json` — see its header
for the two `gh` traps it works around. Verify:

```bash
gh release download v<X.Y.Z> -R MohaElder/openenlarge -p latest.json -O /tmp/check.json --clobber
python3 -c "import json;print(json.load(open('/tmp/check.json'))['notes'])"
```

### 6. Hand off

The release is still a **draft**. Summarize what's done and let the user publish —
publishing is outward-facing and flips `latest.json` live, prompting every existing
user to update, so don't publish unless they explicitly ask. If they do:

```bash
gh release edit v<X.Y.Z> --draft=false
```

If the user updated `README.md` / `web/` for this release, pushing those to `main`
redeploys the GitHub Pages site automatically (`.github/workflows/pages.yml`).

## Notes on judgment

- **First release of the auto-updater era:** existing users on the prior version
  get their old update path; the polished in-app notes only matter from the *next*
  release onward. Still fix `latest.json` every time so it's right going forward.
- **i18n:** the in-app updater notes render as-is in one `<pre>`, so make them
  bilingual (EN + 中文 in the one string) per step 5. The website (`web/i18n.js`) has
  EN + ZH — if release work touched site copy, keep both in sync (EN/ZH key counts
  must match).
- Don't invent a version or publish on the user's behalf. Recommend, confirm, ship
  the draft, hand off.
