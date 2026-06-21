# Alpha Release Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a download-only alpha (pre-release) channel: `vX.Y.Z-alpha.N` tags build as auto-published GitHub pre-releases that mirror to R2 and surface in a website "testing builds" section, fully isolated from the stable updater + download buttons.

**Architecture:** A tag containing `-` is detected as a pre-release in `release.yml`. For pre-release tags the bundle version is derived from the tag (no version-file bump), the GitHub release is published as a pre-release, and the `publish-manifest` job writes a separate `web/releases-alpha.json` instead of the stable `latest.json` + `web/releases.json`. The download page reveals a "testing builds" block when `releases-alpha.json` exists.

**Tech Stack:** GitHub Actions (bash steps), `tauri-apps/tauri-action@v0`, Cloudflare R2 (`aws s3`), `jq`, Cloudflare Pages, vanilla JS static site (`web/`).

## Global Constraints

- Channel rule: a tag whose `github.ref_name` contains `-` is a pre-release (alpha); a plain `vX.Y.Z` is stable. Verbatim test: `[[ "$TAG" == *-* ]]`.
- Alpha builds MUST NOT write the root `latest.json` (`s3://$R2_BUCKET/latest.json`, the in-app updater endpoint) or `web/releases.json` (stable download buttons).
- Stable release behavior MUST remain byte-for-byte equivalent to today (draft, non-prerelease, latest.json + releases.json published).
- R2 mirror path stays `s3://$R2_BUCKET/<tag>/` for both channels (already tag-isolated). `DL_BASE=https://download.aako.world`, `R2_BUCKET=public-files`.
- Website strings live in `web/i18n.js` (EN + ZH); EN and ZH key counts MUST stay equal.
- Manifest JSON shape (both channels): `{ "tag": "<tag>", "assets": { "macos"?: url, "windows"?: url, "linux"?: url } }`.

---

### Task 1: Channel detection + tag-derived version in the `build` job

**Files:**
- Modify: `.github/workflows/release.yml` — "Compute Tauri build args" step (lines 73–95) and the `tauri-apps/tauri-action@v0` `with:` block (lines 105–111).

