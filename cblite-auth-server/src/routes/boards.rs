use axum::{
    extract::{Path, State},
    http::header::AUTHORIZATION,
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{auth::validate_jwt, error::AppError, AppState};

#[derive(Deserialize)]
pub struct AddMemberRequest {
    pub username: String,
}

#[derive(Serialize)]
pub struct AddMemberResponse {
    pub ok: bool,
}

/// POST /boards/:boardId/members
///
/// Grants the specified user access to the board's SG channel (`board.<boardId>`).
/// The caller must be authenticated (Bearer JWT) and a member of the board.
pub async fn add_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(board_id): Path<String>,
    Json(body): Json<AddMemberRequest>,
) -> Result<Json<AddMemberResponse>, AppError> {
    // Validate JWT
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;

    let claims = validate_jwt(bearer, &state.jwt_secret).map_err(|_| AppError::Unauthorized)?;

    // Reject obviously invalid board IDs before hitting the DB.
    if Uuid::parse_str(&board_id).is_err() {
        return Err(AppError::BadRequest("invalid board_id".into()));
    }

    let new_member = body.username.trim().to_owned();
    if new_member.is_empty() {
        return Err(AppError::BadRequest("username is required".into()));
    }

    // Verify the target user exists before granting access.
    let user_key = format!("user::{new_member}");
    if state.cb.get::<serde_json::Value>(&user_key).await?.is_none() {
        return Err(AppError::NotFound);
    }

    // Verify the caller is already a member of this board and re-read the
    // current member list atomically so we don't grant based on stale data.
    // Board documents live in the `tasks` collection.
    #[derive(serde::Deserialize)]
    struct BoardRow { members: Option<Vec<String>> }
    let rows: Vec<BoardRow> = state.cb
        .sqlpp(
            "SELECT members FROM tasks WHERE META().id = $id AND type = 'board'",
            serde_json::json!({ "$id": board_id }),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let board = rows.into_iter().next().ok_or(AppError::NotFound)?;
    let members = board.members.unwrap_or_default();
    if !members.iter().any(|m| m == &claims.username) {
        return Err(AppError::Unauthorized);
    }

    // Grant board channel access on Sync Gateway (best-effort)
    grant_board_channel(&state, &new_member, &board_id).await;

    Ok(Json(AddMemberResponse { ok: true }))
}

/// Add `board.<board_id>` to the SG user's channels via the Admin API.
/// Uses PUT /{db}/_user/{username} to merge the new channel into existing ones.
pub async fn grant_board_channel(state: &AppState, username: &str, board_id: &str) {
    let (Some(sg_url), Some(sg_db)) = (&state.sg_admin_url, &state.sg_db) else {
        return;
    };

    let board_channel = format!("board.{board_id}");
    let user_channel = format!("user.{username}");
    let sg_timeout = std::time::Duration::from_secs(10);

    // Fetch current user to merge channels rather than overwrite.
    // URL-encode the username to prevent path traversal.
    let encoded_username = urlencoding::encode(username);
    let user_url = format!("{sg_url}/{sg_db}/_user/{encoded_username}");
    let mut get_req = state.http.get(&user_url).timeout(sg_timeout);
    if let Some(auth) = &state.sg_admin_auth {
        get_req = get_req.header("Authorization", auth);
    }

    let existing_channels: Vec<String> = match get_req.send().await {
        Ok(r) if r.status().is_success() => {
            let json: serde_json::Value = r.json().await.unwrap_or_default();
            json["admin_channels"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default()
        }
        _ => vec![user_channel.clone()],
    };

    let mut channels = existing_channels;
    if !channels.contains(&board_channel) {
        channels.push(board_channel.clone());
    }

    // Build collection_access — preserve existing tasks channel grants and add board channel
    let sg_user = serde_json::json!({
        "admin_channels": &channels,
        "collection_access": {
            "_default": {
                "notes":         { "admin_channels": [&user_channel] },
                "conversations": { "admin_channels": [&user_channel] },
                "tasks":         { "admin_channels": channels },
                "actions":       { "admin_channels": [&user_channel] },
                "chunks":        { "admin_channels": [&user_channel] },
                "user_data":     { "admin_channels": [&user_channel] },
            }
        }
    });

    let mut put_req = state.http.put(&user_url).timeout(sg_timeout).json(&sg_user);
    if let Some(auth) = &state.sg_admin_auth {
        put_req = put_req.header("Authorization", auth);
    }
    match put_req.send().await {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 200 || r.status().as_u16() == 201 => {
            println!("SG: granted channel '{board_channel}' to user '{username}'.");
        }
        Ok(r) => eprintln!(
            "SG: grant board channel failed for '{username}' ({}): {}",
            r.status(),
            r.text().await.unwrap_or_default()
        ),
        Err(e) => eprintln!("SG: grant board channel request failed for '{username}': {e}"),
    }
}
