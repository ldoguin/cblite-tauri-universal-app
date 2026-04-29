use axum::{
    routing::{get, post},
    Router,
};
use routes::ai;
use tower_http::cors::{Any, CorsLayer};

mod auth;
mod db;
mod error;
mod models;
mod routes;

use db::CouchbaseClient;

#[derive(Clone)]
pub struct AppState {
    pub cb: CouchbaseClient,
    pub jwt_secret: String,
    /// Optional: base URL of the SG Admin API, e.g. "http://localhost:4985"
    pub sg_admin_url: Option<String>,
    /// Optional: SG database name, e.g. "notes"
    pub sg_db: Option<String>,
    /// Optional: public WebSocket URL clients use for replication, e.g. "ws://localhost:4984/notes"
    pub sg_sync_url: Option<String>,
    /// Optional: "Basic base64(user:pass)" header value for SG Admin API
    pub sg_admin_auth: Option<String>,
    pub http: reqwest::Client,
    /// Optional server-level OpenAI API key; overridden by a per-user key if supplied.
    pub openai_api_key: Option<String>,
    /// Optional OpenAI-compatible base URL (e.g. for Ollama or Azure); overridden per-request.
    pub openai_base_url: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let jwt_secret = std::env::var("JWT_SECRET")
        .expect("JWT_SECRET env var is required");

    // Couchbase Server connection
    let cb_uri      = std::env::var("COUCHBASE_URI").unwrap_or_else(|_| "couchbase://localhost".into());
    let cb_username = std::env::var("COUCHBASE_USERNAME").unwrap_or_else(|_| "Administrator".into());
    let cb_password = std::env::var("COUCHBASE_PASSWORD").unwrap_or_else(|_| "password".into());
    let cb_bucket   = std::env::var("COUCHBASE_BUCKET").unwrap_or_else(|_| "auth".into());

    let cb = CouchbaseClient::new(&cb_uri, &cb_username, &cb_password, &cb_bucket).await
        .expect("Failed to connect to Couchbase Cluster");
    db::ensure_bucket(&cb.cluster, &cb_bucket, 100).await;

    // Sync Gateway config
    let sg_admin_url = std::env::var("SYNC_GATEWAY_ADMIN_URL").ok();
    let sg_db        = std::env::var("SYNC_GATEWAY_DB").ok();
    let sg_sync_url  = std::env::var("SYNC_GATEWAY_SYNC_URL").ok();
    let sg_bucket    = std::env::var("SYNC_GATEWAY_BUCKET").ok().or_else(|| sg_db.clone());
    let sg_admin_auth = std::env::var("SYNC_GATEWAY_ADMIN_AUTH").ok();

    let http = reqwest::Client::new();

    // CORS origins forwarded to the SG database config so browsers can
    // connect via WebSocket BLIP.  Use "*" to allow all origins (works in SG 4.x),
    // or a comma-separated list of exact origins for stricter control,
    // e.g. "http://localhost:5173,https://myapp.com".
    let cors_origins: Vec<String> = std::env::var("CORS_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cors_origins.is_empty() {
        eprintln!("Warning: CORS_ORIGINS not set — browser WebSocket connections to SG will be rejected. Set CORS_ORIGINS=* or list specific origins.");
    }

    // Always ensure auth-bucket indexes (needed for user search).
    // Pass the auth bucket as both arguments when SG is not configured so the
    // function still creates the primary + username indexes.
    let notes_bucket_for_index = sg_db.as_deref().unwrap_or(&cb_bucket).to_owned();
    db::ensure_indexes(&cb.cluster, &cb_bucket, &notes_bucket_for_index).await;

