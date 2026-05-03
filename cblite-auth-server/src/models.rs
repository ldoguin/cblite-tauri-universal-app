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
    pub sub: String,      // user_id
    pub username: String,
    pub exp: usize,       // Unix timestamp
    pub iss: String,      // issuer
    pub aud: String,      // audience
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

// ── KB facts ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum KbFactKind {
    Contact,
    Project,
    IgnorePattern,
    PriorityPattern,
    CustomInstruction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KbFact {
    pub id: String,
    pub kind: KbFactKind,
    /// JSON value — KbContact object, KbProject object, or plain string.
    pub value: serde_json::Value,
    pub confidence: f64,
    pub rationale: String,
    pub status: String, // "pending" | "approved" | "rejected"
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KbFactProposal {
    pub id: String,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub owner: String,
    pub source_event_id: String,
    pub source_event_title: String,
    pub source_worker: String,
    pub facts: Vec<KbFact>,
    pub created_at: String,
    pub updated_at: String,
}

/// Request body for POST /kb/apply
#[derive(Debug, Deserialize)]
pub struct KbApplyRequest {
    pub proposal_id: String,
    pub approved_fact_ids: Vec<String>,
    pub rejected_fact_ids: Vec<String>,
}

/// Minimal UserKnowledgeBase representation for merge operations.
/// Full structure is stored as raw JSON in SG; we only need to manipulate
/// the arrays we care about.
#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserKnowledgeBase {
    #[serde(rename = "type")]
    pub doc_type: String,
    pub owner: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contacts: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ignore_patterns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub priority_patterns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facts: Vec<KbFact>,
    #[serde(rename = "created_at", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(rename = "updated_at", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}
