use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{auth::validate_jwt, error::AppError, AppState};

#[derive(Deserialize)]
pub struct ChatRequest {
    /// OpenAI-format message history, e.g. [{role: "user", content: "..."}]
    pub messages: serde_json::Value,
    /// Caller's OpenAI API key — overrides the server key when provided.
    pub api_key: Option<String>,
    /// Model to use; defaults to gpt-4o-mini.
    pub model: Option<String>,
    /// OpenAI-compatible base URL; overrides the server default when provided.
    pub openai_base_url: Option<String>,
    /// Maximum tokens to generate. Capped server-side at MAX_TOKENS_CAP.
    pub max_tokens: Option<u32>,
}

/// Hard upper bound on max_tokens to prevent runaway generation costs.
const MAX_TOKENS_CAP: u32 = 4096;
/// Hard upper bound on total serialised message payload (bytes).
const MAX_MESSAGES_BYTES: usize = 64 * 1024; // 64 KiB

#[derive(Serialize)]
pub struct ChatResponse {
    pub content: String,
}

pub async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChatRequest>,
) -> Result<Json<ChatResponse>, AppError> {
    // Require a valid JWT so only authenticated users can use the passthrough.
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    validate_jwt(bearer, &state.jwt_secret).map_err(|_| AppError::Unauthorized)?;

    // Reject oversized payloads before touching the LLM.
    let messages_bytes = req.messages.to_string().len();
    if messages_bytes > MAX_MESSAGES_BYTES {
        return Err(AppError::BadRequest(format!(
            "messages payload too large ({messages_bytes} bytes, max {MAX_MESSAGES_BYTES})"
        )));
    }

    // User key takes priority; fall back to server-configured key.
    let api_key = req.api_key
        .as_deref()
        .filter(|k| !k.trim().is_empty())
        .or(state.openai_api_key.as_deref())
        .ok_or_else(|| AppError::BadRequest("No OpenAI API key available".into()))?
        .to_string();

    let model = req.model.unwrap_or_else(|| "gpt-4o-mini".to_string());

    // Request URL: client-supplied base URL > server env var > OpenAI default.
    let base_url = req.openai_base_url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .or(state.openai_base_url.as_deref())
        .unwrap_or("https://api.openai.com/v1");
    let completions_url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let max_tokens = req.max_tokens
        .map(|t| t.min(MAX_TOKENS_CAP))
        .unwrap_or(MAX_TOKENS_CAP);

    let openai_body = serde_json::json!({
        "model": model,
        "messages": req.messages,
        "max_tokens": max_tokens,
    });

    let resp = state
        .http
        .post(&completions_url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .json(&openai_body)
        .send()
        .await
        .map_err(|e| AppError::Anyhow(e.into()))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "OpenAI error {status}: {body}"
        )));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| AppError::Anyhow(e.into()))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(Json(ChatResponse { content }))
}
