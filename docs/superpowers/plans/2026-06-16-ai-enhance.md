# AI Enhance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental "AI Enhance" editor tool (after the eraser) whose button sends the current developed preview to OpenAI's image-editing API with a restoration-style prompt and shows the returned image inline.

**Architecture:** A new Rust module (`ai_enhance.rs`) holds ALL provider-specific HTTP logic behind one async function, exposed via a thin `ai_enhance_image` Tauri command — this is the seam for swapping in a real upscale/restoration provider later. The frontend adds a new `enhance` toolbar tool, an `AiEnhancePanel.svelte` that calls the command with the current preview + persisted API key, and an OpenAI API key field in Settings persisted through the existing `save_pref` write-through path.

**Tech Stack:** Tauri 2, Rust (reqwest async + multipart, base64, serde_json), Svelte 5 + TypeScript, SQLite-backed catalog prefs.

---

## File Structure

**Rust (backend)**
- Create: `app/src-tauri/src/ai_enhance.rs` — provider logic: prompt constant, request builder, response parser, async `enhance()` entry. The fidelity-later seam.
- Modify: `app/src-tauri/src/commands.rs` — add the `ai_enhance_image` command (thin wrapper).
- Modify: `app/src-tauri/src/lib.rs` — declare `mod ai_enhance;` and register the command in `invoke_handler`.
- Modify: `app/src-tauri/Cargo.toml` — add `reqwest`.

**Frontend**
- Modify: `app/src/lib/api.ts` — add `aiEnhanceImage` binding.
- Modify: `app/src/lib/store.ts` — add `openaiApiKey` store; add `"enhance"` to the `Tool` union.
- Modify: `app/src/lib/catalog.ts` — load `openai_api_key` pref on hydrate; persist on change.
- Modify: `app/src/lib/settings/SettingsMenu.svelte` — add the API key input.
- Create: `app/src/lib/develop/AiEnhancePanel.svelte` — the new panel (button + states + result display).
- Modify: `app/src/lib/develop/Toolbar.svelte` — add the `enhance` tool after `eraser`.
- Modify: `app/src/lib/tabs/Develop.svelte` — import + render `AiEnhancePanel` under `$tool === "enhance"`.
- Modify: `i18n-strings.csv` — new UI strings (regenerated via `scripts/gen-i18n.py`).

---

## Task 1: Rust AI-enhance module (prompt + response parser, TDD)

**Files:**
- Create: `app/src-tauri/src/ai_enhance.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/lib.rs:1-11` (add `mod ai_enhance;`)

- [ ] **Step 1: Add the reqwest dependency**

In `app/src-tauri/Cargo.toml`, in the `[dependencies]` table (after the `ultrahdr = "0.1"` line, line 39), add:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "multipart", "rustls-tls"] }
```

(`rustls-tls` avoids a system OpenSSL dependency so the existing Windows/macOS CI keeps building. `multipart` is required because OpenAI's image-edit endpoint takes multipart/form-data. tokio is pulled in transitively; Tauri 2 already runs async commands on its tokio runtime.)

- [ ] **Step 2: Create the module with the prompt constant + a failing parser test**

Create `app/src-tauri/src/ai_enhance.rs` with the prompt, a stub parser, and tests:

```rust
//! AI Enhance — provider-specific image enhancement.
//!
//! ALL OpenAI-specific logic lives in this file. To swap in a different
//! restoration/upscale provider later, replace `enhance()` and the helpers
//! below; the `ai_enhance_image` command and the frontend stay unchanged.

use base64::Engine;

/// Restoration-style instruction sent to the image model. Note: OpenAI's image
/// API is generative, so this is a best-effort "clean up & re-render", not a
/// faithful pixel-level restoration. Surfaced as experimental in the UI.
pub const ENHANCE_PROMPT: &str = "Restore and enhance this photograph: remove sensor noise, film grain artifacts, dust, and scratches; sharpen and super-resolve fine detail. Keep the composition, subject, and content exactly intact. Preserve the original colors, white balance, and tonality faithfully. Output the cleanest, highest-resolution version possible.";

