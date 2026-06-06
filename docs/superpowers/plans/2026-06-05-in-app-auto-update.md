# In-App Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a launch-throttled in-app update check that shows a centered Skip/Later/Update modal and self-installs via the Tauri v2 updater, plus a manual "Check for updates" in Settings.

**Architecture:** Frontend-orchestrated. Rust only registers `tauri-plugin-updater` + `tauri-plugin-process`. Pure decision logic (`version.ts`, `policy.ts`) is unit-tested; a thin `updater.ts` wraps the plugin and drives an `updateState` store rendered by `UpdatePrompt.svelte`. Skip-version and last-check persist on the existing `app_state` table.

**Tech Stack:** Tauri v2, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, SvelteKit, vitest.

**Reference spec:** `docs/superpowers/specs/2026-06-05-in-app-auto-update-design.md`

---

## File Structure

New:
- `app/src/lib/update/version.ts` — pure semver compare.
- `app/src/lib/update/version.test.ts`
- `app/src/lib/update/policy.ts` — pure throttle + skip decisions.
- `app/src/lib/update/policy.test.ts`
- `app/src/lib/update/updater.ts` — plugin wrapper + `updateState` store.
- `app/src/lib/update/UpdatePrompt.svelte` — modal UI.

Modified:
- `app/src/lib/store.ts` — two persisted stores.
- `app/src/lib/catalog.ts` — hydrate + write-through the two keys.
- `app/src/lib/settings/SettingsMenu.svelte` — "Check for updates".
- `app/src/routes/+page.svelte` — mount modal + trigger auto-check.
- `app/src/lib/i18n/dict.ts` — EN + ZH strings.
- `app/package.json` — two JS deps.
- `app/src-tauri/Cargo.toml` — two Rust deps.
- `app/src-tauri/src/lib.rs` — register two plugins.
- `app/src-tauri/capabilities/default.json` — two permissions.
- `app/src-tauri/tauri.conf.json` — updater config + artifacts (Task 8).
- `.github/workflows/release.yml` — signing env (Task 8).
- `docs/RELEASING.md` — keygen + secrets steps (Task 8).

---

## Task 1: Version comparison (pure)

**Files:**
- Create: `app/src/lib/update/version.ts`
- Test: `app/src/lib/update/version.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/update/version.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compareVersions } from "./version";

describe("compareVersions", () => {
  it("orders newer above older", () => {
    expect(compareVersions("0.1.2", "0.1.1")).toBe(1);
    expect(compareVersions("0.1.1", "0.1.2")).toBe(-1);
  });
  it("treats equal versions as 0", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });
  it("strips a leading v", () => {
    expect(compareVersions("v0.1.2", "0.1.2")).toBe(0);
    expect(compareVersions("v0.2.0", "v0.1.9")).toBe(1);
  });
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
  });
  it("pads missing trailing segments with 0", () => {
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
    expect(compareVersions("1", "0.9.9")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/update/version.test.ts`
