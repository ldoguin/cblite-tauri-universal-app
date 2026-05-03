use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    Json,
};

use crate::{
    auth::validate_jwt,
    error::AppError,
    models::{KbApplyRequest, KbFact, KbFactKind, KbFactProposal, UserKnowledgeBase},
    AppState,
};

const USER_DATA_COLLECTION: &str = "_default.user_data";

/// Per-user document key: `user_kb::{username}`.
/// Using a fixed key like "user_kb" would cause all users to share the same
/// document slot in the collection, with the last writer silently overwriting others.
fn kb_doc_id(username: &str) -> String {
    format!("user_kb::{username}")
}

/// Maximum number of facts that can be approved in a single /kb/apply call.
const MAX_APPROVED_FACTS: usize = 50;
/// Maximum byte length of the custom_instructions field.
const MAX_CUSTOM_INSTRUCTIONS_BYTES: usize = 8 * 1024; // 8 KiB
/// Maximum tokens the LLM merge call may generate.
const LLM_MERGE_MAX_TOKENS: u32 = 512;

/// GET /kb
///
/// Returns the caller's current `user_kb` document, or 404 if none exists yet.
pub async fn get_kb(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<UserKnowledgeBase>, AppError> {
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let claims = validate_jwt(bearer, &state.jwt_secret).map_err(|_| AppError::Unauthorized)?;
    let username = &claims.username;

    let (sg_url, sg_db) = match (&state.sg_admin_url, &state.sg_db) {
        (Some(u), Some(d)) => (u.clone(), d.clone()),
        _ => return Err(AppError::Internal("SG not configured".into())),
    };

    match load_sg_doc::<UserKnowledgeBase>(
        &state.http,
        &sg_url,
        &sg_db,
        USER_DATA_COLLECTION,
        &kb_doc_id(username),
        state.sg_admin_auth.as_deref(),
    )
    .await
    {
        Ok(doc) => {
            // Verify ownership before returning
            if doc.data.owner != *username {
                return Err(AppError::Unauthorized);
            }
            Ok(Json(doc.data))
        }
        Err(e) if e.contains("404") || e.contains("Not Found") => Err(AppError::NotFound),
        Err(e) => Err(AppError::Internal(format!("Failed to load KB: {e}"))),
    }
}

/// POST /kb/apply
///
/// Applies approved facts from a `kb_fact_proposal` document into the user's
/// `user_kb` document. Conflicting entries are reconciled via an LLM merge call.
/// Rejected facts are marked on the proposal but not applied.
pub async fn apply_facts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<KbApplyRequest>,
) -> Result<Json<UserKnowledgeBase>, AppError> {
    // Auth
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let claims = validate_jwt(bearer, &state.jwt_secret).map_err(|_| AppError::Unauthorized)?;
    let username = &claims.username;

    let (sg_url, sg_db) = match (&state.sg_admin_url, &state.sg_db) {
        (Some(u), Some(d)) => (u.clone(), d.clone()),
        _ => return Err(AppError::Internal("SG not configured".into())),
    };

    // Load the proposal doc
    let proposal_doc = load_sg_doc::<KbFactProposal>(
        &state.http,
        &sg_url,
        &sg_db,
        USER_DATA_COLLECTION,
        &req.proposal_id,
        state.sg_admin_auth.as_deref(),
    )
    .await
    .map_err(|e| AppError::Internal(format!("Failed to load proposal: {e}")))?;

    // Verify ownership
    if proposal_doc.data.owner != *username {
        return Err(AppError::Unauthorized);
    }
    let proposal = proposal_doc.data;
    let proposal_rev = proposal_doc.rev;

    // Load current user_kb (or create a default)
    let kb_doc = load_sg_doc::<UserKnowledgeBase>(
        &state.http,
        &sg_url,
        &sg_db,
        USER_DATA_COLLECTION,
        &kb_doc_id(username),
        state.sg_admin_auth.as_deref(),
    )
    .await;
    let (mut kb, kb_rev) = match kb_doc {
        Ok(d) => { let rev = d.rev; (d.data, rev) }
        Err(_) => (UserKnowledgeBase {
            doc_type: "user_kb".into(),
            owner: username.clone(),
            ..Default::default()
        }, None),
    };

    // Cap the number of approved facts per request to bound LLM call count.
    if req.approved_fact_ids.len() > MAX_APPROVED_FACTS {
        return Err(AppError::BadRequest(format!(
            "too many approved facts (max {MAX_APPROVED_FACTS})"
        )));
    }

    // Apply approved facts with LLM-based merge on conflict
    let approved_ids: std::collections::HashSet<&str> =
        req.approved_fact_ids.iter().map(|s| s.as_str()).collect();
    let rejected_ids: std::collections::HashSet<&str> =
        req.rejected_fact_ids.iter().map(|s| s.as_str()).collect();

    for fact in &proposal.facts {
        if approved_ids.contains(fact.id.as_str()) {
            apply_fact_to_kb(&mut kb, fact, &state).await;
        }
    }

    // Save updated KB (supply _rev so SG accepts the update)
    let now = chrono::Utc::now().to_rfc3339();
    kb.updated_at = Some(now.clone());
    if kb.created_at.is_none() {
        kb.created_at = Some(now.clone());
    }

    save_sg_doc(
        &state.http,
        &sg_url,
        &sg_db,
        USER_DATA_COLLECTION,
        &kb_doc_id(username),
        &kb,
        kb_rev.as_deref(),
        state.sg_admin_auth.as_deref(),
    )
    .await
    .map_err(|e| AppError::Internal(format!("Failed to save KB: {e}")))?;

    // Update proposal — stamp per-fact status (supply _rev to avoid 409)
    let mut updated_proposal = proposal;
    for fact in &mut updated_proposal.facts {
        if approved_ids.contains(fact.id.as_str()) {
            fact.status = "approved".into();
        } else if rejected_ids.contains(fact.id.as_str()) {
            fact.status = "rejected".into();
        }
    }
    updated_proposal.updated_at = now;
    let proposal_id = updated_proposal.id.clone();

    // Best-effort proposal update — don't fail the whole request if this fails
    let _ = save_sg_doc(
        &state.http,
        &sg_url,
        &sg_db,
        USER_DATA_COLLECTION,
        &proposal_id,
        &updated_proposal,
        proposal_rev.as_deref(),
        state.sg_admin_auth.as_deref(),
    )
    .await;

    Ok(Json(kb))
}

