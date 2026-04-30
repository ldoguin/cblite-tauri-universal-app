use axum::{
    extract::State,
    http::{header::AUTHORIZATION, HeaderMap},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{create_jwt, validate_jwt, verify_password},
    error::AppError,
    models::{User, UserSyncConfig, SyncEntry, SyncConfigs},
    routes::boards::grant_board_channel,
    AppState,
};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Legacy single-db sync config (kept for backwards compatibility).
#[derive(Serialize)]
pub struct SyncConfigResponse {
    pub sync_url: String,
    pub sync_collection: String,
    pub sync_direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_cookie_name: Option<String>,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    /// Legacy single-db config (private db) — kept for existing clients.
    pub sync_config: SyncConfigResponse,
    /// Dual-db config — new clients should use this.
    pub sync_configs: SyncConfigs,
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AppError> {
    let user: User = state.cb
        .get(&format!("user::{}", body.username.trim()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    let valid = verify_password(&body.password, &user.password_hash)
        .map_err(anyhow::Error::from)?;
    if !valid {
        return Err(AppError::Unauthorized);
    }

    let token = create_jwt(&user.id, &user.username, &state.jwt_secret)
        .map_err(anyhow::Error::from)?;

    let cfg: Option<UserSyncConfig> = state.cb
        .get(&format!("sync_config::{}", user.id))
        .await?;

    let (gateway_session_id, gateway_cookie_name) =
        create_sg_session(&state, &user.username, &body.password).await;

    let private_sync_url = cfg.as_ref()
        .map(|c| c.sync_url.clone())
        .unwrap_or_else(|| state.sg_sync_url.clone().unwrap_or_default());
    let private_collection = cfg.as_ref()
        .map(|c| c.sync_collection.clone())
        .unwrap_or_else(|| "_default.notes".into());

    let sync_config = SyncConfigResponse {
        sync_url: private_sync_url.clone(),
        sync_collection: private_collection.clone(),
        sync_direction: "both".into(),
        gateway_session_id: gateway_session_id.clone(),
        gateway_cookie_name: gateway_cookie_name.clone(),
    };

    let sync_configs = SyncConfigs {
        private: SyncEntry {
            sync_url: private_sync_url,
            sync_collection: private_collection,
            sync_direction: "both".into(),
            gateway_session_id: gateway_session_id.clone(),
            gateway_cookie_name: gateway_cookie_name.clone(),
        },
        public: SyncEntry {
            sync_url: state.sg_public_sync_url.clone().unwrap_or_default(),
            sync_collection: "_default.articles".into(),
            sync_direction: "pull".into(),
            gateway_session_id: None,
            gateway_cookie_name: None,
        },
    };

    Ok(Json(LoginResponse { token, sync_config, sync_configs }))
}

async fn create_sg_session(
    state: &AppState,
    username: &str,
    password: &str,
) -> (Option<String>, Option<String>) {
    let (Some(sg_url), Some(sg_db)) = (&state.sg_admin_url, &state.sg_db) else {
        return (None, None);
    };

    // Ensure the SG user exists (idempotent PUT); handles DB resets without requiring re-registration.
    ensure_sg_user(state, sg_url, sg_db, username, password).await;

    // Re-grant board channels the user is a member of (handles SG resets).
    regrant_board_channels(state, username).await;

    let body = serde_json::json!({ "name": username });
    let mut req = state.http
        .post(format!("{}/{}/_session", sg_url, sg_db))
        .json(&body);
    if let Some(auth) = &state.sg_admin_auth {
        req = req.header("Authorization", auth);
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => { eprintln!("SG session creation failed (non-fatal): {e}"); return (None, None); }
    };

    if !res.status().is_success() {
        eprintln!("SG session creation returned {}", res.status());
        return (None, None);
    }

    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => { eprintln!("SG session response parse failed: {e}"); return (None, None); }
    };

    (
        json["session_id"].as_str().map(str::to_owned),
        json["cookie_name"].as_str().map(str::to_owned),
    )
}

/// Upsert the SG user (PUT is idempotent). Called at login to recover from SG database resets.
async fn ensure_sg_user(state: &AppState, sg_url: &str, sg_db: &str, username: &str, password: &str) {
    let user_channel = format!("user.{username}");
    let sg_user = serde_json::json!({
        "password": password,
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
        .put(format!("{}/{}/_user/{}", sg_url, sg_db, username))
        .json(&sg_user);
    if let Some(auth) = &state.sg_admin_auth {
        req = req.header("Authorization", auth);
    }
    match req.send().await {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 200 || r.status().as_u16() == 201 => {}
        Ok(r) => eprintln!("SG user upsert returned {} for '{username}'", r.status()),
        Err(e) => eprintln!("SG user upsert failed for '{username}': {e}"),
    }
}

/// Query Couchbase Server for all boards where the user is a member and
/// re-grant the corresponding `board.<id>` channels on Sync Gateway.
/// Called at login to recover from SG database resets.
async fn regrant_board_channels(state: &AppState, username: &str) {
    if state.sg_admin_url.is_none() || state.sg_db.is_none() {
        return;
    }

    // The notes bucket (same as sg_db name) stores board documents.
    let sg_bucket = state.sg_db.as_deref().unwrap_or("notes");
    let statement = format!(
        "SELECT META().id AS id FROM `{sg_bucket}`.`_default`.`tasks` \
         WHERE type = 'board' AND (owner = $username OR ANY m IN members SATISFIES m = $username END)"
    );

    let rows: Vec<serde_json::Value> = match state
        .cb
        .sqlpp(&statement, serde_json::json!({ "$username": username }))
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[regrant_board_channels] query failed (non-fatal): {e}");
            return;
        }
    };

    for row in rows {
        if let Some(board_id) = row["id"].as_str() {
            grant_board_channel(state, username, board_id).await;
        }
    }
}

pub async fn get_sync_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SyncConfigResponse>, AppError> {
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;

    let claims = validate_jwt(bearer, &state.jwt_secret)
        .map_err(|_| AppError::Unauthorized)?;

    let cfg: UserSyncConfig = state.cb
        .get(&format!("sync_config::{}", claims.sub))
        .await?
        .ok_or(AppError::NotFound)?;

    Ok(Json(SyncConfigResponse {
        sync_url: cfg.sync_url,
        sync_collection: cfg.sync_collection,
        sync_direction: cfg.sync_direction,
        gateway_session_id: None,
        gateway_cookie_name: None,
    }))
}