Expected: FAIL — cannot find module `./version`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/update/version.ts`:

```ts
/** Compare dot-separated numeric versions. Returns -1, 0, or 1.
 * Strips a leading "v"; missing trailing segments count as 0 (0.1 === 0.1.0);
 * segments compare numerically (0.1.10 > 0.1.9). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

function parse(v: string): number[] {
  return v.replace(/^v/i, "").split(".").map((s) => parseInt(s, 10) || 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/update/version.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/update/version.ts app/src/lib/update/version.test.ts
git commit -m "feat(update): numeric version comparison helper"
```

---

## Task 2: Update policy (pure)

**Files:**
- Create: `app/src/lib/update/policy.ts`
- Test: `app/src/lib/update/policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/update/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldAutoCheck, shouldPrompt, DAY_MS } from "./policy";

describe("shouldAutoCheck", () => {
  it("allows the first check (lastCheck 0)", () => {
    expect(shouldAutoCheck(DAY_MS, 0)).toBe(true);
  });
  it("blocks within the interval", () => {
    expect(shouldAutoCheck(DAY_MS - 1, 0)).toBe(false);
    expect(shouldAutoCheck(1000, 1000)).toBe(false);
  });
  it("allows exactly at the interval boundary", () => {
    expect(shouldAutoCheck(2 * DAY_MS, DAY_MS)).toBe(true);
  });
});

describe("shouldPrompt", () => {
  it("prompts for a newer, non-skipped version", () => {
    expect(shouldPrompt("0.1.2", "0.1.1", "")).toBe(true);
  });
  it("suppresses the exact skipped version", () => {
    expect(shouldPrompt("0.1.2", "0.1.1", "0.1.2")).toBe(false);
  });
  it("still prompts for a version newer than the skipped one", () => {
    expect(shouldPrompt("0.1.3", "0.1.1", "0.1.2")).toBe(true);
  });
  it("does not prompt when not newer than current", () => {
    expect(shouldPrompt("0.1.1", "0.1.1", "")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/lib/update/policy.test.ts`
Expected: FAIL — cannot find module `./policy`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/lib/update/policy.ts`:

```ts
import { compareVersions } from "./version";

export const DAY_MS = 86_400_000;

/** True when at least `intervalMs` has elapsed since the last check attempt. */
export function shouldAutoCheck(nowMs: number, lastCheckMs: number, intervalMs = DAY_MS): boolean {
  return nowMs - lastCheckMs >= intervalMs;
}

/** True when `latest` is strictly newer than `current` and not the skipped version. */
export function shouldPrompt(latest: string, current: string, skipped: string): boolean {
  return compareVersions(latest, current) > 0 && latest !== skipped;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/lib/update/policy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/update/policy.ts app/src/lib/update/policy.test.ts
git commit -m "feat(update): auto-check throttle + skip-version policy"
```

---

## Task 3: Persisted preference stores

**Files:**
- Modify: `app/src/lib/store.ts`
- Modify: `app/src/lib/catalog.ts`

- [ ] **Step 1: Add the two stores**

In `app/src/lib/store.ts`, after the `gridZoom` line (line 48), add:

```ts
/** Last in-app update check (epoch ms) and the version the user chose to skip.
 * Both persist via app_state as `update_last_check` / `update_skip_version`. */
export const updateLastCheck = writable<number>(0);
export const updateSkipVersion = writable<string>("");
```

- [ ] **Step 2: Hydrate them on load**

In `app/src/lib/catalog.ts`, update the store import block (lines 5-8) to add the two stores:

```ts
import {
  images, editsById, cropById, dustById, metaById, quality,
  selectedFolder, gridZoom, module as moduleStore, activeId, folderBaseByPath,
  updateLastCheck, updateSkipVersion,
} from "./store";
```

In `applySnapshot`, right after the `grid_zoom` block (the `if (st.grid_zoom !== undefined) { ... }` block ending at line 76), add:

```ts
  if (st.update_skip_version !== undefined) updateSkipVersion.set(st.update_skip_version);
  if (st.update_last_check !== undefined) {
    const ms = Number(st.update_last_check);
    if (Number.isFinite(ms)) updateLastCheck.set(ms);
  }
```

- [ ] **Step 3: Wire write-through**

In `app/src/lib/catalog.ts` `initPersistence`, extend the `first` flags object (line 160) to:

```ts
  let first = { q: true, loc: true, sf: true, gz: true, mod: true, aid: true, usv: true, ulc: true };
```

Then after the `gridZoom.subscribe(...)` line (line 164), add:

```ts
  updateSkipVersion.subscribe((v) => { if (first.usv) { first.usv = false; return; } saveState("update_skip_version", v); });
  updateLastCheck.subscribe((v) => { if (first.ulc) { first.ulc = false; return; } saveState("update_last_check", String(v)); });
```

- [ ] **Step 4: Typecheck**

Run: `cd app && npm run check`
Expected: `0 ERRORS` (pre-existing a11y warnings only).

- [ ] **Step 5: Verify existing tests still pass**

Run: `cd app && npx vitest run`
Expected: all tests PASS (no behavior change to existing suites).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/store.ts app/src/lib/catalog.ts
git commit -m "feat(update): persist skip-version + last-check via app_state"
```

---

## Task 4: Install plugin dependencies

**Files:**
- Modify: `app/package.json`
- Modify: `app/src-tauri/Cargo.toml`

- [ ] **Step 1: Add the JS plugin packages**

Run:

```bash
cd app && npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

Expected: both added to `dependencies` in `app/package.json`; `package-lock.json` updated.

- [ ] **Step 2: Add the Rust plugin crates**

In `app/src-tauri/Cargo.toml`, in the `[dependencies]` block after `tauri-plugin-dialog = "2"` (line 23), add:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 3: Commit**

```bash
git add app/package.json app/package-lock.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "build(update): add tauri updater + process plugin deps"
```

---

## Task 5: Register plugins + capabilities (Rust)

**Files:**
- Modify: `app/src-tauri/src/lib.rs:23-24`
- Modify: `app/src-tauri/capabilities/default.json`

- [ ] **Step 1: Register the plugins**

In `app/src-tauri/src/lib.rs`, after the `.plugin(tauri_plugin_dialog::init())` line (line 24), add:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 2: Grant capabilities**

In `app/src-tauri/capabilities/default.json`, change the `permissions` array to:

```json
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "updater:default",
    "process:allow-restart"
  ]
