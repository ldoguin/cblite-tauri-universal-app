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