**Interfaces:**
- Produces: a job-scoped env var `IS_PRERELEASE` (`"true"`/`"false"`) set via `$GITHUB_ENV`, consumed by the `tauri-action` `with:` block in this task. (The `publish-manifest` job re-derives it independently in Task 2 — it cannot read another job's env.)

- [ ] **Step 1: Verify the detection + version-derivation logic locally**

Run this throwaway check (no file committed) to confirm the exact bash the YAML will use:

```bash
check() {
  TAG="$1"
  if [[ "$TAG" == *-* ]]; then PRE=true; VER="${TAG#v}"; else PRE=false; VER="(n/a)"; fi
  echo "$TAG -> IS_PRERELEASE=$PRE VERSION=$VER"
}
check v0.5.3
check v0.6.0-alpha.1
check v0.6.0-beta.2
```

Expected output:
```
v0.5.3 -> IS_PRERELEASE=false VERSION=(n/a)
v0.6.0-alpha.1 -> IS_PRERELEASE=true VERSION=0.6.0-alpha.1
v0.6.0-beta.2 -> IS_PRERELEASE=true VERSION=0.6.0-beta.2
```

- [ ] **Step 2: Replace the "Compute Tauri build args" step**

Replace the whole step body (lines 73–95) with:

```yaml
      - name: Compute Tauri build args
        shell: bash
        run: |
          ARGS="${{ matrix.args }}"
          TAG="${{ github.ref_name }}"
          # Channel: a tag containing "-" (e.g. v0.6.0-alpha.1) is a pre-release.
          # Pre-releases build at the tag's version WITHOUT committing a bump to the
          # four version files — derive it and pass it via --config (Tauri merges
          # multiple --config flags, so this composes with the Windows cert config).
          if [[ "$TAG" == *-* ]]; then
            echo "IS_PRERELEASE=true" >> "$GITHUB_ENV"
            VER="${TAG#v}"
            ARGS="$ARGS --config {\"version\":\"$VER\"}"
          else
            echo "IS_PRERELEASE=false" >> "$GITHUB_ENV"
          fi
          if [ -n "$WIN_CERT_THUMBPRINT" ]; then
            ARGS="$ARGS --config {\"bundle\":{\"windows\":{\"certificateThumbprint\":\"$WIN_CERT_THUMBPRINT\",\"timestampUrl\":\"http://timestamp.digicert.com\",\"digestAlgorithm\":\"sha256\"}}}"
          fi
          echo "TAURI_ARGS=$ARGS" >> "$GITHUB_ENV"
          # ultrahdr-sys applies a `no-threads` source patch via `patch`; on the
          # Windows runner that resolves to Strawberry Perl's patch.exe, which
          # crashes (assertion in patch 2.5.9). We build the normal *threaded*
          # libultrahdr, so the patch is irrelevant — skip it to dodge the broken
          # tool. macOS/Linux have a working `patch` and apply it fine.
          if [ "${{ matrix.platform }}" = "windows-latest" ]; then
            echo "ULTRAHDR_SKIP_PATCHES=1" >> "$GITHUB_ENV"
          fi
```

- [ ] **Step 3: Make the `tauri-action` release flags channel-aware**

In the `with:` block (lines 105–111), replace the two literal lines:

```yaml
          releaseDraft: true
          prerelease: false
```

with:

```yaml
          # Stable: draft + not prerelease (unchanged). Alpha: auto-published pre-release.
          releaseDraft: ${{ env.IS_PRERELEASE != 'true' }}
          prerelease: ${{ env.IS_PRERELEASE == 'true' }}
```

Leave `projectPath`, `tagName`, `releaseName`, `releaseBody`, and `args: ${{ env.TAURI_ARGS }}` unchanged.

- [ ] **Step 4: Validate the workflow YAML parses**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('release.yml: valid YAML')"
```
Expected: `release.yml: valid YAML`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): detect pre-release tags + build alpha at the tag version"
```

---

### Task 2: Channel isolation in the `publish-manifest` job

**Files:**
- Modify: `.github/workflows/release.yml` — `publish-manifest` job (lines 118–203): add a channel-detect step, split the mirror/updater step, make the manifest builder + commit channel-aware.

**Interfaces:**
- Consumes: nothing from Task 1 (separate job). Re-derives `IS_PRERELEASE` from `github.ref_name`.
- Produces: `IS_PRERELEASE` and `OUT_MANIFEST` env vars (via `$GITHUB_ENV`) used by later steps in this same job.

- [ ] **Step 1: Add a channel-detect step right after the `Download release assets` step**

Insert this step immediately after the `- name: Download release assets` step (it ends at the `ls -lh dist` line, ~line 144), before `- name: Mirror assets to R2 + publish updater manifest`:

```yaml
      - name: Detect channel
        run: |
          TAG="${{ github.ref_name }}"
          if [[ "$TAG" == *-* ]]; then
            echo "IS_PRERELEASE=true" >> "$GITHUB_ENV"
          else
            echo "IS_PRERELEASE=false" >> "$GITHUB_ENV"
          fi
```

- [ ] **Step 2: Replace the "Mirror assets to R2 + publish updater manifest" step with a mirror-only step + a stable-only updater step**

Replace the entire `- name: Mirror assets to R2 + publish updater manifest` step (lines 145–167) with these two steps:

```yaml
      - name: Mirror assets to R2
        if: env.AWS_ACCESS_KEY_ID != ''
        run: |
          set -euo pipefail
          # Mirror every asset except latest.json (uploaded after URL rewrite, stable only).
          for f in dist/*; do
            name="$(basename "$f")"
            [ "$name" = "latest.json" ] && continue
            echo "Uploading $name -> s3://$R2_BUCKET/$TAG/$name"
            aws s3 cp "$f" "s3://$R2_BUCKET/$TAG/$name" --endpoint-url "$R2_ENDPOINT"
          done

      - name: Publish stable updater manifest (latest.json)
        if: env.AWS_ACCESS_KEY_ID != '' && env.IS_PRERELEASE != 'true'
        run: |
          set -euo pipefail
          # Rewrite the updater manifest's URLs to the R2 mirror. Signatures sign
          # file content (not URLs), so they stay valid. Publish to the stable root
          # path (the app's updater endpoint) plus a versioned copy. Pre-releases
          # skip this entirely so stable users are never pushed an alpha.
          if [ -f dist/latest.json ]; then
            jq --arg base "$DL_BASE/$TAG/" \
               '.platforms |= with_entries(.value.url = ($base + (.value.url | split("/") | last)))' \
               dist/latest.json > dist/latest.rewritten.json
            aws s3 cp dist/latest.rewritten.json "s3://$R2_BUCKET/latest.json" \
              --endpoint-url "$R2_ENDPOINT" --content-type application/json
            aws s3 cp dist/latest.rewritten.json "s3://$R2_BUCKET/$TAG/latest.json" \
              --endpoint-url "$R2_ENDPOINT" --content-type application/json
          fi
```

- [ ] **Step 3: Replace the "Build web/releases.json" step with a channel-aware manifest builder**

Replace the entire `- name: Build web/releases.json (download-page manifest)` step (lines 169–186) with:

```yaml
      - name: Build download-page manifest
        run: |
          set -euo pipefail
          names=$(ls dist)
          pick() { echo "$names" | grep -iE "$1" | head -1 || true; }
          mac=$(pick '\.dmg$')
          win=$(pick '_x64_en-US\.msi$'); [ -n "$win" ] || win=$(pick '\.msi$'); [ -n "$win" ] || win=$(pick '\.exe$')
          lin=$(pick '\.AppImage$')
          url() { [ -n "$1" ] && printf '%s/%s/%s' "$DL_BASE" "$TAG" "$1" || printf ''; }
          # Stable writes the live download manifest; alpha writes a separate one so
          # the main download buttons are never repointed at a pre-release.
          if [ "$IS_PRERELEASE" = "true" ]; then OUT=web/releases-alpha.json; else OUT=web/releases.json; fi
          jq -n --arg tag "$TAG" \
                --arg mac "$(url "$mac")" --arg win "$(url "$win")" --arg lin "$(url "$lin")" '
            { tag: $tag, assets: (
                {}
                + (if $mac != "" then {macos: $mac} else {} end)
                + (if $win != "" then {windows: $win} else {} end)
                + (if $lin != "" then {linux: $lin} else {} end)
            )}' > "$OUT"
          echo "OUT_MANIFEST=$OUT" >> "$GITHUB_ENV"
          echo "Generated $OUT:"; cat "$OUT"
```

- [ ] **Step 4: Replace the "Commit releases.json" step to commit whichever manifest changed**

Replace the entire `- name: Commit releases.json` step (lines 188–198) with:

```yaml
      - name: Commit manifest
        run: |
          set -euo pipefail
          if git diff --quiet -- "$OUT_MANIFEST"; then echo "$OUT_MANIFEST unchanged"; exit 0; fi
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add "$OUT_MANIFEST"
          git commit -m "chore(web): ${{ github.ref_name }} download manifest"
          git push origin HEAD:main
```

Leave the final `- name: Deploy site with fresh manifest` step unchanged (runs for both channels, so whichever manifest changed goes live).

- [ ] **Step 5: Validate YAML + isolation logic**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('valid')"
grep -n "IS_PRERELEASE != 'true'" .github/workflows/release.yml
grep -n "releases-alpha.json\|web/releases.json" .github/workflows/release.yml
```
Expected: `valid`; the `Publish stable updater manifest` step carries `IS_PRERELEASE != 'true'`; the manifest builder references both `web/releases-alpha.json` and `web/releases.json`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): isolate alpha builds — write releases-alpha.json, never stable latest.json"
```

---

### Task 3: Website "testing builds" section

**Files:**
- Modify: `web/index.html` — add a hidden testing block inside the `#download` section (after the `.dl-card`, before `</section>` at line 475).
- Modify: `web/releases.js` — fetch `./releases-alpha.json` and reveal the block.
- Modify: `web/i18n.js` — add EN (after line 103) + ZH (after line 203) strings.

**Interfaces:**
- Consumes: `web/releases-alpha.json` (produced by Task 2) with shape `{ tag, assets: { macos?, windows?, linux? } }`.
- Produces: DOM ids `alpha-block` (the hidden wrapper), `alpha-download` (the OS link), `alpha-tag` (the version line) consumed by `releases.js` in this task.

- [ ] **Step 1: Add the testing block markup**

In `web/index.html`, insert this block immediately before the closing `</section>` of the `#download` section (line 475), after the `</div>` that closes `.dl-card` (line 474):

```html
    <div id="alpha-block" class="dl-card" style="display:none;margin-top:18px;">
      <div>
        <div class="kicker" data-i18n="dl.alpha.kicker">Testing builds</div>
        <h2 data-i18n="dl.alpha.h2">Try an alpha</h2>
        <p class="lede" data-i18n="dl.alpha.lede">Unstable pre-release builds for testing. Expect bugs.</p>
        <div class="cta-row" style="margin-top:20px;">
          <a class="btn-primary" id="alpha-download" href="https://github.com/mohaelder/openenlarge/releases" data-i18n="dl.alpha.base">↓ Download alpha</a>
        </div>
        <div class="meta" id="alpha-tag"></div>
      </div>
    </div>
```

- [ ] **Step 2: Add the EN strings**

In `web/i18n.js`, after the `"dl.os.linux": "Download for Linux",` line in the `en:` object (line 103), add:

```js
      "dl.alpha.kicker": "Testing builds",
      "dl.alpha.h2": "Try an alpha",
      "dl.alpha.lede": "Unstable pre-release builds for testing. Expect bugs.",
      "dl.alpha.base": "↓ Download alpha",
      "dl.alpha.os.macos": "↓ Download alpha for macOS",
      "dl.alpha.os.windows": "↓ Download alpha for Windows",
      "dl.alpha.os.linux": "↓ Download alpha for Linux",
```

- [ ] **Step 3: Add the matching ZH strings**

In `web/i18n.js`, after the `"dl.os.linux": "下载 Linux 版",` line in the `zh:` object (line 203), add:

```js
      "dl.alpha.kicker": "测试版",
      "dl.alpha.h2": "试用 Alpha 版",
      "dl.alpha.lede": "用于测试的不稳定预发布版本，可能存在问题。",
      "dl.alpha.base": "↓ 下载 Alpha 版",
      "dl.alpha.os.macos": "↓ 下载 macOS Alpha 版",
      "dl.alpha.os.windows": "↓ 下载 Windows Alpha 版",
      "dl.alpha.os.linux": "↓ 下载 Linux Alpha 版",
```

- [ ] **Step 4: Verify EN/ZH key counts match**

Run:
```bash
node -e "const f=require('fs').readFileSync('web/i18n.js','utf8'); const en=(f.match(/en:\s*{([\s\S]*?)\n\s*},/)[1].match(/^\s*\"/gm)||[]).length; const zh=(f.match(/zh:\s*{([\s\S]*?)\n\s*},/)[1].match(/^\s*\"/gm)||[]).length; console.log('en',en,'zh',zh); process.exit(en===zh?0:1)"
```
Expected: `en <N> zh <N>` with equal counts and exit 0. (If the regex is brittle on this file, fall back to eyeballing that both blocks gained the same 7 keys.)

- [ ] **Step 5: Wire the fetch + reveal in releases.js**

In `web/releases.js`, immediately before the final closing `})();` of the IIFE, add:

```js
  // Testing channel: reveal the alpha block only when releases-alpha.json exists
  // and carries assets. Absent/empty => the block stays hidden (default).
  fetch("./releases-alpha.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (rel) {
      var assets = rel.assets || {};
      if (!assets.macos && !assets.windows && !assets.linux) return; // nothing to show
      var block = document.getElementById("alpha-block");
      var btn = document.getElementById("alpha-download");
      var tagEl = document.getElementById("alpha-tag");
      if (block) block.style.display = "";
      if (btn) {
        btn.href = (os && assets[os]) ? assets[os] : LATEST;
        if (os) btn.textContent = t("dl.alpha.os." + os, btn.textContent);
      }
      if (tagEl && rel.tag) tagEl.textContent = rel.tag;
    })
    .catch(function () { /* no alpha published — leave the block hidden */ });
```

- [ ] **Step 6: Sanity-check the JS parses**

Run:
```bash
node --check web/releases.js && node --check web/i18n.js && echo "js ok"
```
Expected: `js ok`

- [ ] **Step 7: Local smoke test of the reveal logic**

Create a temporary `web/releases-alpha.json`, confirm `releases.js` would reveal the block (logic check — no browser needed), then remove it so it isn't committed:

```bash
printf '{"tag":"v0.6.0-alpha.1","assets":{"macos":"https://download.aako.world/v0.6.0-alpha.1/x.dmg"}}' > /tmp/ra.json
node -e "const d=require('/tmp/ra.json'); const a=d.assets||{}; console.log('reveal:', !!(a.macos||a.windows||a.linux), 'tag:', d.tag)"
```
Expected: `reveal: true tag: v0.6.0-alpha.1`. (Do NOT create `web/releases-alpha.json` — the CI generates it; committing a stub would falsely reveal the block before any alpha exists.)

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/releases.js web/i18n.js
git commit -m "feat(web): testing-builds (alpha) download section, hidden until an alpha ships"
```

---

### Task 4: "Cutting an alpha" docs note

**Files:**
- Modify: `README.md` — add a short subsection under the existing release/build docs (or near the bottom if none).

**Interfaces:**
- Consumes: nothing. Produces: nothing (docs only).

- [ ] **Step 1: Find where release docs live**

Run:
```bash
grep -ni "release\|tag\|cut a release\|vX.Y.Z" README.md | head
```
Note the most relevant heading (e.g. a "Releases" section). If none exists, the note goes at the end of the file under a new `## Releases` heading.

- [ ] **Step 2: Add the alpha note**

Append this subsection at the location found in Step 1 (use a new `## Releases` heading only if there isn't already a release section):

```markdown
### Cutting an alpha (test) build

Alpha builds are download-only pre-releases — they never touch the stable
auto-updater or the main download buttons.

1. Push a pre-release tag (no version-file bump needed — the build derives the
   version from the tag):
   ```bash
   git tag v0.6.0-alpha.1
   git push origin v0.6.0-alpha.1
   ```
2. The Release workflow builds all platforms, publishes a GitHub **pre-release**,
   mirrors installers to `https://download.aako.world/v0.6.0-alpha.1/`, and writes
   `web/releases-alpha.json` — which makes the website's **"Testing builds"**
   section appear with the new alpha.

Plain `vX.Y.Z` tags remain the stable flow (draft release, updater + main download
buttons updated). See `docs/superpowers/specs/2026-06-20-alpha-release-channel-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: how to cut an alpha (pre-release) build"
```

---

## Final acceptance (after all tasks, real run)

This is the only end-to-end test of the workflow (CI can't be run locally). Do it once the tasks are merged, when ready to ship the first alpha:

- [ ] Record the current stable artifacts to compare against:
  ```bash
  curl -s https://download.aako.world/latest.json -o /tmp/latest.before.json
  git show origin/main:web/releases.json > /tmp/releases.before.json
  ```
- [ ] Push `v0.6.0-alpha.1`; wait for the Release workflow to finish.
- [ ] Verify: a GitHub **pre-release** with installers; assets present at `https://download.aako.world/v0.6.0-alpha.1/`; `web/releases-alpha.json` committed on `main`; the live site's "Testing builds" section shows the alpha.
- [ ] Verify **isolation** — these must be UNCHANGED:
  ```bash
  curl -s https://download.aako.world/latest.json -o /tmp/latest.after.json
  diff /tmp/latest.before.json /tmp/latest.after.json && echo "latest.json UNCHANGED (good)"
  git show origin/main:web/releases.json > /tmp/releases.after.json
  diff /tmp/releases.before.json /tmp/releases.after.json && echo "releases.json UNCHANGED (good)"
  ```
- [ ] Confirm the testing block is hidden on the live site before the first alpha (i.e. `web/releases-alpha.json` 404s until the alpha build commits it).
