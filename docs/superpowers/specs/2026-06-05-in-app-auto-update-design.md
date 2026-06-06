# In-App Auto-Update — Design

**Date:** 2026-06-05
**Status:** Approved (pending spec review)
**Scope:** Tier 2 in-app updater for the OpenEnlarge Tauri app.

## Summary

Add an in-app auto-update feature using the official Tauri v2 updater plugin. On
launch (throttled to once per 24h) the app checks the latest published GitHub
release; if a newer version exists it shows a centered modal with the version and
release notes and three actions — **Skip this version**, **Later**, **Update**.
Update downloads, verifies, installs, and relaunches in-app. A manual **Check for
updates** entry in the Settings menu runs the same check, ignoring the skip and
throttle.

Architecture is frontend-orchestrated (Approach 1): Rust only registers the
plugin; all policy, UI, and persistence live in TypeScript/Svelte, with the pure
decision logic unit-tested under vitest.

## Goals

- Auto-check on launch, at most once per 24h.
- Centered modal: version + release notes, buttons Skip / Later / Update.
- "Skip this version" suppresses auto-prompts for that exact version only.
- In-app download → verify → install → relaunch.
- Manual "Check for updates" in Settings (bypasses skip + throttle).
- EN + ZH localization for all new strings.

## Non-Goals (YAGNI for v1)

- No periodic/background polling while the app is running (launch-only).
- No silent auto-download/install.
- No delta/differential updates.
- No markdown rendering of release notes (plain text, truncated).
- No changes to the existing draft-release publishing workflow.

## Architecture

```
launch ─▶ hydrate() ─▶ runAutoCheck() ──┐
Settings "Check for updates" ─▶ runManualCheck() ──┤
                                          ▼
        updater.ts  (wraps @tauri-apps/plugin-updater + plugin-process)
          ├─ policy.ts   (pure: throttle + skip decision)
          ├─ version.ts  (pure: semver compare)
          ├─ prefs (skipVersion, lastCheck) ── app_state / SQLite
          └─ updateState store ─▶ UpdatePrompt.svelte (modal)
```

Rust registers the plugin only. Pure logic (`version.ts`, `policy.ts`) is
unit-tested; the plugin wrapper and Svelte modal stay thin and are verified live
against the first real updater release.

## Components

### Frontend (new) — `app/src/lib/update/`

- **`version.ts`** — `compareVersions(a, b): -1 | 0 | 1`. Strips a leading `v`,
  compares dot-separated numeric segments, treats missing trailing segments as 0
  (`0.1` == `0.1.0`), and orders numerically (`0.1.10 > 0.1.9`). Pure. Tested.
- **`policy.ts`** — pure decision helpers:
  - `shouldAutoCheck(nowMs, lastCheckMs, intervalMs = 86_400_000): boolean`
  - `shouldPrompt(latest, current, skipped): boolean` →
    `compareVersions(latest, current) > 0 && latest !== skipped`
  Pure. Tested.
- **`updater.ts`** — side-effectful wrapper around the plugin:
  - `runAutoCheck()` — no-op unless under Tauri; honors throttle via prefs; stamps
    `update_last_check` at attempt start; on a newer, non-skipped version sets
    `updateState = available`. Swallows errors (console only).
  - `runManualCheck()` — ignores throttle + skip; sets `available`, `upToDate`, or
    `error`.
  - `startUpdate()` — `downloadAndInstall` with progress → `updateState =
    downloading{pct}`, then a `restartReady` state.
  - `restart()` — `relaunch()` from `@tauri-apps/plugin-process`.
  - Owns the `updateState` Svelte store:
    `idle | available{version, notes} | downloading{pct} | restartReady |
    upToDate | error{message}`. `upToDate`/`error` are only surfaced for manual
    checks.
  - Tauri detection via `isTauri()` from `@tauri-apps/api/core` so `vite dev` and
    vitest never invoke the plugin.
- **`UpdatePrompt.svelte`** — centered modal bound to `updateState`. Shows version
  + truncated release notes; a progress bar while `downloading`; buttons Skip /
  Later / Update; **Restart now** when `restartReady`. Escape / backdrop = Later.
  For manual checks also renders the `upToDate` / `error` states.

### Frontend (edits)

- **`app/src/lib/store.ts`** — add two persisted stores: `updateSkipVersion`
  (string) and `updateLastCheck` (number, ms).
- **`app/src/lib/catalog.ts`** — hydrate the two keys from `snapshot.app_state` in
  `applySnapshot` (same loop that reads `selected_folder`/`grid_zoom`); wire
  write-through in `initPersistence` via `saveAppState` (mirroring `gridZoom`).
  Keys: `update_skip_version`, `update_last_check`.
- **`app/src/lib/settings/SettingsMenu.svelte`** — add a **Check for updates** item
  → `runManualCheck()`.