```

- [ ] **Step 3: Build the frontend (required for Tauri context generation)**

Run: `cd app && npm run build`
Expected: SvelteKit static build succeeds, producing `app/build/`.

- [ ] **Step 4: Verify Rust compiles**

Run: `cd app/src-tauri && cargo check`
Expected: compiles clean. The `updater:default` and `process:allow-restart` permissions resolve because the plugin crates are now dependencies.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/lib.rs app/src-tauri/capabilities/default.json
git commit -m "feat(update): register updater + process plugins and capabilities"
```

---

## Task 6: Updater wrapper + state store

**Files:**
- Create: `app/src/lib/update/updater.ts`

- [ ] **Step 1: Write the wrapper**

Create `app/src/lib/update/updater.ts`:

```ts
import { writable, get } from "svelte/store";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { updateLastCheck, updateSkipVersion } from "../store";
import { shouldAutoCheck, shouldPrompt } from "./policy";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; pct: number }
  | { kind: "restartReady" }
  | { kind: "upToDate" }
  | { kind: "error"; message: string };

/** Drives UpdatePrompt.svelte. "upToDate"/"error" are only surfaced for manual checks. */
export const updateState = writable<UpdateState>({ kind: "idle" });

let pending: Update | null = null;

/** Launch check: throttled, skip-aware, and silent on failure. */
export async function runAutoCheck(): Promise<void> {
  if (!isTauri()) return;
  const now = Date.now();
  if (!shouldAutoCheck(now, get(updateLastCheck))) return;
  updateLastCheck.set(now); // stamp at attempt start so the throttle holds even offline
  try {
    const u = await check();
    if (u && shouldPrompt(u.version, u.currentVersion, get(updateSkipVersion))) {
      pending = u;
      updateState.set({ kind: "available", version: u.version, notes: u.body ?? "" });
    }
  } catch (e) {
    console.warn("update check failed", e);
  }
}

/** Manual check: ignores throttle + skip; surfaces up-to-date and error states. */
export async function runManualCheck(): Promise<void> {
  if (!isTauri()) return;
  updateLastCheck.set(Date.now());
  try {
    const u = await check();
    if (u) {
      pending = u;
      updateState.set({ kind: "available", version: u.version, notes: u.body ?? "" });
    } else {
      updateState.set({ kind: "upToDate" });
    }
  } catch (e) {
    updateState.set({ kind: "error", message: String(e) });
  }
}

export async function startUpdate(): Promise<void> {
  if (!pending) return;
  updateState.set({ kind: "downloading", pct: 0 });
  let total = 0;
  let got = 0;
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        updateState.set({ kind: "downloading", pct: total ? got / total : 0 });
      }
    });
    updateState.set({ kind: "restartReady" });
  } catch (e) {
    updateState.set({ kind: "error", message: String(e) });
  }
}

export async function restart(): Promise<void> {
  await relaunch();
}

export function skipVersion(version: string): void {
  updateSkipVersion.set(version);
  updateState.set({ kind: "idle" });
}

export function dismiss(): void {
  updateState.set({ kind: "idle" });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: `0 ERRORS`. (Confirms the plugin type names `Update`, `check`, `relaunch`, and the download-event shape resolve against the installed plugin versions. If the event field names differ in the installed version, adjust the `ev.event` / `ev.data` access to match the plugin's exported `DownloadEvent` type — do not invent fields.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/update/updater.ts
git commit -m "feat(update): plugin wrapper with auto/manual check + install flow"
```

