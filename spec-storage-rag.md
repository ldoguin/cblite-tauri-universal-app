# Spec: Public/Private Buckets, Local-Only Data, and RAG Pipeline

## Problem Statement

The current architecture uses a single Couchbase bucket (`notes`) with a single Sync Gateway database. All user data lives in shared collections, isolated only by SG channel routing. This needs to evolve into:

1. **Two Couchbase buckets** — `public` (shared/reference data) and `private` (per-user data with a CB scope per user).
2. **Two Sync Gateway databases** — one per bucket, with different access models.
3. **Local-only documents** — some data written by workers or the app must never leave the device (flagged on the document).
4. **Chunking and vectorization** — documents flagged for embedding are chunked, then embedded in two dimensions: small local model (WASM/ONNX in Tauri) for on-device search, large server model (e.g. `text-embedding-3-large`) for server-side RAG. Workers chunk and embed before writing to SG.
5. **RAG consumption** — both workers (to enrich LLM prompts before action extraction) and the in-app AI chat use the vector stores.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Couchbase Server                                                │
│                                                                 │
│  ┌──────────────────────┐   ┌──────────────────────────────┐   │
│  │  Bucket: public      │   │  Bucket: private             │   │
│  │  Scope: _default     │   │  Scope: alice  Scope: bob    │   │
│  │  Collections:        │   │  Collections (per scope):    │   │
│  │   - articles         │   │   - notes                    │   │
│  │   - templates        │   │   - conversations            │   │
│  │   - shared_knowledge │   │   - tasks                    │   │
│  │   - chunks (vectors) │   │   - actions                  │   │
│  └──────────┬───────────┘   │   - chunks (vectors)         │   │
│             │               └──────────────┬───────────────┘   │
└─────────────┼──────────────────────────────┼───────────────────┘
              │                              │
    ┌─────────▼──────────┐       ┌───────────▼──────────┐
    │  SG: public-db     │       │  SG: private-db      │
    │  Role-based read   │       │  Per-user channels   │
    │  Admin write only  │       │  user.<username>     │
    └─────────┬──────────┘       └───────────┬──────────┘
              │                              │
              └──────────────┬───────────────┘
                             │ CBLite replication
                    ┌────────▼────────┐
                    │  CBLite (local) │
                    │  public-db      │
                    │  private-db     │
                    │  (local_only    │
                    │   docs never    │
                    │   replicated)   │
                    └─────────────────┘
```

### Worker data flow (chunking + embedding)

```
Source event
    │
    ▼
worker-core Poller
    │
    ├─► extractActions (LLM) ◄── ragContext (server vector search)
    │
    ▼
ActionItemDraft  (vectorize: true?)
    │
    ├── sync_mode: "synced" ──► ChunkWriter
    │                               │
    │                               ├─ chunkText()          (chunker.ts)
    │                               ├─ ServerEmbedder.embed() (embedder.ts)
    │                               └─ SgWriter.writeChunks() → private-db
    │
    └── sync_mode: "local" ──► LocalWriter → CBLite only (no SG)
```

---

## Requirements

### 1. Couchbase Bucket & Scope Structure

#### Public Bucket (`public`)
- Single CB scope: `_default`
- Collections: `articles`, `templates`, `shared_knowledge`, `chunks`
- Written by: admins (via auth server admin routes) and workers (future — shared/aggregated data)
- Read by: all authenticated users with the `public-reader` SG role

#### Private Bucket (`private`)
- One CB **scope per user**, named after the username (e.g. `alice`, `bob`)
- Each scope contains the same fixed set of collections: `notes`, `conversations`, `tasks`, `actions`, `chunks`
- Scope + collections created at **registration** by the auth server
- SG channels: `user.<username>` — users only see their own scope's data

### 2. Sync Gateway Databases

#### `public-db` (maps to `public` bucket)
- Guest access: **disabled**
- Access control: role `public-reader` grants read on channel `public`
- Write access: admin API only (no user writes via SG)
- Sync function: routes all docs to channel `public`; requires `public-writer` role to write

#### `private-db` (maps to `private` bucket)
- Access control: per-user channel `user.<username>`
- Sync function per collection: `channel('user.' + doc.owner)` — same pattern as current `notes`/`actions`
- SG scopes config: one entry per user scope (dynamically added at registration)

### 3. Local-Only Documents

- A document with `"local_only": true` is **never included in any replicator**.
- The CBLite replicator push filter excludes documents where `local_only === true`.
- Workers set `local_only: true` on `ActionItemDoc` when `sync_mode === "local"`.
- `local_only` docs are written directly to CBLite via a new `LocalWriter` class, bypassing SG entirely.

### 4. Worker Sync Mode

`ActionItemDoc` and `ActionItemDraft` gain new fields:

```typescript
// On ActionItemDraft (worker output)
sync_mode?: "local" | "synced";  // default: "synced"
vectorize?: boolean;              // default: false

