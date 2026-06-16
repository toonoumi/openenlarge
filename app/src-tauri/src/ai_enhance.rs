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
const OPENAI_MODEL: &str = "gpt-image-2";

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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("could not create HTTP client: {e}"))?;
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