- **`app/src/routes/+page.svelte`** — mount `<UpdatePrompt/>` at app root; after
  `hydrate()` call `runAutoCheck()`.
- **`app/src/lib/i18n/dict.ts`** — EN + ZH for: `update.title`,
  `update.available` (`{version}`), `update.notesLabel`, `update.update`,
  `update.later`, `update.skip`, `update.downloading`, `update.restartNow`,
  `update.upToDate`, `update.error`, `settings.checkUpdates`.

### Backend (Rust)

- **`app/src-tauri/Cargo.toml`** — add `tauri-plugin-updater = "2"` and
  `tauri-plugin-process = "2"`.
- **`app/src-tauri/src/lib.rs`** — register both plugins after the existing
  `dialog` plugin (lines 23–24), desktop-gated:
  `#[cfg(desktop)] { builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init()); }`
- **`app/src-tauri/capabilities/default.json`** — add permissions
  `updater:default` and `process:allow-restart`.
- **`app/src-tauri/tauri.conf.json`** — add:
  ```json
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/mohaelder/openenlarge/releases/latest/download/latest.json"],
      "pubkey": "<UPDATER_PUBLIC_KEY>"
    }
  }
  ```

### Dependencies (JS)

- `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` in
  `app/package.json`.

## Data Flow & Persistence

Two keys ride on the existing `app_state` table (saved via `saveAppState`,
hydrated in `applySnapshot`):

- `update_skip_version` — version string the user chose to skip.
- `update_last_check` — epoch ms of the last auto-check **attempt** (stamped at
  attempt start, so the 24h throttle holds even when offline).

**Button semantics:**

- **Skip** → persist `update_skip_version = latest`. Never auto-prompts for that
  exact version again; a later, higher version still prompts.
- **Later** → dismiss, no persistence; re-prompts on the next throttled cycle.
- **Update** → `downloadAndInstall` with progress, then **Restart now** →
  `relaunch`.
- **Manual check** → ignores skip + throttle; shows up-to-date / error states.

## Release Pipeline

One-time setup (documented in `docs/RELEASING.md`):

1. Generate an updater keypair: `npm run tauri signer generate -- -w ~/.tauri/openenlarge.key`.
2. Public key → `tauri.conf.json` `plugins.updater.pubkey`.
3. Private key + password → GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. This key is **separate** from Apple /
   Windows code-signing.

CI change in `.github/workflows/release.yml` — add to the `tauri-action` `env`:

```yaml
TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

With the signing key present and `plugins.updater` active, `tauri-action`
auto-builds and signs the update artifacts (`.app.tar.gz` / NSIS `.exe` /
AppImage) and emits `latest.json` onto the release.

**Caveats:**

1. `latest.json` at `releases/latest/download/` resolves only after the draft
   release is **published** — identical to the website's behavior, so no new
   surprise.
2. Auto-update takes effect **from the first updater-enabled release forward**.
   Users on a pre-updater build (e.g. v0.1.1) download the next version manually
   once; from there it is automatic.
3. On macOS, clean self-update requires signed + notarized builds, which the
   pipeline already produces when the `APPLE_*` secrets are present.

## Error Handling

- The plugin verifies the downloaded artifact's signature against the pubkey;
  tampered/invalid payloads throw and are treated as `error`.
- Auto-check swallows all errors (console only) — a flaky network never nags.
- Manual check surfaces a short message (`update.error`).
- Modal close / Escape / backdrop click = Later (no persistence).
- Outside Tauri (`vite dev`, tests), `isTauri()` is false → all entry points
  no-op.

## Testing

- **vitest unit tests:**
  - `version.test.ts` — ordering, `v` prefix, unequal segment counts, numeric
    (not lexical) comparison.
  - `policy.test.ts` — throttle boundaries (just under / over 24h), skip
    suppression, that a higher-than-skipped version still prompts, manual bypass.
- The plugin wrapper and modal are kept thin and validated live against the first
  real updater release (manual verification). This matches the project's
  established "unit-test the pure logic" approach.

## Files Touched

New:
- `app/src/lib/update/version.ts` (+ `version.test.ts`)
- `app/src/lib/update/policy.ts` (+ `policy.test.ts`)
- `app/src/lib/update/updater.ts`
- `app/src/lib/update/UpdatePrompt.svelte`

Edited:
- `app/src/lib/store.ts`
- `app/src/lib/catalog.ts`
- `app/src/lib/settings/SettingsMenu.svelte`
- `app/src/routes/+page.svelte`
- `app/src/lib/i18n/dict.ts`
- `app/package.json`
- `app/src-tauri/Cargo.toml`
- `app/src-tauri/src/lib.rs`
- `app/src-tauri/capabilities/default.json`
- `app/src-tauri/tauri.conf.json`
- `.github/workflows/release.yml`
- `docs/RELEASING.md`
