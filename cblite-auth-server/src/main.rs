use axum::{
    routing::{get, post},
    Router,
};
use routes::ai;
use tower_http::cors::{Any, CorsLayer};
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use std::collections::HashMap;
use std::sync::Arc;

mod auth;
mod db;
mod error;
mod models;
mod routes;

use db::CouchbaseClient;

// ── Sync function types ───────────────────────────────────────────────────────

/// Sync functions keyed by scope → collection → JS function string.
/// Mirrors the SG Admin API scopes/collections config structure.
type SyncFunctions = HashMap<String, HashMap<String, String>>;

/// Load sync functions from a JSON file.
///
/// Expected format:
/// ```json
/// {
///   "_default": {
///     "notes":   "function(doc, oldDoc) { ... }",
///     "actions": "function(doc, oldDoc) { ... }"
///   }
/// }
/// ```
///
/// Panics with a clear message if the file is missing or contains invalid JSON.
fn load_sync_functions(path: &str) -> SyncFunctions {
    let content = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("ERROR: Failed to read sync function file '{path}': {e}");
        std::process::exit(1);
    });
    serde_json::from_str::<SyncFunctions>(&content).unwrap_or_else(|e| {
        eprintln!("ERROR: Invalid JSON in sync function file '{path}': {e}");
        std::process::exit(1);
    })
}

#[derive(Clone)]
pub struct AppState {
    pub cb: CouchbaseClient,
    pub jwt_secret: String,
    /// Optional: base URL of the SG Admin API, e.g. "http://localhost:4985"
    pub sg_admin_url: Option<String>,
    /// Optional: SG database name for the private bucket, e.g. "private-db"
    pub sg_db: Option<String>,
    /// Optional: SG database name for the public bucket, e.g. "public-db"
    pub sg_public_db: Option<String>,
    /// Optional: public WebSocket URL clients use for private replication
    pub sg_sync_url: Option<String>,
    /// Optional: public WebSocket URL clients use for public replication
    pub sg_public_sync_url: Option<String>,
    /// Optional: "Basic base64(user:pass)" header value for SG Admin API
    pub sg_admin_auth: Option<String>,
    pub http: reqwest::Client,
    /// Optional server-level OpenAI API key; overridden by a per-user key if supplied.
    pub openai_api_key: Option<String>,
    /// Optional OpenAI-compatible base URL (e.g. for Ollama or Azure); overridden per-request.
    pub openai_base_url: Option<String>,
    /// Model name for LLM calls (default: "gpt-4o-mini").
    pub openai_model: String,
    /// Name of the private Couchbase bucket (per-user scopes live here).
    pub private_bucket: String,
    /// Couchbase management REST URL for vector index creation, e.g. "http://localhost:8094"
    pub cb_search_url: String,
    /// "user:pass" for Couchbase REST auth (used for vector index management).
    pub cb_credentials: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let jwt_secret = std::env::var("JWT_SECRET")
        .expect("JWT_SECRET env var is required");
    if jwt_secret.len() < 32 {
        eprintln!("ERROR: JWT_SECRET must be at least 32 characters");
        std::process::exit(1);
    }

    // Couchbase Server connection
    let cb_uri      = std::env::var("COUCHBASE_URI").unwrap_or_else(|_| "couchbase://localhost".into());
    let cb_username = std::env::var("COUCHBASE_USERNAME").unwrap_or_else(|_| "Administrator".into());
    let cb_password = std::env::var("COUCHBASE_PASSWORD").unwrap_or_else(|_| "password".into());
    let cb_bucket   = std::env::var("COUCHBASE_BUCKET").unwrap_or_else(|_| "auth".into());

    let cb = CouchbaseClient::new(&cb_uri, &cb_username, &cb_password, &cb_bucket).await
        .expect("Failed to connect to Couchbase Cluster");
    db::ensure_bucket(&cb.cluster, &cb_bucket, 100).await;

    // Sync Gateway config
    let sg_admin_url  = std::env::var("SYNC_GATEWAY_ADMIN_URL").ok();
    let sg_admin_auth = std::env::var("SYNC_GATEWAY_ADMIN_AUTH").ok();

    // Private database (per-user scopes)
    let sg_db         = std::env::var("SG_PRIVATE_DB")
        .or_else(|_| std::env::var("SYNC_GATEWAY_DB"))
        .ok();
    let sg_sync_url   = std::env::var("SYNC_GATEWAY_SYNC_URL").ok();
    let private_bucket = std::env::var("PRIVATE_BUCKET").unwrap_or_else(|_| "private".into());

