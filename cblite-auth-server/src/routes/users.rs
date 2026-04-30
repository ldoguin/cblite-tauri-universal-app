use axum::{
    extract::{Query, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{auth::{hash_password, validate_jwt}, db, error::AppError, models::User, AppState};

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub sync_url: Option<String>,
    pub sync_collection: Option<String>,
    pub sync_direction: Option<String>,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    pub user_id: String,
}

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<(StatusCode, Json<RegisterResponse>), AppError> {
    let username = body.username.trim();
    if username.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }
    if body.password.len() < 3 {
        return Err(AppError::BadRequest("password must be at least 3 characters".into()));
    }

    // Check uniqueness — user doc is keyed by username
    let user_key = format!("user::{username}");
    if state.cb.get::<serde_json::Value>(&user_key).await?.is_some() {
        return Err(AppError::Conflict("username already exists".into()));
    }

    let id = Uuid::new_v4().to_string();
    let password_hash = hash_password(&body.password).map_err(anyhow::Error::from)?;

    let user = User { id: id.clone(), username: username.to_owned(), password_hash };
    state.cb.insert(&user_key, &user).await?;

    // Use the server-configured sync URL as the default when the client doesn't supply one
    let sync_url = body.sync_url
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(state.sg_sync_url.as_deref())
        .unwrap_or("");

    let sync_config = serde_json::json!({
        "user_id": id,
        "sync_url": sync_url,
        "sync_collection": body.sync_collection.as_deref().unwrap_or("notes"),
        "sync_direction": body.sync_direction.as_deref().unwrap_or("both"),
    });
    state.cb.upsert(&format!("sync_config::{id}"), &sync_config).await?;

    // ── Per-user private scope + collections ──────────────────────────────────
    db::ensure_private_scope(&state.cb.cluster, &state.private_bucket, username).await;

    // ── Vector search index for server embeddings ─────────────────────────────
    db::ensure_vector_index(
        &state.http,
        &state.cb_search_url,
        &state.cb_credentials,
        &state.private_bucket,
        username,
    ).await;

    // ── Create user in private SG database ────────────────────────────────────
    if let (Some(sg_url), Some(sg_db)) = (&state.sg_admin_url, &state.sg_db) {
        let user_channel = format!("user.{username}");
        let sg_user = serde_json::json!({
            "name": username,
            "password": body.password,
            "admin_channels": [&user_channel],
            "collection_access": {
                "_default": {
                    "notes":         { "admin_channels": [&user_channel] },
                    "conversations": { "admin_channels": [&user_channel] },
                    "tasks":         { "admin_channels": [&user_channel] },
                    "actions":       { "admin_channels": [&user_channel] },
                    "chunks":        { "admin_channels": [&user_channel] },
                }
            }
        });
        let mut req = state.http
            .post(format!("{sg_url}/{sg_db}/_user/"))
            .json(&sg_user);
        if let Some(auth) = &state.sg_admin_auth {
            req = req.header("Authorization", auth);
        }
        if let Err(e) = req.send().await {
            eprintln!("SG private-db user creation failed (non-fatal): {e}");
        }
    }

    // ── Grant public-reader role in public SG database ────────────────────────
    if let (Some(sg_url), Some(pub_db)) = (&state.sg_admin_url, &state.sg_public_db) {
        grant_public_reader_role(&state.http, sg_url, pub_db, username, state.sg_admin_auth.as_deref()).await;
    }

    Ok((StatusCode::CREATED, Json(RegisterResponse { user_id: id })))
}

// ── User search ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub usernames: Vec<String>,
}

/// Grant the `public-reader` role to a user in the public SG database.
async fn grant_public_reader_role(
    http: &reqwest::Client,
    sg_url: &str,
    pub_db: &str,
    username: &str,
    admin_auth: Option<&str>,
) {
    // First ensure the user exists in the public DB (create if missing)
    let user_url = format!("{sg_url}/{pub_db}/_user/{username}");
    let body = serde_json::json!({
        "name": username,
        "admin_roles": ["public-reader"],
        "admin_channels": ["public"],
        "collection_access": {
            "_default": {
                "articles":         { "admin_channels": ["public"] },
                "templates":        { "admin_channels": ["public"] },
                "shared_knowledge": { "admin_channels": ["public"] },
                "chunks":           { "admin_channels": ["public"] },
            }
        }
    });
    let mut req = http.put(&user_url).json(&body);
    if let Some(a) = admin_auth { req = req.header("Authorization", a); }
    match req.send().await {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 200 || r.status().as_u16() == 201 =>
            println!("SG public-db: granted public-reader to '{username}'."),
        Ok(r) => eprintln!("SG public-db user grant failed for '{username}' ({}): {}", r.status(), r.text().await.unwrap_or_default()),
        Err(e) => eprintln!("SG public-db user grant request failed for '{username}': {e}"),
    }
}

/// GET /users/search?q=<prefix>
///
/// Returns up to 20 usernames whose names contain the query string.
/// Requires a valid Bearer JWT so only authenticated users can search.
pub async fn search_users(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchQuery>,
) -> Result<Json<SearchResponse>, AppError> {
    // Require authentication
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;
    let claims = validate_jwt(bearer, &state.jwt_secret).map_err(|_| AppError::Unauthorized)?;

    let q = params.q.unwrap_or_default();
    let q = q.trim().to_lowercase();

    // Query Couchbase for all user docs, filter by prefix match on username
    let bucket = &state.cb.bucket;
    let statement = format!(
        "SELECT username FROM `{bucket}` WHERE META().id LIKE 'user::%' LIMIT 200"
    );

    let rows: Vec<serde_json::Value> = state
        .cb
        .sqlpp(&statement, serde_json::json!({}))
        .await
        .unwrap_or_default();

    let caller = &claims.username;
    let usernames: Vec<String> = rows
        .into_iter()
        .filter_map(|r| r["username"].as_str().map(str::to_owned))
        .filter(|u| u != caller) // exclude the caller themselves
        .filter(|u| q.is_empty() || u.to_lowercase().contains(&q))
        .take(20)
        .collect();

    Ok(Json(SearchResponse { usernames }))
}