    if let (Some(admin_url), Some(db_name)) = (&sg_admin_url, &sg_db) {
        println!(
            "SG Admin API: {}/{} | sync: {}",
            admin_url,
            db_name,
            sg_sync_url.as_deref().unwrap_or("(not set)")
        );

        // Ensure the Couchbase bucket that SG will use also exists
        let notes_bucket = sg_bucket.as_deref().unwrap_or(db_name.as_str());
        db::ensure_bucket(&cb.cluster, notes_bucket, 256).await;
        db::ensure_collection(&cb.cluster, notes_bucket, "_default", "notes").await;
        db::ensure_collection(&cb.cluster, notes_bucket, "_default", "conversations").await;
        db::ensure_collection(&cb.cluster, notes_bucket, "_default", "tasks").await;
        db::ensure_collection(&cb.cluster, notes_bucket, "_default", "actions").await;

        ensure_sg_database(&http, admin_url, db_name, sg_bucket.as_deref(), sg_admin_auth.as_deref(), &cors_origins).await;
    }

    let sg_admin_auth_header = sg_admin_auth
        .as_deref()
        .map(|a| format!("Basic {}", base64_encode(a)));

    let openai_api_key = std::env::var("OPENAI_API_KEY").ok();
    let openai_base_url = std::env::var("OPENAI_BASE_URL").ok();