// ── Fact application ──────────────────────────────────────────────────────────

async fn apply_fact_to_kb(kb: &mut UserKnowledgeBase, fact: &KbFact, state: &AppState) {
    match fact.kind {
        KbFactKind::Contact => {
            let name = fact.value.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() { return; }
            let existing_idx = kb.contacts.iter().position(|c| {
                c.get("name").and_then(|v| v.as_str()).unwrap_or("") == name
            });
            if let Some(idx) = existing_idx {
                // Conflict — LLM merge
                if let Some(merged) = llm_merge_json(
                    &kb.contacts[idx],
                    &fact.value,
                    "contact",
                    state,
                ).await {
                    kb.contacts[idx] = merged;
                }
            } else {
                kb.contacts.push(fact.value.clone());
            }
        }
        KbFactKind::Project => {
            let name = fact.value.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() { return; }
            let existing_idx = kb.projects.iter().position(|p| {
                p.get("name").and_then(|v| v.as_str()).unwrap_or("") == name
            });
            if let Some(idx) = existing_idx {
                if let Some(merged) = llm_merge_json(
                    &kb.projects[idx],
                    &fact.value,
                    "project",
                    state,
                ).await {
                    kb.projects[idx] = merged;
                }
            } else {
                kb.projects.push(fact.value.clone());
            }
        }
        KbFactKind::IgnorePattern => {
            if let Some(pattern) = fact.value.as_str() {
                if !kb.ignore_patterns.iter().any(|p| p == pattern) {
                    kb.ignore_patterns.push(pattern.to_string());
                }
            }
        }
        KbFactKind::PriorityPattern => {
            if let Some(pattern) = fact.value.as_str() {
                if !kb.priority_patterns.iter().any(|p| p == pattern) {
                    kb.priority_patterns.push(pattern.to_string());
                }
            }
        }
        KbFactKind::CustomInstruction => {
            if let Some(instruction) = fact.value.as_str() {
                let merged = match &kb.custom_instructions {
                    Some(existing) => format!("{existing}\n{instruction}"),
                    None => instruction.to_string(),
                };
                // Truncate to prevent unbounded growth and LLM context overflow.
                kb.custom_instructions = Some(if merged.len() > MAX_CUSTOM_INSTRUCTIONS_BYTES {
                    // Truncate at a char boundary to avoid splitting a multi-byte UTF-8 sequence.
                    let boundary = merged.floor_char_boundary(MAX_CUSTOM_INSTRUCTIONS_BYTES);
                    merged[..boundary].to_string()
                } else {
                    merged
                });
            }
        }
    }
}