    // Public database (shared reference data)
    let sg_public_db       = std::env::var("SG_PUBLIC_DB").ok();
    let sg_public_sync_url = std::env::var("SG_PUBLIC_SYNC_URL").ok();
    let public_bucket      = std::env::var("PUBLIC_BUCKET").unwrap_or_else(|_| "public".into());

    // Couchbase search/management endpoint for vector index creation
    let cb_search_url  = std::env::var("CB_SEARCH_URL").unwrap_or_else(|_| "http://localhost:8094".into());
    let cb_credentials = format!("{cb_username}:{cb_password}");

    let http = reqwest::Client::new();

    // CORS origins forwarded to the SG database config so browsers can
    // connect via WebSocket BLIP.
    let cors_origins: Vec<String> = std::env::var("CORS_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cors_origins.is_empty() {
        eprintln!("Warning: CORS_ORIGINS not set — browser WebSocket connections to SG will be rejected.");
    }

    // Ensure auth-bucket indexes (needed for user search).
    db::ensure_indexes(&cb.cluster, &cb_bucket, &private_bucket).await;

    // Load external sync functions if env vars are set — fail loudly on error.
    let private_sync_fns: Option<SyncFunctions> = std::env::var("SG_PRIVATE_SYNC_FN")
        .ok()
        .map(|path| load_sync_functions(&path));
    let public_sync_fns: Option<SyncFunctions> = std::env::var("SG_PUBLIC_SYNC_FN")
        .ok()
        .map(|path| load_sync_functions(&path));

    if let Some(admin_url) = &sg_admin_url {
        // ── Private bucket + SG database ─────────────────────────────────────
        db::ensure_bucket(&cb.cluster, &private_bucket, 512).await;
        // _default scope collections still needed for legacy/migration path
        db::ensure_collection(&cb.cluster, &private_bucket, "_default", "notes").await;
        db::ensure_collection(&cb.cluster, &private_bucket, "_default", "conversations").await;
        db::ensure_collection(&cb.cluster, &private_bucket, "_default", "tasks").await;
        db::ensure_collection(&cb.cluster, &private_bucket, "_default", "actions").await;
        db::ensure_collection(&cb.cluster, &private_bucket, "_default", "chunks").await;
        db::ensure_collection(&cb.cluster, &private_bucket, "_default", "user_data").await;

        if let Some(db_name) = &sg_db {
            println!("SG private-db: {admin_url}/{db_name} | sync: {}", sg_sync_url.as_deref().unwrap_or("(not set)"));
            ensure_sg_private_database(&http, admin_url, db_name, &private_bucket, sg_admin_auth.as_deref(), &cors_origins, private_sync_fns.as_ref()).await;
        }

        // ── Public bucket + SG database ───────────────────────────────────────
        db::ensure_bucket(&cb.cluster, &public_bucket, 256).await;
        db::ensure_collection(&cb.cluster, &public_bucket, "_default", "articles").await;
        db::ensure_collection(&cb.cluster, &public_bucket, "_default", "templates").await;
        db::ensure_collection(&cb.cluster, &public_bucket, "_default", "shared_knowledge").await;
        db::ensure_collection(&cb.cluster, &public_bucket, "_default", "chunks").await;

        if let Some(pub_db) = &sg_public_db {
            println!("SG public-db: {admin_url}/{pub_db} | sync: {}", sg_public_sync_url.as_deref().unwrap_or("(not set)"));
            ensure_sg_public_database(&http, admin_url, pub_db, &public_bucket, sg_admin_auth.as_deref(), &cors_origins, public_sync_fns.as_ref()).await;
        }
    }

    let sg_admin_auth_header = sg_admin_auth
        .as_deref()
        .map(|a| format!("Basic {}", base64_encode(a)));