    let state = AppState {
        cb,
        jwt_secret,
        sg_admin_url,
        sg_db,
        sg_sync_url,
        sg_admin_auth: sg_admin_auth_header,
        http,
        openai_api_key,
        openai_base_url,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/users", post(routes::users::register))
        .route("/users/search", get(routes::users::search_users))
        .route("/auth/token", post(routes::sync::login))
        .route("/sync/config", get(routes::sync::get_sync_config))
        .route("/ai/chat", post(ai::chat))
        .route("/boards/:board_id/members", post(routes::boards::add_member))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    println!("cblite-auth-server listening on http://0.0.0.0:3000");
    axum::serve(listener, app).await?;

    Ok(())
}

/// Ensure the Sync Gateway database exists with the correct config.
/// Creates the database if missing; updates the config if it already exists,
/// then triggers a resync so existing documents are routed to the right channels.
async fn ensure_sg_database(
    http: &reqwest::Client,
    admin_url: &str,
    db_name: &str,
    bucket: Option<&str>,
    admin_auth: Option<&str>,
    cors_origins: &[String],
) {
    // SG requires a trailing slash on the database URL; without it SG returns 301
    // and reqwest won't re-issue a PUT after a redirect.
    let db_url = format!("{}/{}/", admin_url, db_name);

    let mut get_req = http.get(&db_url);
    if let Some(auth) = admin_auth {
        get_req = get_req.header("Authorization", format!("Basic {}", base64_encode(auth)));
    }

    let db_exists = match get_req.send().await {
        Err(e) => { eprintln!("SG unreachable, skipping database check: {e}"); return; }
        Ok(r) if r.status().is_success() => true,
        // SG returns 403 for non-existent databases; treat as "not found".
        Ok(r) if r.status().as_u16() == 403 || r.status().as_u16() == 404 => false,
        Ok(r) => { eprintln!("SG check: unexpected status {}", r.status()); return; }
    };

    let bucket_name = bucket.unwrap_or(db_name);
    // Named collections require per-collection sync functions in SG 3.x.
    // notes/conversations: routed to "user.<owner>" so users only see their own docs.
    let user_sync_fn = "function(doc,oldDoc){var o=doc.owner||(oldDoc&&oldDoc.owner);if(!o)throw({forbidden:'missing owner'});requireUser(o);channel('user.'+o);}";
    // tasks: routed to "board.<boardId>"; board docs also fan out to each member's personal channel.
    let tasks_sync_fn = "function(doc,oldDoc){\
        var bid=doc.board_id||(oldDoc&&oldDoc.board_id);\
        if(!bid)throw({forbidden:'missing board_id'});\
        channel('board.'+bid);\
        if(doc.type==='board'){\
            var members=doc.members||[];\
            for(var i=0;i<members.length;i++){channel('user.'+members[i]);}\
        }\
    }";

    // SG docs: wildcards don't work for authenticated connections; use explicit origins.
    // Both "origin" and "login_origin" are required for browser BLIP over WebSocket.
    let cors_config = serde_json::json!({
        "origin": cors_origins,
        "login_origin": cors_origins,
        "headers": ["Authorization"]
    });

    // actions: routed to "user.<owner>" so each user only sees their own action items.
    let actions_sync_fn = "function(doc,oldDoc){var o=doc.owner||(oldDoc&&oldDoc.owner);if(!o)throw({forbidden:'missing owner'});requireUser(o);channel('user.'+o);}";

    let scopes_config = serde_json::json!({
        "_default": {
            "collections": {
                "_default":      { "sync": user_sync_fn },
                "notes":         { "sync": user_sync_fn },
                "conversations": { "sync": user_sync_fn },
                "tasks":         { "sync": tasks_sync_fn },
                "actions":       { "sync": actions_sync_fn }
            }
        }
    });

    // Full body used only when creating a brand-new database.
    let create_body = serde_json::json!({
        "bucket": bucket_name,
        "num_index_replicas": 0,
        "cors": cors_config,
        "scopes": scopes_config,
        "import_docs": true,
        "enable_shared_bucket_access": true
    });

    if db_exists {
        let config_url = format!("{}/{}/_config", admin_url, db_name);

        // CORS: PUT /{db}/_config with only the cors key (no scopes — scopes are
        // immutable after creation and must not appear in update requests).
        if !cors_origins.is_empty() {
            let cors_body = serde_json::json!({ "cors": cors_config });
            let mut req = http.put(&config_url).json(&cors_body);
            if let Some(auth) = admin_auth {
                req = req.header("Authorization", format!("Basic {}", base64_encode(auth)));
            }
            match req.send().await {
                Ok(r) if r.status().is_success() =>
                    println!("SG CORS config updated for '{db_name}'."),
                Ok(r) => eprintln!("SG CORS update failed ({}): {}", r.status(), r.text().await.unwrap_or_default()),
                Err(e) => eprintln!("SG CORS update request failed: {e}"),
            }
        }

        // Sync functions: SG 3.x forbids changing scopes via PUT /{db}/_config
        // after creation. Use per-collection endpoints instead.
        let coll_sync_pairs: &[(&str, &str)] = &[
            ("_default",      user_sync_fn),
            ("notes",         user_sync_fn),
            ("conversations", user_sync_fn),
            ("tasks",         tasks_sync_fn),
            ("actions",       actions_sync_fn),
        ];
        for (coll, sfn) in coll_sync_pairs {
            let coll_url = format!(
                "{}/{}/_config/scopes/_default/collections/{}",
                admin_url, db_name, coll
            );
            let body = serde_json::json!({ "sync": sfn });
            let mut req = http.put(&coll_url).json(&body);
            if let Some(auth) = admin_auth {
                req = req.header("Authorization", format!("Basic {}", base64_encode(auth)));
            }
            match req.send().await {
                Ok(r) if r.status().is_success() =>
                    println!("SG sync function updated for '{db_name}'/_default/{coll}."),
                Ok(r) => eprintln!("SG sync fn update failed for {coll} ({}): {}", r.status(), r.text().await.unwrap_or_default()),
                Err(e) => eprintln!("SG sync fn update request failed for {coll}: {e}"),
            }
        }
    } else {
        // Create the database.
        let mut put_req = http.put(&db_url).json(&create_body);
        if let Some(auth) = admin_auth {
            put_req = put_req.header("Authorization", format!("Basic {}", base64_encode(auth)));
        }
        match put_req.send().await {
            Ok(r) if r.status().is_success() || r.status().as_u16() == 412 || r.status().as_u16() == 409 => {
                println!("SG database '{db_name}' created (bucket: '{bucket_name}').");
            }
            Ok(r) => {
                let s = r.status();
                eprintln!("SG database creation failed ({s}): {}", r.text().await.unwrap_or_default());
            }
            Err(e) => eprintln!("SG database creation request failed: {e}"),
        }
    }
}

fn base64_encode(s: &str) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, s.as_bytes())
}