// ── LLM merge ─────────────────────────────────────────────────────────────────

/// Ask the LLM to reconcile an existing KB entry with a new fact value.
/// Returns the merged JSON value, or None if the call fails (keep existing).
async fn llm_merge_json(
    existing: &serde_json::Value,
    new_value: &serde_json::Value,
    kind: &str,
    state: &AppState,
) -> Option<serde_json::Value> {
    let api_key = state.openai_api_key.as_deref()?;
    let base_url = state.openai_base_url.as_deref().unwrap_or("https://api.openai.com/v1");

    // Serialise inputs to JSON strings so they are safely quoted and cannot
    // inject prompt-level instructions regardless of their content.
    let existing_json = serde_json::to_string(existing).unwrap_or_default();
    let new_value_json = serde_json::to_string(new_value).unwrap_or_default();
    // Truncate each side to prevent context overflow.
    let existing_safe = existing_json.chars().take(1000).collect::<String>();
    let new_value_safe = new_value_json.chars().take(1000).collect::<String>();

    let prompt = format!(
        "You are merging two {kind} entries in a user knowledge base. \
        Produce a single merged JSON object that combines both, \
        preferring more specific or recent information. \
        Respond with ONLY the JSON object, no markdown, no explanation.\n\
        Existing: {existing_safe}\n\
        New: {new_value_safe}"
    );

    let res = state.http
        .post(format!("{base_url}/chat/completions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&serde_json::json!({
            "model": state.openai_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.1,
            "max_tokens": LLM_MERGE_MAX_TOKENS,
            "response_format": {"type": "json_object"}
        }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .ok()?;

    let body: serde_json::Value = res.json().await.ok()?;
    let content = body["choices"][0]["message"]["content"].as_str()?;
    serde_json::from_str(content).ok()
}

// ── SG Admin API helpers ──────────────────────────────────────────────────────

/// A loaded SG document paired with its current `_rev` so updates can supply it.
struct SgDoc<T> {
    data: T,
    rev: Option<String>,
}

async fn load_sg_doc<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    sg_url: &str,
    sg_db: &str,
    collection: &str,
    doc_id: &str,
    admin_auth: Option<&str>,
) -> Result<SgDoc<T>, String> {
    let url = format!("{sg_url}/{sg_db}/{collection}/{}", urlencoding::encode(doc_id));
    let mut req = http.get(&url);
    if let Some(auth) = admin_auth {
        req = req.header("Authorization", auth);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("SG GET {} returned {}", doc_id, res.status()));
    }
    // Capture the raw JSON so we can extract _rev before deserialising.
    let raw: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let rev = raw.get("_rev").and_then(|v| v.as_str()).map(str::to_owned);
    let data = serde_json::from_value::<T>(raw).map_err(|e| e.to_string())?;
    Ok(SgDoc { data, rev })
}

async fn save_sg_doc<T: serde::Serialize>(
    http: &reqwest::Client,
    sg_url: &str,
    sg_db: &str,
    collection: &str,
    doc_id: &str,
    doc: &T,
    rev: Option<&str>,
    admin_auth: Option<&str>,
) -> Result<(), String> {
    let url = format!("{sg_url}/{sg_db}/{collection}/{}", urlencoding::encode(doc_id));
    // Merge _rev into the body so SG accepts the update without 409.
    let mut body = serde_json::to_value(doc).map_err(|e| e.to_string())?;
    if let (Some(rev), Some(obj)) = (rev, body.as_object_mut()) {
        obj.insert("_rev".to_string(), serde_json::Value::String(rev.to_owned()));
    }
    let mut req = http.put(&url).json(&body);
    if let Some(auth) = admin_auth {
        req = req.header("Authorization", auth);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("SG PUT {} returned {}", doc_id, res.status()));
    }
    Ok(())
}