---

## Task 7: Localization strings

**Files:**
- Modify: `app/src/lib/i18n/dict.ts`

- [ ] **Step 1: Add the EN strings**

In `app/src/lib/i18n/dict.ts`, inside the **en** dictionary object, add these keys (place them after the existing `settings.*` group):

```ts
    "settings.checkUpdates": "Check for updates",
    "update.title": "Software update",
    "update.available": "Version {version} is available.",
    "update.notesLabel": "What's new",
    "update.update": "Update",
    "update.later": "Later",
    "update.skip": "Skip this version",
    "update.downloading": "Downloading update…",
    "update.restartNow": "Restart now",
    "update.upToDate": "You're on the latest version.",
    "update.error": "Update check failed. Please try again later.",
    "update.dismiss": "OK",
```

- [ ] **Step 2: Add the ZH strings**

In the **zh** dictionary object, add the same keys with translations (place them after the existing `settings.*` group):

```ts
    "settings.checkUpdates": "检查更新",
    "update.title": "软件更新",
    "update.available": "有新版本 {version} 可用。",
    "update.notesLabel": "更新内容",
    "update.update": "更新",
    "update.later": "稍后",
    "update.skip": "跳过此版本",
    "update.downloading": "正在下载更新…",
    "update.restartNow": "立即重启",
    "update.upToDate": "已是最新版本。",
    "update.error": "检查更新失败，请稍后再试。",
    "update.dismiss": "确定",
```

- [ ] **Step 3: Verify EN/ZH key parity**

Run:

```bash
cd app && node -e '
const s=require("fs").readFileSync("src/lib/i18n/dict.ts","utf8");
const m_en=s.search(/\n\s*en\s*:/), m_zh=s.search(/\n\s*zh\s*:/);
const kv=b=>{const d={};for(const m of b.matchAll(/"([a-zA-Z0-9_.]+)"\s*:/g))d[m[1]]=1;return d;};
const en=kv(s.slice(m_en,m_zh)), zh=kv(s.slice(m_zh));
const only=(a,b)=>Object.keys(a).filter(k=>!b[k]);
console.log("EN-only:",only(en,zh)); console.log("ZH-only:",only(zh,en));
'
```

Expected: `EN-only: []` and `ZH-only: []`.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/i18n/dict.ts
git commit -m "i18n(update): EN/ZH strings for update prompt + Settings entry"
```

---

## Task 8: Update prompt modal

**Files:**
- Create: `app/src/lib/update/UpdatePrompt.svelte`

- [ ] **Step 1: Write the modal**

Create `app/src/lib/update/UpdatePrompt.svelte`:

```svelte
<script lang="ts">
  import { t } from "$lib/i18n";
  import { fade } from "svelte/transition";
  import { updateState, startUpdate, restart, skipVersion, dismiss } from "./updater";
</script>

