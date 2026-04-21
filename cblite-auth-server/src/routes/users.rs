use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{auth::hash_password, error::AppError, models::User, AppState};

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

    // Create the user on Sync Gateway (best-effort)
    if let (Some(sg_url), Some(sg_db)) = (&state.sg_admin_url, &state.sg_db) {
        // In SG 3.x, top-level admin_channels only applies to _default._default.
        // Named collections require explicit collection_access entries.
        let user_channel = format!("user.{username}");
        let sg_user = serde_json::json!({
            "name": username,
            "password": body.password,
            "admin_channels": [&user_channel],
            "collection_access": {
                "_default": {
                    "notes":         { "admin_channels": [&user_channel] },
                    "conversations": { "admin_channels": [&user_channel] },
                }
            }
        });
        let mut req = state.http
            .post(format!("{}/{}/_user/", sg_url, sg_db))
            .json(&sg_user);
        if let Some(auth) = &state.sg_admin_auth {
            req = req.header("Authorization", auth);
        }
        if let Err(e) = req.send().await {
            eprintln!("SG user creation failed (non-fatal): {e}");
        }
    }

    Ok((StatusCode::CREATED, Json(RegisterResponse { user_id: id })))
}