    let openai_api_key  = std::env::var("OPENAI_API_KEY").ok();
    let openai_base_url = std::env::var("OPENAI_BASE_URL").ok();
    let openai_model    = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());

    let state = AppState {
        cb,
        jwt_secret,
        sg_admin_url,
        sg_db,
        sg_public_db,
        sg_sync_url,
        sg_public_sync_url,
        sg_admin_auth: sg_admin_auth_header,
        http,
        openai_api_key,
        openai_base_url,
        openai_model,
        private_bucket,
        cb_search_url,
        cb_credentials,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Rate-limit auth endpoints: 5 requests per IP per minute (burst of 5).
    let auth_rate_limiter = Arc::new(
        GovernorConfigBuilder::default()
            .per_second(12)   // replenish 1 token every 12 s → 5/min steady state
            .burst_size(5)
            .finish()
            .expect("invalid rate limiter config"),
    );

    let auth_router = Router::new()
        .route("/auth/token", post(routes::sync::login))
        .route("/auth/refresh", post(routes::sync::refresh_token))
        .layer(GovernorLayer { config: auth_rate_limiter });

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/users", post(routes::users::register))
        .route("/users/search", get(routes::users::search_users))
        .merge(auth_router)
        .route("/sync/config", get(routes::sync::get_sync_config))
        .route("/ai/chat", post(ai::chat))
        .route("/boards/:board_id/members", post(routes::boards::add_member))
        .route("/kb", get(routes::kb::get_kb))
        .route("/kb/apply", post(routes::kb::apply_facts))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    println!("cblite-auth-server listening on http://0.0.0.0:3000");
    axum::serve(listener, app).await?;

    Ok(())
}

// ── SG database helpers ───────────────────────────────────────────────────────

fn sg_db_exists_check(status: u16) -> Option<bool> {
    if (200..300).contains(&status) { return Some(true); }
    if status == 403 || status == 404 { return Some(false); }
    None
}

async fn sg_put_db(http: &reqwest::Client, url: &str, body: &serde_json::Value, auth: Option<&str>) -> bool {
    let mut req = http.put(url).json(body);
    if let Some(a) = auth { req = req.header("Authorization", format!("Basic {}", base64_encode(a))); }
    match req.send().await {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 412 || r.status().as_u16() == 409 => true,
        Ok(r) => { eprintln!("SG PUT {url} failed ({}): {}", r.status(), r.text().await.unwrap_or_default()); false }
        Err(e) => { eprintln!("SG PUT {url} error: {e}"); false }
    }
}

async fn sg_update_cors_and_sync_fns(
    http: &reqwest::Client,
    admin_url: &str,
    db_name: &str,
    cors_config: &serde_json::Value,
    coll_sync_pairs: &[(&str, &str)],
    admin_auth: Option<&str>,
) {
    let config_url = format!("{admin_url}/{db_name}/_config");
    let cors_body = serde_json::json!({ "cors": cors_config });
    let mut req = http.put(&config_url).json(&cors_body);
    if let Some(a) = admin_auth { req = req.header("Authorization", format!("Basic {}", base64_encode(a))); }
    match req.send().await {
        Ok(r) if r.status().is_success() => println!("SG CORS updated for '{db_name}'."),
        Ok(r) => eprintln!("SG CORS update failed ({}): {}", r.status(), r.text().await.unwrap_or_default()),
        Err(e) => eprintln!("SG CORS update error: {e}"),
    }

    for (coll, sfn) in coll_sync_pairs {
        let url = format!("{admin_url}/{db_name}/_config/scopes/_default/collections/{coll}");
        let body = serde_json::json!({ "sync": sfn });
        let mut req = http.put(&url).json(&body);
        if let Some(a) = admin_auth { req = req.header("Authorization", format!("Basic {}", base64_encode(a))); }
        match req.send().await {
            Ok(r) if r.status().is_success() => println!("SG sync fn updated for '{db_name}'/_default/{coll}."),
            Ok(r) => eprintln!("SG sync fn update failed for {coll} ({}): {}", r.status(), r.text().await.unwrap_or_default()),
            Err(e) => eprintln!("SG sync fn update error for {coll}: {e}"),
        }
    }
}