const OPENAI_EDITS_URL: &str = "https://api.openai.com/v1/images/edits";
const OPENAI_MODEL: &str = "gpt-image-1";

/// Parse the OpenAI image-edit JSON response into a PNG data URL.
/// On an API error payload or a missing image, returns a readable `Err`.
fn parse_edit_response(body: &str) -> Result<String, String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("invalid response from OpenAI: {e}"))?;

    if let Some(msg) = json.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        return Err(format!("OpenAI error: {msg}"));
    }

    let b64 = json
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|first| first.get("b64_json"))
        .and_then(|b| b.as_str())
        .ok_or_else(|| "OpenAI response contained no image".to_string())?;

    Ok(format!("data:image/png;base64,{b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_covers_the_requested_fixes() {
        for needle in ["noise", "dust", "scratches", "color"] {
            assert!(
                ENHANCE_PROMPT.to_lowercase().contains(needle),
                "prompt should mention {needle}"
            );
        }
    }

    #[test]
    fn parse_extracts_png_data_url() {
        let body = r#"{"data":[{"b64_json":"QUJD"}]}"#;
        assert_eq!(parse_edit_response(body).unwrap(), "data:image/png;base64,QUJD");
    }

    #[test]
    fn parse_surfaces_api_error_message() {
        let body = r#"{"error":{"message":"Invalid API key"}}"#;
        let err = parse_edit_response(body).unwrap_err();
        assert!(err.contains("Invalid API key"), "got: {err}");
    }

    #[test]
    fn parse_errors_when_no_image() {
        let body = r#"{"data":[]}"#;
        assert!(parse_edit_response(body).is_err());
    }
}
```

- [ ] **Step 3: Register the module**

In `app/src-tauri/src/lib.rs`, add the module declaration alphabetically near the top (after `mod cache;` on line 1, before `mod catalog;`):

```rust
mod ai_enhance;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app/src-tauri && cargo test --lib ai_enhance`
Expected: PASS — `prompt_covers_the_requested_fixes`, `parse_extracts_png_data_url`, `parse_surfaces_api_error_message`, `parse_errors_when_no_image` all pass. (First run also compiles the new reqwest dependency, which may take a minute.)

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/ai_enhance.rs app/src-tauri/src/lib.rs
git commit -m "feat(ai-enhance): rust module with prompt + response parser"
```

---

## Task 2: The `enhance()` network function

**Files:**
- Modify: `app/src-tauri/src/ai_enhance.rs`

- [ ] **Step 1: Add the async `enhance` function**

Append to `app/src-tauri/src/ai_enhance.rs`, immediately after `parse_edit_response` (before the `#[cfg(test)]` module):

```rust
/// Send a base64-encoded JPEG (no data-URL prefix) to OpenAI's image-edit
/// endpoint and return the enhanced image as a PNG data URL.
///
/// `size` is sent as "auto" so the model returns the largest output it offers.
pub async fn enhance(image_base64: &str, api_key: &str) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("missing OpenAI API key".to_string());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image_base64.trim())
        .map_err(|e| format!("could not decode preview image: {e}"))?;

    let image_part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image.jpg")
        .mime_str("image/jpeg")
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .text("model", OPENAI_MODEL)
        .text("prompt", ENHANCE_PROMPT)
        .text("size", "auto")
        .part("image", image_part);

    let client = reqwest::Client::new();
    let resp = client
        .post(OPENAI_EDITS_URL)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("request to OpenAI failed: {e}"))?;

    let body = resp.text().await.map_err(|e| format!("reading OpenAI response failed: {e}"))?;
    parse_edit_response(&body)
}
```

(`parse_edit_response` already turns a non-2xx error JSON body into a readable `Err`, so we parse the body regardless of status code.)

- [ ] **Step 2: Verify it compiles and existing tests still pass**