{#if $updateState.kind !== "idle"}
  <div class="backdrop" on:click={dismiss} transition:fade={{ duration: 120 }}></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label={$t("update.title")} transition:fade={{ duration: 120 }}>
    <h2>{$t("update.title")}</h2>

    {#if $updateState.kind === "available"}
      <p class="ver">{$t("update.available", { version: $updateState.version })}</p>
      {#if $updateState.notes}
        <div class="notes-label">{$t("update.notesLabel")}</div>
        <pre class="notes">{$updateState.notes}</pre>
      {/if}
      <div class="row">
        <button class="ghost" on:click={() => skipVersion($updateState.kind === "available" ? $updateState.version : "")}>{$t("update.skip")}</button>
        <button class="ghost" on:click={dismiss}>{$t("update.later")}</button>
        <button class="primary" on:click={startUpdate}>{$t("update.update")}</button>
      </div>

    {:else if $updateState.kind === "downloading"}
      <p>{$t("update.downloading")}</p>
      <div class="bar"><div class="fill" style="width:{Math.round($updateState.pct * 100)}%"></div></div>

    {:else if $updateState.kind === "restartReady"}
      <div class="row">
        <button class="ghost" on:click={dismiss}>{$t("update.later")}</button>
        <button class="primary" on:click={restart}>{$t("update.restartNow")}</button>
      </div>

    {:else if $updateState.kind === "upToDate"}
      <p>{$t("update.upToDate")}</p>
      <div class="row"><button class="primary" on:click={dismiss}>{$t("update.dismiss")}</button></div>

    {:else if $updateState.kind === "error"}
      <p class="err">{$t("update.error")}</p>
      <div class="row"><button class="primary" on:click={dismiss}>{$t("update.dismiss")}</button></div>
    {/if}
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,0.45); }
  .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
    width: min(440px, 90vw); background: var(--glass-bg); border: 1px solid var(--glass-brd);
    border-radius: 14px; padding: 20px; backdrop-filter: blur(20px);
    box-shadow: 0 16px 50px rgba(0,0,0,0.55); color: var(--text); }
  h2 { margin: 0 0 10px; font-size: 16px; }
  .ver { color: var(--text-dim); font-size: 13px; margin: 0 0 12px; }
  .notes-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-dim); margin: 8px 0 4px; }
  .notes { max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 12px;
    background: var(--bg-1); border: 1px solid var(--glass-brd); border-radius: 8px;
    padding: 10px; margin: 0 0 12px; }
  .err { color: var(--accent); }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .row button { padding: 8px 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
    border: 1px solid var(--glass-brd); }
  .ghost { background: transparent; color: var(--text-dim); }
  .ghost:hover { color: var(--text); background: var(--glass-hi); }
  .primary { background: rgba(244,157,78,0.18); border-color: rgba(244,157,78,0.5); color: #fff; }
  .bar { height: 6px; border-radius: 3px; background: var(--glass-brd); overflow: hidden; margin-top: 10px; }
  .fill { height: 100%; background: var(--accent); transition: width 0.15s; }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npm run check`
Expected: `0 ERRORS` (a11y warnings on the click-only backdrop are acceptable and consistent with existing modals like `SettingsMenu.svelte`).

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/update/UpdatePrompt.svelte
git commit -m "feat(update): centered Skip/Later/Update modal"
```

---

## Task 9: Wire into the app shell

**Files:**
- Modify: `app/src/lib/settings/SettingsMenu.svelte`
- Modify: `app/src/routes/+page.svelte`

- [ ] **Step 1: Add "Check for updates" to Settings**

In `app/src/lib/settings/SettingsMenu.svelte`, update the script imports (line 4) to add the wrapper:

```svelte
  import { locale, LOCALES, t } from "../i18n";
  import { runManualCheck } from "../update/updater";
```

Then after the existing `.shortcuts` button (lines 18-21), add a second row button:

```svelte
  <button class="shortcuts" on:click={() => { dispatch("close"); runManualCheck(); }}>
    <span class="kbd-icon" aria-hidden="true">↑</span>
    {$t("settings.checkUpdates")}
  </button>
```

- [ ] **Step 2: Mount the modal + trigger auto-check**

In `app/src/routes/+page.svelte`, add imports after the `AboutModal` import (line 16):

```svelte
  import UpdatePrompt from "$lib/update/UpdatePrompt.svelte";
  import { runAutoCheck } from "$lib/update/updater";
```

Change the `onMount` hydrate line (line 24) to also fire the auto-check:

```svelte
    hydrate().finally(() => { flush = initPersistence(); runAutoCheck(); });
```

Add the modal to the markup, right after the `AboutModal` line (line 117):

```svelte
{#if aboutOpen}<AboutModal on:close={() => (aboutOpen = false)} />{/if}
<UpdatePrompt />
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npm run check`
Expected: `0 ERRORS`.

- [ ] **Step 4: Full test suite**

Run: `cd app && npx vitest run`
Expected: all PASS (new pure-logic tests included; no regressions).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/settings/SettingsMenu.svelte app/src/routes/+page.svelte
git commit -m "feat(update): launch auto-check + Settings manual check entry"
```

---

## Task 10: Updater signing + release pipeline

> This task needs **you** (the repo owner). The updater private key must be generated by you and stored as GitHub secrets; only the public key is committed. The frontend/Rust above all builds and runs without this — `check()` simply fails (caught silently) until the config + signed release exist.

**Files:**
- Modify: `app/src-tauri/tauri.conf.json`
- Modify: `.github/workflows/release.yml`
- Modify: `docs/RELEASING.md`

- [ ] **Step 1 (manual — you): Generate the updater keypair**

Run:

```bash
cd app && npm run tauri signer generate -- -w ~/.tauri/openenlarge.key
```

This prints a **public key** (a base64 block) and writes the password-protected **private key** to `~/.tauri/openenlarge.key`. Choose a password when prompted. Keep both safe; do **not** commit either.

- [ ] **Step 2 (manual — you): Add GitHub secrets**

In the repo's GitHub → Settings → Secrets and variables → Actions, add:
- `TAURI_SIGNING_PRIVATE_KEY` = the full contents of `~/.tauri/openenlarge.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = the password you chose

- [ ] **Step 3: Add updater config to tauri.conf.json**

In `app/src-tauri/tauri.conf.json`, add `"createUpdaterArtifacts": true` to the `bundle` object (after `"active": true,` on line 26):

```json
  "bundle": {
    "active": true,
    "createUpdaterArtifacts": true,
```

And add a top-level `plugins` object (e.g. after the closing `}` of `bundle`, before the final `}` of the file). Replace `PUBLIC_KEY_FROM_STEP_1` with the exact public key string printed in Step 1:

```json
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/mohaelder/openenlarge/releases/latest/download/latest.json"
      ],
      "pubkey": "PUBLIC_KEY_FROM_STEP_1"
    }
  }
```

- [ ] **Step 4: Pass signing secrets to tauri-action**

In `.github/workflows/release.yml`, in the `tauri-apps/tauri-action@v0` step's `env:` block (lines 83-91), add after the `APPLE_TEAM_ID` line:

```yaml
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

- [ ] **Step 5: Verify config + frontend build**

Run: `cd app && npm run build && cd src-tauri && cargo check`
Expected: build + check succeed; `tauri.conf.json` is valid JSON with the new `plugins.updater` block.

- [ ] **Step 6: Document the process**

Append an "Auto-update signing" section to `docs/RELEASING.md` describing Steps 1-2 (keygen + the two secrets), the `plugins.updater.pubkey`/endpoint relationship, and these two facts:
- `latest.json` resolves only after the draft release is **published** (same as the website).
- Auto-update applies **from the first updater-enabled release forward**; earlier builds upgrade manually once.

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/tauri.conf.json .github/workflows/release.yml docs/RELEASING.md
git commit -m "ci(update): sign updater artifacts + publish latest.json"
```

---

## Post-implementation verification (manual, after a real release)

1. Bump version to the next patch (e.g. `0.1.2`) in `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`; tag `v0.1.2`; push; let CI build; **publish** the draft.
2. Install the prior updater-enabled build, launch it, and confirm: the modal appears, **Skip** suppresses re-prompts for that version, **Later** re-prompts next day, **Update** downloads → **Restart now** relaunches into the new version.
3. Confirm **Settings → Check for updates** shows "up to date" on the newest build.

---

## Self-review notes

- **Spec coverage:** auto-check throttle (Tasks 2,6,9), skip-version (Tasks 2,3,6,8), modal Skip/Later/Update (Task 8), manual Settings check (Tasks 6,9), persistence (Task 3), Rust plugins + capabilities (Tasks 4,5), signing/CI/docs + caveats (Task 10), EN/ZH (Task 7), pure-logic unit tests (Tasks 1,2). All spec sections map to a task.
- **Tauri detection** guards every entry point (`isTauri()` in `updater.ts`), so `vite dev` and vitest never call the plugin.
- **Version source** for the skip comparison is `update.currentVersion` from the plugin (no separate `getVersion()` needed).