/// Ensure the private SG database exists (per-user channel routing).
///
/// `external_fns`: optional map loaded from `SG_PRIVATE_SYNC_FN`. When a
/// collection key is present its value overrides the built-in default.
async fn ensure_sg_private_database(
    http: &reqwest::Client,
    admin_url: &str,
    db_name: &str,
    bucket_name: &str,
    admin_auth: Option<&str>,
    cors_origins: &[String],
    external_fns: Option<&SyncFunctions>,
) {
    let db_url = format!("{admin_url}/{db_name}/");
    let mut get_req = http.get(&db_url);
    if let Some(a) = admin_auth { get_req = get_req.header("Authorization", format!("Basic {}", base64_encode(a))); }

    let db_exists = match get_req.send().await {
        Err(e) => { eprintln!("SG unreachable, skipping private-db check: {e}"); return; }
        Ok(r) => match sg_db_exists_check(r.status().as_u16()) {
            Some(v) => v,
            None => { eprintln!("SG private-db check: unexpected status {}", r.status()); return; }
        }
    };

    // ── Default sync functions ────────────────────────────────────────────────
    // local_only guard: reject push of documents flagged as device-only.
    let user_sync_fn = "function(doc,oldDoc){\
        if(doc.local_only===true)throw({forbidden:'local_only document'});\
        var o=doc.owner||(oldDoc&&oldDoc.owner);\
        if(!o)throw({forbidden:'missing owner'});\
        requireUser(o);requireAccess('user.'+o);channel('user.'+o);\
    }";
    let tasks_sync_fn = "function(doc,oldDoc){\
        if(doc.local_only===true)throw({forbidden:'local_only document'});\
        var bid=doc.board_id||(oldDoc&&oldDoc.board_id);\
        if(!bid)throw({forbidden:'missing board_id'});\
        requireAccess('board.'+bid);\
        channel('board.'+bid);\
        if(doc.type==='board'){var members=doc.members||[];for(var i=0;i<members.length;i++){channel('user.'+members[i]);}}\
    }";
    let chunks_sync_fn = "function(doc,oldDoc){\
        if(doc.local_only===true)throw({forbidden:'local_only document'});\
        var o=doc.source_owner||(oldDoc&&oldDoc.source_owner);\
        if(!o)throw({forbidden:'missing source_owner'});\
        requireUser(o);requireAccess('user.'+o);channel('user.'+o);\
    }";

    // Helper: resolve a sync function — external file overrides default.
    let resolve = |coll: &str, default: &str| -> String {
        external_fns
            .and_then(|fns| fns.get("_default"))
            .and_then(|colls| colls.get(coll))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };

    let cors_config = serde_json::json!({
        "origin": cors_origins, "login_origin": cors_origins, "headers": ["Authorization"]
    });

    let default_fn    = resolve("_default",      user_sync_fn);
    let notes_fn      = resolve("notes",         user_sync_fn);
    let convs_fn      = resolve("conversations", user_sync_fn);
    let tasks_fn      = resolve("tasks",         tasks_sync_fn);
    let actions_fn    = resolve("actions",       user_sync_fn);
    let chunks_fn     = resolve("chunks",        chunks_sync_fn);
    let user_data_fn  = resolve("user_data",     user_sync_fn);

    let coll_sync_pairs: Vec<(&str, String)> = vec![
        ("_default",      default_fn.clone()),
        ("notes",         notes_fn.clone()),
        ("conversations", convs_fn.clone()),
        ("tasks",         tasks_fn.clone()),
        ("actions",       actions_fn.clone()),
        ("chunks",        chunks_fn.clone()),
        ("user_data",     user_data_fn.clone()),
    ];
    // Convert to &str pairs for the helper
    let coll_sync_refs: Vec<(&str, &str)> = coll_sync_pairs.iter()
        .map(|(k, v)| (*k, v.as_str()))
        .collect();

    if db_exists {
        sg_update_cors_and_sync_fns(http, admin_url, db_name, &cors_config, &coll_sync_refs, admin_auth).await;
    } else {
        let scopes_config = serde_json::json!({
            "_default": { "collections": {
                "_default":      { "sync": default_fn },
                "notes":         { "sync": notes_fn },
                "conversations": { "sync": convs_fn },
                "tasks":         { "sync": tasks_fn },
                "actions":       { "sync": actions_fn },
                "chunks":        { "sync": chunks_fn },
                "user_data":     { "sync": user_data_fn },
            }}
        });
        let body = serde_json::json!({
            "bucket": bucket_name, "num_index_replicas": 0,
            "cors": cors_config, "scopes": scopes_config,
            "import_docs": true, "enable_shared_bucket_access": true
        });
        if sg_put_db(http, &db_url, &body, admin_auth).await {
            println!("SG private-db '{db_name}' created (bucket: '{bucket_name}').");
        }
    }
}