Run: `cd app/src-tauri && cargo test --lib ai_enhance`
Expected: PASS — compiles cleanly, all four Task 1 tests still pass.

- [ ] **Step 3: Commit**

```bash
git add app/src-tauri/src/ai_enhance.rs
git commit -m "feat(ai-enhance): openai image-edit network call"
```

---

## Task 3: Tauri command + registration

**Files:**
- Modify: `app/src-tauri/src/commands.rs` (append a new command at end of file)
- Modify: `app/src-tauri/src/lib.rs:54-87` (register in `invoke_handler`)

- [ ] **Step 1: Add the command wrapper**

Append to the end of `app/src-tauri/src/commands.rs`:

```rust
/// Enhance the current developed preview via the configured AI provider.
/// `image_base64` is the preview JPEG payload WITHOUT the `data:` URL prefix.
/// Returns a PNG data URL on success, or a readable error string.
#[tauri::command]
pub async fn ai_enhance_image(image_base64: String, api_key: String) -> Result<String, String> {
    crate::ai_enhance::enhance(&image_base64, &api_key).await
}
```

- [ ] **Step 2: Register the command**

In `app/src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]` (lines 54-87), add this line after `commands::analyze,` (line 84):

```rust
            commands::ai_enhance_image,
```

- [ ] **Step 3: Verify the backend compiles**

Run: `cd app/src-tauri && cargo build --lib`
Expected: builds successfully with no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs
git commit -m "feat(ai-enhance): expose ai_enhance_image command"
```

---

## Task 4: Frontend API binding + store wiring

**Files:**
- Modify: `app/src/lib/api.ts:147-246` (add binding inside the `api` object)
- Modify: `app/src/lib/store.ts:124` (extend `Tool`) and add the `openaiApiKey` store
- Modify: `app/src/lib/catalog.ts` (load + persist the key)

- [ ] **Step 1: Add the API binding**

In `app/src/lib/api.ts`, inside the `api` object, add after the `savePref` entry (lines 205-206):

```typescript
  aiEnhanceImage: (imageBase64: string, apiKey: string) =>
    invoke<string>("ai_enhance_image", { imageBase64, apiKey }),
```

(Tauri maps the JS camelCase keys `imageBase64`/`apiKey` to the Rust snake_case params `image_base64`/`api_key` automatically.)

- [ ] **Step 2: Extend the Tool union and add the key store**

In `app/src/lib/store.ts`, change line 124 from:

```typescript
export type Tool = "edit" | "crop" | "eraser";
```

to:

```typescript
export type Tool = "edit" | "crop" | "eraser" | "enhance";
```

Then, immediately below the `tool` writable (line 125), add:

```typescript
/** OpenAI API key for the AI Enhance tool. Persisted via prefs as `openai_api_key`. */
export const openaiApiKey = writable<string>("");
```

- [ ] **Step 3: Load the key on hydrate**

In `app/src/lib/catalog.ts`, add `openaiApiKey` to the existing store import from `./store` (the import block near the top of the file that already imports `quality`, `locale` is imported from i18n — add `openaiApiKey` wherever the other `./store` writables are imported). Then in `applySnapshot`, after the locale block (lines 68-69), add:

```typescript
  if (typeof snap.prefs.openai_api_key === "string")
    openaiApiKey.set(snap.prefs.openai_api_key);
```

- [ ] **Step 4: Persist the key on change**

In `app/src/lib/catalog.ts`, in `initPersistence`, extend the `first` flags object (line 167) to include a new flag `oak: true`:

```typescript
  let first = { q: true, loc: true, sf: true, gz: true, mod: true, aid: true, usv: true, ulc: true, oak: true };
```

Then add a subscription next to the `locale` one (after line 169):

```typescript
  openaiApiKey.subscribe((k) => { if (first.oak) { first.oak = false; return; } savePref("openai_api_key", k); });