// On ActionItemDoc (written to storage)
sync_mode: "local" | "synced";
local_only: boolean;              // true when sync_mode === "local"
vectorize: boolean;
```

- `sync_mode: "synced"` → `SgWriter` writes to `private-db` via SG (current behaviour).
- `sync_mode: "local"` → `LocalWriter` writes directly to CBLite; doc never reaches SG.

### 5. Chunking and Vectorization

#### Document eligibility
- Any document with `"vectorize": true` is eligible for chunking.
- Documents with `encryption_mode === "app-level"` are **never vectorized** (no chunks produced).
- Workers set `vectorize: true` on drafts when the content warrants it.

#### Chunking strategy
- **Chunk size**: 512 tokens with 64-token overlap (configurable via `CHUNK_SIZE`, `CHUNK_OVERLAP` env vars).
- Sentence-aware splitter: split on sentence boundaries, respect max token count.
- Each chunk stored as a `ChunkDoc` in the `chunks` collection of the relevant bucket/scope.

```typescript
interface ChunkDoc {
  id: string;                  // "chunk::<sourceDocId>::<index>"
  type: "chunk";
  source_id: string;           // ID of the parent document
  source_collection: string;   // e.g. "notes", "actions"
  source_owner: string;
  chunk_index: number;
  text: string;                // plaintext chunk content
  local_embedding?: number[];  // float32[], ~384 dims (MiniLM) — set by Tauri app
  server_embedding?: number[]; // float32[], ~3072 dims (text-embedding-3-large) — set by workers
  created_at: string;
  updated_at: string;
}
```

#### Worker chunking + server embedding flow
Workers process `vectorize: true` documents as follows **before writing to SG**:

1. `chunkText(body, chunkSize, overlap)` → `string[]`
2. For each chunk: `ServerEmbedder.embed(chunkText)` → `number[]` (calls OpenAI embeddings API)
3. Construct `ChunkDoc` with `server_embedding` populated, `local_embedding` omitted
4. `SgWriter.writeChunks(chunkDocs, username)` → writes chunk docs to `private-db` chunks collection
5. Write the parent `ActionItemDoc` to `private-db` as normal

#### Local embedding (Tauri app)
- Model: path from `VITE_LOCAL_EMBEDDING_MODEL_PATH` env var; if unset, downloads `all-MiniLM-L6-v2` (ONNX quantized, ~23 MB) from HuggingFace on first use, cached in `appLocalDataDir()/models/`.
- Runtime: `@xenova/transformers` (Transformers.js) in a dedicated Web Worker.
- Triggered: **on document save, in background** — save completes immediately; embedding is queued.
- On completion: app saves/updates chunk docs with `local_embedding` field populated.
- Encrypted docs (`encryption_mode === "app-level"`): **no chunks produced, no embedding**.

#### Server embedding config
- Model: `EMBEDDING_MODEL` env var (default: `text-embedding-3-large`)
- Endpoint: `OPENAI_BASE_URL` env var (default: `https://api.openai.com/v1`) — same variable used by the LLM calls, so a single base URL switch (e.g. to Ollama or Azure OpenAI) covers both chat completions and embeddings.
- Auth: `OPENAI_API_KEY` env var — same key as LLM calls.
- `ServerEmbedder` constructs the embeddings URL as `${OPENAI_BASE_URL}/embeddings`.
- Couchbase vector search index created on `private.<username>.chunks.server_embedding` at registration.

### 6. RAG Pipeline

