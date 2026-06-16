# AI Enhance — Design Spec

Date: 2026-06-16
Status: Approved (pending implementation plan)

## Summary

Add a fun, experimental "AI Enhance" feature to the filmrev (OpenEnlarge) editor.
It introduces a new editor tool placed immediately **after the eraser** in the
toolbar. Its panel has a single "✨ AI Enhance" button that sends the current
developed preview to OpenAI's image-editing API with a restoration-style base
prompt (fix noise / dust / scratches, super-resolve detail, keep content and
color intact, output at the highest resolution the API offers) and shows the
returned image inline in the panel.

## Reality / Constraints (read first)

The user explicitly wants to ship on OpenAI now, but structured so a faithful
restoration/upscale backend can be swapped in later. The following limits are
acknowledged and surfaced to the user in-app as "experimental":

- OpenAI's image API is **generative**, not a faithful restoration model. The
  result is a creative re-interpretation: content, grain, fine text, and exact
  colors typically shift. It will not truly "keep everything intact."
- The current model is **`gpt-image-1`** via `POST /v1/images/edits`. There is
  no "image 2" model.
- Max output is ~**1536×1024** (also 1024×1024 / 1024×1536). It does **not**
  return high-resolution output; a high-res scan is downsized. It cannot truly
  "super-resolve."
- Each call costs money (a few cents) and takes ~10–30s.

These are presented as a non-blocking limitation, not a reason to halt.

## Decisions (from brainstorming)

- **Approach:** Build on OpenAI now; structure the Rust HTTP logic so a real
  restoration/upscale provider can drop in later without touching the command
  signature or frontend.
- **Key & calls:** API call made from the **Rust backend** via `reqwest`. Key
  entered in Settings and persisted via the existing `save_pref` (SQLite `prefs`
  table). Key is passed to the command; it does not appear in frontend network
  calls.
- **Source image:** the **current developed preview** (the inverted/developed
  base64 JPEG the viewport already renders).
- **Result display:** **inside the AI Enhance panel** — a result image with
  click-to-enlarge and a before/after toggle. Does not touch the main viewport
  or any saved file.
- **Placement:** a **new toolbar tool `enhance`** immediately after `eraser`,
  with its own panel (matches how the eraser tool works), not a collapsible
  section inside the edit panel.

## Architecture

### Frontend (Svelte 5 + TS)

- **`app/src/lib/develop/AiEnhancePanel.svelte`** (new)
  - "✨ AI Enhance" button.
  - States: idle, loading (spinner + disabled button), error (inline message),
    result (shows enhanced image).
  - Result area: click-to-enlarge + before/after toggle between the source
    preview and the enhanced result.
  - Experimental label/notice describing the OpenAI caveats above.
  - On click: obtains the current developed preview base64 (same source the
    viewport uses — `previewSrc` store / render path), then calls
    `api.aiEnhanceImage(imageBase64, apiKey)`.
  - If no API key is set: show an inline message pointing the user to Settings;
    do not call the backend.

- **`app/src/lib/develop/Toolbar.svelte`**
  - Add an `enhance` tool button immediately after `eraser` in the tool array.

- **`app/src/lib/tabs/Develop.svelte`**
  - Import `AiEnhancePanel`.
  - Add `{:else if $tool === "enhance"}<AiEnhancePanel />` after the eraser
    branch.

- **`app/src/lib/settings/SettingsMenu.svelte`**
  - Add an OpenAI API key text input (password-style).
  - Load current value from catalog prefs; on change persist via
    `api.savePref("openai_api_key", value)`.

- **`app/src/lib/api.ts`**
  - Add binding: `aiEnhanceImage: (imageBase64: string, apiKey: string) =>
    invoke<string>("ai_enhance_image", { imageBase64, apiKey })`.
  - The `enhance` tool type is added wherever the tool union/type is defined.

### Backend (Rust / Tauri 2)

- **`app/src-tauri/src/ai_enhance.rs`** (new module — the fidelity-later seam)
  - A single function, e.g.
    `async fn enhance(image_base64: &str, api_key: &str) -> Result<String, String>`,
    that contains ALL provider-specific logic (endpoint, request shape, response
    parsing). Swapping providers later means editing only this file.
  - Builds the base prompt (see below), constructs the multipart/JSON request to
    OpenAI `/v1/images/edits` with `model: "gpt-image-1"` and a size requesting
    the highest the model offers (`"auto"`), parses the returned image, and
    returns it as a base64 data URL string (`data:image/png;base64,...`).

- **`app/src-tauri/src/commands.rs`**
  - New command:
    ```rust
    #[tauri::command]
    pub async fn ai_enhance_image(image_base64: String, api_key: String)
        -> Result<String, String> {
        crate::ai_enhance::enhance(&image_base64, &api_key).await
    }
    ```
  - Register the command in the Tauri builder's `invoke_handler`.

- **`app/src-tauri/Cargo.toml`**
  - Add `reqwest` (with `json` + `multipart` features as needed, rustls TLS to
    match Tauri's existing TLS strategy).

### Base prompt (draft)

> "Restore and enhance this photograph: remove sensor noise, film grain
> artifacts, dust, and scratches; sharpen and super-resolve fine detail. Keep
> the composition, subject, and content exactly intact. Preserve the original
> colors, white balance, and tonality faithfully. Output the cleanest,
> highest-resolution version possible."

Stored as a constant in `ai_enhance.rs`.

## Data flow

1. User selects the `enhance` tool → `AiEnhancePanel` renders.
2. User taps "✨ AI Enhance".
3. Panel reads the current developed preview base64 and the persisted API key.
4. Panel invokes `ai_enhance_image(imageBase64, apiKey)`.
5. Rust `ai_enhance::enhance` POSTs to OpenAI, parses the result, returns a
   base64 data URL.
6. Panel displays the result inline (with before/after toggle + enlarge).

## Error handling

- Missing API key (frontend check): inline message → "Add your OpenAI API key in
  Settings." No backend call.
- Network / non-2xx / parse errors (Rust): returned as `Err(String)` with a
  readable message; panel shows it inline. No panics, no crashes.
- Long-running call: button disabled + spinner; the panel remains responsive.

## Testing

- **Rust:** unit-test request-body construction and response parsing in
  `ai_enhance.rs` against fixture JSON (no live API calls). Keep the HTTP send
  step thin/injectable so parsing is testable in isolation.
- **Frontend:** the panel is thin glue (button → invoke → display); verified
  manually.

## Out of scope (YAGNI)

- Saving / exporting the enhanced result.
- Batch enhancement across multiple images.
- Tunable parameters / prompt editing in the UI.
- Replacing the main viewport with the result.
- i18n strings for new UI may be added per the project's CSV workflow if
  required, but are not a blocker for the feature.

## i18n note

Per project convention, user-facing strings are generated from
`/i18n-strings.csv` via `scripts/gen-i18n.py` — never edit `dict.ts` directly.
Any new strings for this panel follow that workflow.
