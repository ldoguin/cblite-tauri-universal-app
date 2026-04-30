use anyhow::anyhow;
use couchbase::cluster::Cluster;
use couchbase::collection::Collection;
use couchbase::error::ErrorKind;
use couchbase::options::cluster_options::ClusterOptions;
use couchbase::authenticator::PasswordAuthenticator;
use couchbase::options::kv_options::{GetOptions, InsertOptions, UpsertOptions};
use couchbase::options::query_options::QueryOptions;
use couchbase::management::buckets::bucket_settings::{BucketSettings, BucketType};
use futures::TryStreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

/// Couchbase Client using official Rust SDK
#[derive(Clone)]
pub struct CouchbaseClient {
    pub cluster: Cluster,
    pub bucket: String,
    pub collection: Collection,
}

impl CouchbaseClient {
    pub async fn new(uri: &str, username: &str, password: &str, bucket: &str) -> anyhow::Result<Self> {
        let authenticator = PasswordAuthenticator::new(username, password);
        let cluster_options = ClusterOptions::new(authenticator.into());
        let cluster = Cluster::connect(
            uri,
            cluster_options,
        )
        .await?;

        let bucket_handle = cluster.bucket(bucket);
        bucket_handle.wait_until_ready(None).await?;

        let collection = bucket_handle.default_collection();

        Ok(CouchbaseClient {
            cluster,
            bucket: bucket.to_owned(),
            collection,
        })
    }

    /// Execute a SQL++ statement. Named parameters are passed as top-level keys
    /// in `params` (e.g. `{"$key": "user::alice"}`).
    pub async fn sqlpp<T: DeserializeOwned>(
        &self,
        statement: &str,
        params: Value,
    ) -> anyhow::Result<Vec<T>> {
        let mut options = QueryOptions::default();

        if let Value::Object(map) = params {
            for (k, v) in map {
                if k.starts_with('$') {
                    options = options
                        .add_named_parameter(k, v)
                        .map_err(|e| anyhow!("query named param error: {e}"))?;
                }
            }
        }

        let mut result = self.cluster.query(statement, options).await?;
        let out: Vec<T> = result.rows::<T>().try_collect().await?;
        Ok(out)
    }

    /// Get a document by its key. Returns `None` if not found.
    pub async fn get<T: DeserializeOwned>(&self, key: &str) -> anyhow::Result<Option<T>> {
        match self.collection.get(key, GetOptions::default()).await {
            Ok(doc) => Ok(Some(doc.content_as::<T>()?)),
            Err(ref e) if matches!(e.kind(), ErrorKind::DocumentNotFound) => Ok(None),
            Err(e) => Err(anyhow!("Get failed: {}", e)),
        }
    }

    /// Insert a document; returns `Err` if the key already exists.
    pub async fn insert(&self, key: &str, value: &impl serde::Serialize) -> anyhow::Result<()> {
        self.collection
            .insert(key, value, InsertOptions::default())
            .await?;
        Ok(())
    }

    /// Upsert a document (create or replace).
    pub async fn upsert(&self, key: &str, value: &impl serde::Serialize) -> anyhow::Result<()> {
        self.collection
            .upsert(key, value, UpsertOptions::default())
            .await?;
        Ok(())
    }
}