/// Ensure the public SG database exists (role-based read, admin write only).
///
/// `external_fns`: optional map loaded from `SG_PUBLIC_SYNC_FN`. When a
/// collection key is present its value overrides the built-in default.
async fn ensure_sg_public_database(
    http: &reqwest::Client,
    admin_url: &str,
    db_name: &str,
    bucket_name: &str,
    admin_auth: Option<&str>,
    cors_origins: &[String],
    external_fns: Option<&SyncFunctions>,
) {
    let db_url = format!("{admin_url}/{db_name}/");
    let mut get_req = http.get(&db_url);
    if let Some(a) = admin_auth { get_req = get_req.header("Authorization", format!("Basic {}", base64_encode(a))); }

    let db_exists = match get_req.send().await {
        Err(e) => { eprintln!("SG unreachable, skipping public-db check: {e}"); return; }
        Ok(r) => match sg_db_exists_check(r.status().as_u16()) {
            Some(v) => v,
            None => { eprintln!("SG public-db check: unexpected status {}", r.status()); return; }
        }
    };

    // Default: all public docs go to the "public" channel; read-only for authenticated users.
    let public_read_sync_fn = "function(doc,oldDoc){channel('public');}";

    // Helper: resolve a sync function — external file overrides default.
    let resolve = |coll: &str, default: &str| -> String {
        external_fns
            .and_then(|fns| fns.get("_default"))
            .and_then(|colls| colls.get(coll))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };

    let articles_fn        = resolve("articles",         public_read_sync_fn);
    let templates_fn       = resolve("templates",        public_read_sync_fn);
    let shared_fn          = resolve("shared_knowledge", public_read_sync_fn);
    let chunks_fn          = resolve("chunks",           public_read_sync_fn);

    let cors_config = serde_json::json!({
        "origin": cors_origins, "login_origin": cors_origins, "headers": ["Authorization"]
    });

    let coll_sync_pairs: Vec<(&str, String)> = vec![
        ("articles",         articles_fn.clone()),
        ("templates",        templates_fn.clone()),
        ("shared_knowledge", shared_fn.clone()),
        ("chunks",           chunks_fn.clone()),
    ];
    let coll_sync_refs: Vec<(&str, &str)> = coll_sync_pairs.iter()
        .map(|(k, v)| (*k, v.as_str()))
        .collect();

    if db_exists {
        sg_update_cors_and_sync_fns(http, admin_url, db_name, &cors_config, &coll_sync_refs, admin_auth).await;
    } else {
        let scopes_config = serde_json::json!({
            "_default": { "collections": {
                "articles":         { "sync": articles_fn },
                "templates":        { "sync": templates_fn },
                "shared_knowledge": { "sync": shared_fn },
                "chunks":           { "sync": chunks_fn },
            }}
        });
        let body = serde_json::json!({
            "bucket": bucket_name, "num_index_replicas": 0,
            "cors": cors_config, "scopes": scopes_config,
            "import_docs": true, "enable_shared_bucket_access": true,
            "guest_enabled": false
        });
        if sg_put_db(http, &db_url, &body, admin_auth).await {
            println!("SG public-db '{db_name}' created (bucket: '{bucket_name}').");
            ensure_sg_role(http, admin_url, db_name, "public-reader", &["public"], admin_auth).await;
        }
    }
}

/// Ensure a named SG role exists with the given admin channels.
async fn ensure_sg_role(
    http: &reqwest::Client,
    admin_url: &str,
    db_name: &str,
    role_name: &str,
    channels: &[&str],
    admin_auth: Option<&str>,
) {
    let url = format!("{admin_url}/{db_name}/_role/{role_name}");
    let body = serde_json::json!({ "name": role_name, "admin_channels": channels });
    let mut req = http.put(&url).json(&body);
    if let Some(a) = admin_auth { req = req.header("Authorization", format!("Basic {}", base64_encode(a))); }
    match req.send().await {
        Ok(r) if r.status().is_success() || r.status().as_u16() == 200 || r.status().as_u16() == 201 =>
            println!("SG role '{role_name}' ensured in '{db_name}'."),
        Ok(r) => eprintln!("SG role '{role_name}' upsert failed ({}): {}", r.status(), r.text().await.unwrap_or_default()),
        Err(e) => eprintln!("SG role '{role_name}' request failed: {e}"),
    }
}

fn base64_encode(s: &str) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, s.as_bytes())
}