```

- [ ] **Step 5: Verify the frontend type-checks**

Run: `cd app && npm run check`
Expected: no new TypeScript/Svelte errors. (If the project has no `check` script, run `npx svelte-check --tsconfig ./tsconfig.json` from `app/`.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/api.ts app/src/lib/store.ts app/src/lib/catalog.ts
git commit -m "feat(ai-enhance): api binding + persisted openai key store"
```

---

## Task 5: API key field in Settings

**Files:**
- Modify: `app/src/lib/settings/SettingsMenu.svelte`

- [ ] **Step 1: Add the key input to the settings dialog**

In `app/src/lib/settings/SettingsMenu.svelte`, add `openaiApiKey` to the imports (after the i18n import on line 4):

```svelte
  import { openaiApiKey } from "../store";
```

Then add a new settings group after the language `<div class="grp">` block (after line 18, before the `shortcuts` button on line 19):

```svelte
  <div class="grp">
    <div class="head">{$t("settings.ai.heading")}</div>
    <input
      class="key" type="password" autocomplete="off" spellcheck="false"
      placeholder={$t("settings.ai.keyPlaceholder")}
      value={$openaiApiKey}
      on:input={(e) => openaiApiKey.set((e.target as HTMLInputElement).value)} />
    <div class="hint">{$t("settings.ai.hint")}</div>
  </div>
```

- [ ] **Step 2: Add styles for the input**

In the `<style>` block of `SettingsMenu.svelte`, add:

```css
  .grp + .grp { margin-top: 12px; }
  .key { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
    font-size: 12px; border: 1px solid var(--glass-brd); background: transparent;
    color: var(--text); }
  .key::placeholder { color: var(--text-dim); }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 6px; line-height: 1.4; }
```

- [ ] **Step 3: Verify it renders (manual)**