/// Ensure a named Couchbase bucket exists, creating it if necessary.
/// `ram_mb` is the RAM quota in megabytes (minimum 100).
/// Non-fatal: logs errors but does not abort startup.
pub async fn ensure_bucket(cluster: &Cluster, bucket_name: &str, ram_mb: u32) {
    let buckets_mgr = cluster.buckets();

    match buckets_mgr.get_bucket(bucket_name, None).await {
        Ok(_) => {
            println!("CB bucket '{}' already exists.", bucket_name);
        }
        Err(_) => {
            println!("Creating CB bucket '{}' ({} MB)...", bucket_name, ram_mb);

            let settings = BucketSettings::new(bucket_name)
                .bucket_type(BucketType::COUCHBASE)
                .ram_quota_mb(ram_mb as u64)
                .num_replicas(0)
                .flush_enabled(true);

            match buckets_mgr.create_bucket(settings, None).await {
                Ok(_) => {
                    println!("CB bucket '{}' created successfully.", bucket_name);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                Err(e) => {
                    eprintln!("CB bucket '{}' creation failed: {}", bucket_name, e);
                }
            }
        }
    }
}

/// Ensure required N1QL indexes exist, creating them if missing.
///
/// Called once at startup. Uses `CREATE INDEX IF NOT EXISTS` so it is safe to
/// run on every boot. Indexes are created in the background (`WITH {"defer_build": false}`
/// is the default) so the server does not block waiting for them to build.
pub async fn ensure_indexes(cluster: &Cluster, auth_bucket: &str, notes_bucket: &str) {
    // Primary index on the auth bucket — needed for the user search query
    // (`SELECT username FROM auth WHERE META().id LIKE 'user::%'`).
    let stmts: &[(&str, &str)] = &[
        // Auth bucket: primary index so ad-hoc queries work during development,
        // plus a covering index on username for the search endpoint.
        (
            "auth_primary",
            &format!(
                "CREATE PRIMARY INDEX IF NOT EXISTS `auth_primary` ON `{auth_bucket}` WITH {{\"num_replica\": 0}}"
            ),
        ),
        (
            "auth_username",
            &format!(
                "CREATE INDEX IF NOT EXISTS `auth_username` ON `{auth_bucket}`(username) WHERE META().id LIKE 'user::%' WITH {{\"num_replica\": 0}}"
            ),
        ),
        // Notes bucket / tasks collection: index on board_id + type for board queries.
        (
            "tasks_board_type",
            &format!(
                "CREATE INDEX IF NOT EXISTS `tasks_board_type` \
                 ON `{notes_bucket}`.`_default`.`tasks`(board_id, type) \
                 WITH {{\"num_replica\": 0}}"
            ),
        ),
        // Notes bucket / tasks collection: index on members array for board membership queries.
        (
            "tasks_members",
            &format!(
                "CREATE INDEX IF NOT EXISTS `tasks_members` \
                 ON `{notes_bucket}`.`_default`.`tasks`(DISTINCT ARRAY m FOR m IN members END, owner, type) \
                 WITH {{\"num_replica\": 0}}"
            ),
        ),
        // Actions collection: index on owner + scheduled_date for per-user daily queries.
        (
            "actions_owner_date",
            &format!(
                "CREATE INDEX IF NOT EXISTS `actions_owner_date` \
                 ON `{notes_bucket}`.`_default`.`actions`(owner, scheduled_date, type) \
                 WITH {{\"num_replica\": 0}}"
            ),
        ),
    ];

    for (name, stmt) in stmts {
        let options = couchbase::options::query_options::QueryOptions::default();
        match cluster.query(stmt, options).await {
            Ok(_) => println!("Index '{name}' ensured."),
            Err(e) => eprintln!("Index '{name}' creation failed (non-fatal): {e}"),
        }
    }
}

/// Ensure a named collection exists within a bucket's scope, creating it if necessary.
pub async fn ensure_collection(
    cluster: &Cluster,
    bucket_name: &str,
    scope_name: &str,
    collection_name: &str,
) {
    let bucket = cluster.bucket(bucket_name);
    let collections_mgr = bucket.collections();

    match collections_mgr.get_all_scopes(None).await {
        Ok(scopes) => {
            if let Some(scope) = scopes.iter().find(|s| s.name() == scope_name) {
                if scope.collections().iter().any(|c| c.name() == collection_name) {
                    println!("CB collection '{}.{}' already exists.", scope_name, collection_name);
                    return;
                }
            } else {
                if let Err(e) = collections_mgr.create_scope(scope_name, None).await {
                    eprintln!("Failed to create scope '{}': {}", scope_name, e);
                    return;
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to list scopes: {}", e);
            return;
        }
    }

    match collections_mgr.create_collection(scope_name, collection_name, None, None).await {
        Ok(_) => {
            println!("CB collection '{}.{}' created.", scope_name, collection_name);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Err(e) => {
            eprintln!("CB collection '{}.{}' creation failed: {}", scope_name, collection_name, e);
        }
    }
}

/// Ensure a per-user private scope exists in the private bucket with all required collections.
///
/// Creates the CB scope named after the username and the five standard collections
/// (`notes`, `conversations`, `tasks`, `actions`, `chunks`) inside it.
pub async fn ensure_private_scope(cluster: &Cluster, private_bucket: &str, username: &str) {
    let collections = ["notes", "conversations", "tasks", "actions", "chunks"];
    for coll in &collections {
        ensure_collection(cluster, private_bucket, username, coll).await;
    }
}

/// Ensure a Couchbase vector search index exists on the server_embedding field
/// of the user's chunks collection in the private bucket.
///
/// Uses the REST management API since the Rust SDK does not yet expose vector
/// index management. Non-fatal — logs errors but does not abort startup.
pub async fn ensure_vector_index(
    http: &reqwest::Client,
    cb_mgmt_url: &str,
    cb_auth: &str,
    private_bucket: &str,
    username: &str,
) {
    let index_name = format!("idx_chunks_server_embedding_{}", username.replace(|c: char| !c.is_alphanumeric(), "_"));
    let url = format!("{cb_mgmt_url}/api/bucket/{private_bucket}/scope/{username}/index/{index_name}");

    // Check if index already exists
    let check = http.get(&url)
        .header("Authorization", format!("Basic {}", base64_encode(cb_auth)))
        .send().await;
    if let Ok(r) = check {
        if r.status().is_success() {
            println!("Vector index '{index_name}' already exists.");
            return;
        }
    }

    // serde_json::json! does not support dynamic keys — build the types map separately.
    let scope_collection_key = format!("{username}.chunks");
    let type_mapping = serde_json::json!({
        "dynamic": false,
        "enabled": true,
        "properties": {
            "server_embedding": {
                "dynamic": false,
                "enabled": true,
                "fields": [{
                    "dims": 3072,
                    "index": true,
                    "name": "server_embedding",
                    "similarity": "dot_product",
                    "type": "vector",
                    "vector_index_optimized_for": "recall"
                }]
            }
        }
    });
    let mut types_map = serde_json::Map::new();
    types_map.insert(scope_collection_key, type_mapping);

    let body = serde_json::json!({
        "type": "fulltext-index",
        "name": index_name,
        "sourceType": "gocbcore",
        "sourceName": private_bucket,
        "params": {
            "doc_config": {
                "docid_prefix_delim": "",
                "docid_regexp": "",
                "mode": "scope.collection.type_field",
                "type_field": "type"
            },
            "mapping": {
                "default_analyzer": "standard",
                "default_datetime_parser": "dateTimeOptional",
                "default_field": "_all",
                "default_mapping": { "dynamic": false, "enabled": false },
                "default_type": "_default",
                "docvalues_dynamic": false,
                "index_dynamic": false,
                "store_dynamic": false,
                "type_field": "_type",
                "types": serde_json::Value::Object(types_map)
            },
            "store": { "indexType": "scorch", "segmentVersion": 16 }
        },
        "sourceParams": {}
    });

    match http.put(&url)
        .header("Authorization", format!("Basic {}", base64_encode(cb_auth)))
        .json(&body)
        .send().await
    {
        Ok(r) if r.status().is_success() =>
            println!("Vector index '{index_name}' created for user '{username}'."),
        Ok(r) => eprintln!(
            "Vector index creation failed for '{username}' ({}): {}",
            r.status(), r.text().await.unwrap_or_default()
        ),
        Err(e) => eprintln!("Vector index request failed for '{username}': {e}"),
    }
}

fn base64_encode(s: &str) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, s.as_bytes())
}
