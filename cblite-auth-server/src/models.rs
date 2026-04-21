use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub password_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserSyncConfig {
    pub user_id: String,
    pub sync_url: String,
    pub sync_collection: String,
    pub sync_direction: String,
}

/// JWT claims
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,   // user_id
    pub username: String,
    pub exp: usize,    // Unix timestamp
}
