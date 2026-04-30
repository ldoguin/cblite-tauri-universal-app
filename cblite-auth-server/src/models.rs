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

/// Per-database sync config returned to the client.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncEntry {
    pub sync_url: String,
    pub sync_collection: String,
    pub sync_direction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_cookie_name: Option<String>,
}

/// Dual sync config: one entry for the public database, one for the private database.
#[derive(Debug, Serialize, Deserialize)]
pub struct SyncConfigs {
    pub public: SyncEntry,
    pub private: SyncEntry,
}
