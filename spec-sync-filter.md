# Spec: Generic Sync Filters — Unsynced Collections, SG Sync Functions, Plugin Cleanup

## Problem Statement

The current implementation has two issues:

1. **Tauri plugin is not generic**: `start_replication` accepts a `push_filter_rule: "exclude_local_only"` string that hardcodes a field name inside the Rust plugin. The plugin should have no knowledge of application-level document fields.

2. **SG sync functions are hardcoded in Rust**: The auth server embeds sync function strings directly in `main.rs`. They cannot be customised without recompiling the server.

The solution uses two independent mechanisms:
- **Primary guard**: `local_only` documents stay in their existing collection but that collection is **excluded from the replicator** — they never enter the replication pipeline at all.
- **Secondary guard**: The SG sync function (loaded from an external JSON file) throws `forbidden` when `local_only === true`, as a server-side safety net.
- **Plugin cleanup**: Remove `push_filter_rule` entirely from the Tauri plugin, making it fully generic.

---

## Requirements

### 1. Tauri Plugin — Remove `push_filter_rule`

- Remove the `push_filter_rule: Option<String>` parameter from `start_replication` in `commands.rs`.
- Remove all `apply_push_filter` / `push_filter` closure logic from `commands.rs`.
- Remove `pushFilterRule` from the `invoke` call in `guest-js/index.ts`.
- Remove the `pushFilter` parameter from the `startReplication` TypeScript signature in `guest-js/index.ts`.
- Remove the `pushFilterRule` parameter from the `startReplication` wrapper in `tauri-cblite-example/src/main.ts`.
- The plugin remains fully generic — it knows nothing about document fields.

### 2. Collection-Based Local Isolation

- `local_only` documents remain in their existing collection (e.g. `actions`, `chunks`).
- The replicator is configured to **exclude** collections that contain local-only documents from the replicator's collection list — controlled entirely by the app, not the plugin.
- In `packages/shared/src/app.ts`, the `startAllReplicators` function already controls which collections are passed to `startReplication`. The app simply omits any collection it wants to keep local.
- No plugin changes required for this — it is purely an app-level concern.

### 3. SG Sync Function — External JSON File

The auth server loads sync functions from an external JSON file instead of hardcoding them.

#### File format

One JSON file per SG database. Structure mirrors the SG Admin API scopes/collections config:

```json
{
  "_default": {
    "notes":         "function(doc, oldDoc) { ... }",
    "conversations": "function(doc, oldDoc) { ... }",
    "tasks":         "function(doc, oldDoc) { ... }",
    "actions":       "function(doc, oldDoc) { ... }",
    "chunks":        "function(doc, oldDoc) { ... }"
  }
}
```

- Keys at the top level are CB scope names.
- Keys at the second level are collection names.
- Values are raw JS sync function strings (exactly what SG's `"sync"` field accepts).

#### Auth server behaviour

- Two env vars point to the sync function files:
  - `SG_PRIVATE_SYNC_FN` — path to the JSON file for `private-db`
  - `SG_PUBLIC_SYNC_FN` — path to the JSON file for `public-db`
- If an env var is set but the file does not exist or cannot be parsed → **fail loudly** (log error + panic / exit 1).
- If an env var is not set → use the current hardcoded default sync functions (backwards compatible).
- The file is read **once at startup** (not hot-reloaded).
- The loaded sync functions replace the hardcoded strings in `ensure_sg_private_database` and `ensure_sg_public_database`.

#### SG sync function safety net for `local_only`

The default (and any custom) sync function for collections that may contain `local_only` documents must include a guard:

```javascript
function(doc, oldDoc) {
  // Reject push of local-only documents — these must never reach the server.
  if (doc.local_only === true) { throw({ forbidden: 'local_only document' }); }
  // ... rest of sync logic
}
```

This guard is included in the **default** sync functions shipped with the auth server. Custom files loaded via `SG_PRIVATE_SYNC_FN` / `SG_PUBLIC_SYNC_FN` are the operator's responsibility.

---

## Acceptance Criteria

1. **Plugin is generic**: `start_replication` in `commands.rs` has no `push_filter_rule` parameter and no document-field-specific logic.
2. **Guest JS is clean**: `startReplication` in `guest-js/index.ts` has no `pushFilter` or `pushFilterRule` parameters.
3. **App wrapper is clean**: `startReplication` in `tauri-cblite-example/src/main.ts` has no `pushFilterRule` argument.
4. **SG sync functions load from file**: When `SG_PRIVATE_SYNC_FN` is set to a valid JSON file, the auth server uses those sync functions instead of the hardcoded defaults.
5. **Missing file fails loudly**: If `SG_PRIVATE_SYNC_FN` or `SG_PUBLIC_SYNC_FN` is set but the file is missing or invalid JSON, the auth server exits with a clear error message.
6. **Unset env var uses defaults**: If neither env var is set, behaviour is identical to today.
7. **local_only guard in defaults**: The default sync functions for `actions` and `chunks` collections include the `local_only === true` → `forbidden` guard.
8. **No regression**: Existing replication behaviour (auth, collections, channels, direction) is unchanged.

---

## Implementation Steps

1. **`commands.rs`**: Remove `push_filter_rule` parameter. Remove `apply_push_filter` variable and all `push_filter` closure blocks. All `ReplicationCollection` entries get `push_filter: None`.

2. **`guest-js/index.ts`**: Remove `pushFilter` parameter from `startReplication`. Remove `pushFilterRule` constant and its `invoke` field.

3. **`tauri-cblite-example/src/main.ts`**: Remove `pushFilterRule` from the `_startReplication` call in the local `startReplication` wrapper. Remove the `pushFilter` parameter.

4. **`cblite-auth-server/src/main.rs`**: Add `load_sync_functions(path: &str) -> HashMap<String, HashMap<String, String>>` — reads and parses the JSON file, panics with a clear message on failure.

5. **`cblite-auth-server/src/main.rs`**: In `main()`, read `SG_PRIVATE_SYNC_FN` and `SG_PUBLIC_SYNC_FN` env vars. If set, call `load_sync_functions` and store results. Pass loaded (or default) sync functions into `ensure_sg_private_database` and `ensure_sg_public_database`.

6. **`cblite-auth-server/src/main.rs`**: Update `ensure_sg_private_database` and `ensure_sg_public_database` signatures to accept `sync_fns: &HashMap<String, HashMap<String, String>>`. Use provided functions when present, fall back to hardcoded defaults per collection when a collection key is absent.

7. **`cblite-auth-server/src/main.rs`**: Add `local_only` guard to the **default** sync function strings for `actions` and `chunks` collections.

8. **`.env.example`**: Document `SG_PRIVATE_SYNC_FN` and `SG_PUBLIC_SYNC_FN` with an example file path and a note about the expected JSON format.

9. **`docker-compose.yml`**: Add `SG_PRIVATE_SYNC_FN` and `SG_PUBLIC_SYNC_FN` env vars to the `auth-server` service (commented out by default). Add a volume mount example for `/config/sync-fns/`.