#### Server RAG (workers)
- Before calling `extractActions`, workers call `retrieveContext(eventText, username, config)`.
- `retrieveContext`: embeds the event text via `ServerEmbedder`, runs Couchbase vector search on `private.<username>.chunks`, returns top-K chunks as a formatted string.
- Top-K: `RAG_TOP_K` env var (default: 5).
- Result injected into the LLM prompt between the KB section and the event content.
- `extractActions` signature: add `ragContext?: string` parameter.

#### Local RAG (app AI chat)
- On user message: embed query locally (WASM) → CBLite vector similarity search on `chunks` → top-K chunks → injected into AI chat system prompt.
- CBLite vector index on `local_embedding` field in `chunks` collection.
- Fallback: if no local embedding available, BM25 FTS on `text` field.
- Top-K: default 5.

### 7. Auth Server Changes

At **registration** (`POST /users`):
1. Create CB scope `<username>` in the `private` bucket.
2. Create collections `notes`, `conversations`, `tasks`, `actions`, `chunks` in that scope.
3. Create Couchbase vector search index on `private.<username>.chunks.server_embedding`.
4. Create SG user in `private-db` with channel `user.<username>` and collection access for all 5 collections.
5. Grant `public-reader` role in `public-db`.
6. Existing `auth` bucket user record and `sync_config` unchanged.

At **login** (`POST /auth/token`):
- Return sync configs for **both** databases:
  ```json
  {
    "token": "...",
    "sync_configs": {
      "public": { "sync_url": "...", "sync_collection": "...", "sync_direction": "pull" },
      "private": { "sync_url": "...", "sync_collection": "...", "sync_direction": "both", "gateway_session_id": "..." }
    }
  }
  ```

### 8. App (CBLite) Changes

#### Replication
- Two replicators:
  - `public-db`: pull-only, continuous.
  - `private-db`: push+pull, continuous, push filter excludes `local_only === true`.

#### Vector index
- On database open, ensure CBLite vector index on `_default.chunks.local_embedding` (cosine similarity).

#### Embedding worker
- `EmbeddingWorker` (Web Worker) initialized at app startup.
- Handles `embed` messages: `{ docId, text, collection }` → `{ docId, embedding: number[] }`.
- App main thread saves chunk docs with `local_embedding` on receipt.

---

## Acceptance Criteria

1. **Bucket isolation**: Public and private data live in separate CB buckets. A user cannot access another user's private scope via SG.
2. **Per-user scope**: Registering `alice` creates CB scope `alice` in `private` bucket with all 5 collections.
3. **Public read**: Any registered user can pull from `public-db`. Only admins can write to it.
4. **Local-only docs**: A document with `local_only: true` exists in CBLite but never appears in SG or Couchbase Server.
5. **Worker sync_mode**: `sync_mode: "local"` → CBLite only; `sync_mode: "synced"` → SG as today.
6. **Worker chunking**: A worker writing a `vectorize: true` doc produces chunk docs with `server_embedding` populated in SG before the parent doc is written.
7. **Local embedding**: Chunk docs in CBLite have a populated `local_embedding` field after background embedding completes.
8. **Local RAG**: App AI chat retrieves relevant chunks via CBLite vector search and includes them in the LLM prompt.
9. **Server RAG**: Workers call `retrieveContext` and the returned chunks appear in the `extractActions` prompt.
10. **Encrypted doc exclusion**: Documents with `encryption_mode === "app-level"` produce no chunk docs and no embeddings.
11. **Model download**: If `VITE_LOCAL_EMBEDDING_MODEL_PATH` is unset, the app downloads and caches the model on first use without blocking the UI.
12. **Login response**: Login returns sync configs for both `public-db` and `private-db`.

---

## Implementation Steps

### Phase 1 — Couchbase & SG topology

1. **`cblite-auth-server/src/db.rs`**: Add `ensure_private_scope(cluster, username)` — creates CB scope + 5 collections in `private` bucket.
2. **`cblite-auth-server/src/db.rs`**: Add `ensure_vector_index(cluster, username)` — creates Couchbase vector search index on `private.<username>.chunks.server_embedding`.
3. **`cblite-auth-server/src/main.rs`**: Update startup to create both `public` and `private` buckets, `public-db` and `private-db` SG databases with correct sync functions and roles.
4. **`cblite-auth-server/src/routes/users.rs`**: Call `ensure_private_scope` + `ensure_vector_index` + SG user creation in both databases at registration.
5. **`cblite-auth-server/src/models.rs`**: Add `SyncConfigsResponse` with `public` and `private` fields.
6. **`cblite-auth-server/src/routes/sync.rs`**: Update login response to return `sync_configs` (both databases).
7. **`docker-compose.yml`** + **`.env.example`**: Add `PUBLIC_BUCKET`, `PRIVATE_BUCKET`, `SG_PUBLIC_DB`, `SG_PRIVATE_DB` env vars.