Run: `cd app && npm run tauri dev` (or the project's dev command). Open Settings; confirm the "AI Enhance" group with a password field appears, typing persists across a relaunch.
Expected: field shows, value survives app restart (written to prefs).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/settings/SettingsMenu.svelte
git commit -m "feat(ai-enhance): openai api key field in settings"
```

---

## Task 6: AiEnhancePanel component

**Files:**
- Create: `app/src/lib/develop/AiEnhancePanel.svelte`

- [ ] **Step 1: Create the panel**

Create `app/src/lib/develop/AiEnhancePanel.svelte`:

```svelte
<script lang="ts">
  import { get } from "svelte/store";
  import { t } from "$lib/i18n";
  import { previewSrc, openaiApiKey } from "../store";
  import { api } from "../api";

  let busy = false;
  let error = "";
  /** Enhanced result as a PNG data URL, or "" when none yet. */
  let result = "";
  /** The source preview captured at enhance time, for the before/after toggle. */
  let source = "";
  let showBefore = false;
  let enlarged = false;

  async function enhance() {
    error = "";
    const key = get(openaiApiKey).trim();
    if (!key) { error = $t("aiEnhance.noKey"); return; }

    const preview = get(previewSrc);
    const comma = preview.indexOf(",");
    if (!preview || comma < 0) { error = $t("aiEnhance.noImage"); return; }
    const b64 = preview.slice(comma + 1);

    busy = true;
    source = preview;
    try {
      result = await api.aiEnhanceImage(b64, key);
      showBefore = false;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="section">
  <div class="head"><span>{$t("aiEnhance.title")}</span><span class="exp">{$t("aiEnhance.experimental")}</span></div>

  <button class="go" disabled={busy} on:click={enhance}>
    {busy ? $t("aiEnhance.working") : $t("aiEnhance.button")}
  </button>

  {#if error}
    <div class="err">{error}</div>
  {/if}

  {#if result}
    <div class="result">
      <button class="img" on:click={() => (enlarged = true)} title={$t("aiEnhance.enlarge")}>
        <img src={showBefore ? source : result} alt={$t("aiEnhance.title")} />
      </button>
      <button class="toggle" on:mousedown={() => (showBefore = true)}
              on:mouseup={() => (showBefore = false)} on:mouseleave={() => (showBefore = false)}>
        {$t("aiEnhance.holdBefore")}
      </button>
    </div>
  {/if}

  <div class="hint">{$t("aiEnhance.hint")}</div>
</div>

{#if enlarged}
  <div class="lightbox" role="button" tabindex="0"
       on:click={() => (enlarged = false)} on:keydown={(e) => e.key === "Escape" && (enlarged = false)}>
    <img src={result} alt={$t("aiEnhance.title")} />
  </div>
{/if}

<style>
  .section { margin-bottom: 12px; }
  .head { display: flex; align-items: center; gap: 8px; color: var(--text);
    font-weight: 600; padding: 4px 0; }
  .exp { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    border: 1px solid rgba(244,157,78,0.5); color: var(--accent);
    border-radius: 4px; padding: 0 5px; }
  .go { width: 100%; padding: 9px 10px; margin: 6px 0; border-radius: 8px;
    border: 1px solid rgba(244,157,78,0.5); background: rgba(244,157,78,0.18);
    color: #fff; cursor: pointer; font-size: 13px; }
  .go:disabled { opacity: 0.55; cursor: default; }
  .err { font-size: 11px; color: #ff9a9a; margin: 6px 0; line-height: 1.4; }
  .result { margin-top: 8px; }
  .img { display: block; width: 100%; padding: 0; border: 1px solid var(--glass-brd);
    border-radius: 8px; overflow: hidden; background: transparent; cursor: zoom-in; }
  .img img { display: block; width: 100%; }
  .toggle { width: 100%; margin-top: 6px; padding: 6px 10px; border-radius: 8px;
    border: 1px solid var(--glass-brd); background: transparent; color: var(--text);
    cursor: pointer; font-size: 12px; }
  .hint { font-size: 11px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; }
  .lightbox { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center;
    background: rgba(0,0,0,0.8); cursor: zoom-out; }
  .lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 8px; }
</style>
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd app && npm run check`
Expected: no new TypeScript/Svelte errors. (The panel won't render yet — it's wired in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/develop/AiEnhancePanel.svelte
git commit -m "feat(ai-enhance): enhance panel component"
```

---

## Task 7: Toolbar tool + Develop wiring + i18n

**Files:**
- Modify: `app/src/lib/develop/Toolbar.svelte:6-10`
- Modify: `app/src/lib/tabs/Develop.svelte:24` (import) and `:327-333` (render branch)
- Modify: `i18n-strings.csv`

- [ ] **Step 1: Add the toolbar tool after the eraser**

In `app/src/lib/develop/Toolbar.svelte`, add an entry to the `tools` array (after the `eraser` entry on line 9):

```typescript
    { id: "enhance", icon: "sparkles", labelKey: "toolbar.enhance", enabled: true },
```

(Check that an icon named `sparkles` exists in `app/src/lib/icons/Icon.svelte`. If it does not, use an existing icon name as a fallback — e.g. `"sliders"` — and note that a dedicated icon can be added later. Do not invent a missing icon name.)

- [ ] **Step 2: Import and render the panel in Develop**

In `app/src/lib/tabs/Develop.svelte`, add the import after the `EraserPanel` import (line 24):

```svelte
  import AiEnhancePanel from "../develop/AiEnhancePanel.svelte";
```

Then add a new branch in the tool-pane block, after the eraser `{:else if}` (after line 332, before the closing `{/if}` on line 333):

```svelte
          {:else if $tool === "enhance"}
            <AiEnhancePanel />
```

- [ ] **Step 3: Add i18n strings**

Append these rows to `i18n-strings.csv` (the file has columns `key,en,zh,file,note`):

```csv
toolbar.enhance,"AI Enhance","AI 增强","src/lib/develop/Toolbar.svelte","title"
settings.ai.heading,"AI Enhance","AI 增强","src/lib/settings/SettingsMenu.svelte","heading"
settings.ai.keyPlaceholder,"OpenAI API key","OpenAI API 密钥","src/lib/settings/SettingsMenu.svelte","placeholder"
settings.ai.hint,"Stored locally. Used only for the AI Enhance tool.","仅本地保存，仅用于 AI 增强工具。","src/lib/settings/SettingsMenu.svelte","hint"
aiEnhance.title,"AI Enhance","AI 增强","src/lib/develop/AiEnhancePanel.svelte","heading"
aiEnhance.experimental,"experimental","实验性","src/lib/develop/AiEnhancePanel.svelte","label"
aiEnhance.button,"✨ Enhance preview","✨ 增强预览","src/lib/develop/AiEnhancePanel.svelte","button"
aiEnhance.working,"Enhancing…","增强中…","src/lib/develop/AiEnhancePanel.svelte","button"
aiEnhance.noKey,"Add your OpenAI API key in Settings.","请在设置中添加 OpenAI API 密钥。","src/lib/develop/AiEnhancePanel.svelte","text"
aiEnhance.noImage,"No preview to enhance yet.","暂无可增强的预览。","src/lib/develop/AiEnhancePanel.svelte","text"
aiEnhance.holdBefore,"Hold to compare original","按住对比原图","src/lib/develop/AiEnhancePanel.svelte","button"
aiEnhance.enlarge,"Click to enlarge","点击放大","src/lib/develop/AiEnhancePanel.svelte","title"
aiEnhance.hint,"Re-imagines the preview to reduce noise, dust and scratches. Result is a creative interpretation, not a faithful restoration, and is preview-only.","重新生成预览以减少噪点、灰尘和划痕。结果为创意性再生成，并非忠实修复，且仅用于预览。","src/lib/develop/AiEnhancePanel.svelte","hint"
```

- [ ] **Step 4: Regenerate the i18n dictionary**

Run: `cd /Users/mohaelder/Repos/filmrev && python3 scripts/gen-i18n.py`
Expected: regenerates the dictionary (e.g. `app/src/lib/i18n/dict.ts`) including the new keys, with no errors. (Per project convention, never hand-edit `dict.ts` — it is generated from the CSV.)

- [ ] **Step 5: Verify type-check and a manual end-to-end pass**

Run: `cd app && npm run check`
Expected: no new errors.

Then run the app (`npm run tauri dev`), enter a valid OpenAI key in Settings, open an image in Develop, select the new AI Enhance tool (after the eraser), and click "✨ Enhance preview".
Expected: button shows "Enhancing…", then an enhanced image appears in the panel; click enlarges it; holding "Hold to compare original" swaps to the source. With no key set, clicking shows the "Add your OpenAI API key in Settings." message instead of calling the backend.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/develop/Toolbar.svelte app/src/lib/tabs/Develop.svelte i18n-strings.csv app/src/lib/i18n/dict.ts
git commit -m "feat(ai-enhance): toolbar tool, develop wiring, i18n strings"
```

---

## Self-Review Notes

- **Spec coverage:** new section after eraser (Task 7), AI Enhance button (Task 6), OpenAI API key in Settings + persistence (Tasks 4–5), base prompt for noise/dust/scratches/super-res/color (Task 1), highest resolution via `size: "auto"` (Task 2), result shown inline in panel (Task 6), Rust-backend call with key in prefs (Tasks 2–4), source = current developed preview via `previewSrc` (Task 6), fidelity-later seam = single `ai_enhance.rs` (Tasks 1–2). All covered.
- **Type consistency:** command name `ai_enhance_image` and params `image_base64`/`api_key` match across `ai_enhance.rs` → `commands.rs` → `lib.rs` → `api.ts` binding (`imageBase64`/`apiKey`). Pref key `openai_api_key` matches between `catalog.ts` load/save and `commands` prefs. `ENHANCE_PROMPT` defined once and referenced once. Tool id `"enhance"` consistent across `store.ts`, `Toolbar.svelte`, `Develop.svelte`.
- **Open verification points flagged inline:** icon name `sparkles` (Task 7 Step 1) and the exact generated dict path (Task 7 Step 4) are verified during implementation, not assumed.