### Phase 2 — Local-only documents

8. **`packages/worker-core/src/types.ts`**: Add `sync_mode`, `local_only`, `vectorize` to `ActionItemDraft` and `ActionItemDoc`.
9. **`packages/worker-core/src/local-writer.ts`**: New `LocalWriter` class — writes docs directly to CBLite via `@couchbase/lite-js`.
10. **`packages/worker-core/src/poller.ts`**: Route `sync_mode === "local"` drafts to `LocalWriter`, `"synced"` to `SgWriter`.
11. **`packages/shared/src/app.ts`**: Add push filter to `private-db` replicator excluding `local_only === true`. Start two replicators (public pull + private push/pull).

### Phase 3 — Worker chunking + server embedding

12. **`packages/worker-core/src/chunker.ts`**: `chunkText(text, chunkSize, overlap): string[]` — sentence-aware splitter.
13. **`packages/worker-core/src/embedder.ts`**: `ServerEmbedder` class — calls OpenAI-compatible embeddings endpoint, returns `number[]`.
14. **`packages/worker-core/src/chunk-writer.ts`**: `ChunkWriter` class — chunks a document, embeds each chunk, writes `ChunkDoc` array to SG chunks collection before the parent doc.
15. **`packages/worker-core/src/sg-writer.ts`**: Add `writeChunks(chunkDocs, username)` method.
16. **`packages/worker-core/src/poller.ts`**: For `vectorize: true` synced drafts, call `ChunkWriter` before `SgWriter`.
17. **`packages/worker-core/src/config.ts`**: Parse `EMBEDDING_MODEL`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `RAG_TOP_K` into `BaseWorkerConfig`.
18. **`packages/worker-core/src/index.ts`**: Export new classes.

### Phase 4 — Server RAG

19. **`packages/worker-core/src/rag.ts`**: `retrieveContext(eventText, username, config): Promise<string>` — embeds query, runs Couchbase vector search, returns formatted top-K chunks.
20. **`packages/worker-core/src/llm.ts`**: Accept `ragContext?: string`; inject into prompt between KB section and event content.
21. **`packages/worker-core/src/poller.ts`**: Call `retrieveContext` before `extractActions` when RAG is configured.

### Phase 5 — Local embedding (Tauri app)

22. **`packages/shared/src/embedding-worker.ts`**: Web Worker — loads ONNX model via `@xenova/transformers`, handles `embed` messages, returns float32 array.
23. **`packages/shared/src/local-embedder.ts`**: Main-thread `LocalEmbedder` — manages the Web Worker, queues requests, resolves promises. Downloads model if `VITE_LOCAL_EMBEDDING_MODEL_PATH` unset.
24. **`packages/shared/src/chunker.ts`**: Browser-compatible text chunker (same logic as worker-core).
25. **`packages/shared/src/storage.ts`**: Add `saveChunkDoc`, `ensureVectorIndex` helpers.
26. **`packages/shared/src/app.ts`**: After document save, enqueue embedding job; on completion, save chunk docs with `local_embedding`.

### Phase 6 — Local RAG (app chat)

27. **`packages/shared/src/rag.ts`**: `retrieveLocalContext(query, adapter, embedder): Promise<string>` — embeds query locally, runs CBLite vector search on `chunks`, returns top-K formatted chunks.
28. **`packages/shared/src/ai.ts`**: Call `retrieveLocalContext` and inject result into AI chat system prompt.

### Phase 7 — Config & docs

29. **`.env.example`**: Document `EMBEDDING_MODEL`, `OPENAI_BASE_URL` (note: shared with LLM — one URL configures both chat completions and embeddings), `OPENAI_API_KEY`, `RAG_TOP_K`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `VITE_LOCAL_EMBEDDING_MODEL_PATH`, `PUBLIC_BUCKET`, `PRIVATE_BUCKET`, `SG_PUBLIC_DB`, `SG_PRIVATE_DB`.
