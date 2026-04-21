# cblite-uni-app

A monorepo demonstrating Couchbase Lite across multiple platforms from a shared TypeScript codebase. Includes a desktop/Android Tauri app, a pure-browser web app, and an optional Rust authentication server with Sync Gateway integration.

---

## Repository layout

```
cblite-uni-app/
├── packages/
│   ├── shared/              # @cblite-uni-app/shared   — app logic, UI components, styles
│   └── cblite-adapter/      # @cblite-uni-app/cblite-adapter — DatabaseAdapter interface + web impl
├── tauri-cblite-example/    # Desktop (Linux/macOS/Windows) + Android app (Tauri 2)
├── web-cblite-example/      # Pure-browser app (Couchbase Lite JS)
├── cblite-auth-server/      # Optional Rust backend — auth, Sync Gateway admin, AI proxy
└── pnpm-workspace.yaml
```

---

## Architecture

All application logic lives in `packages/shared` and is injected with platform-specific behaviour via a `PlatformHooks` object at startup. Each app (Tauri, web) supplies its own hooks and constructs a `DatabaseAdapter` that matches the canonical interface.

```
┌─────────────────────────────────────────────┐
│          @cblite-uni-app/shared              │
│  app.ts  storage.ts  ai.ts  server.ts  ...   │
│  ← receives PlatformHooks + DatabaseAdapter  │
└───────────────┬──────────────────────────────┘
                │ implements DatabaseAdapter
    ┌───────────┴────────────┐
    │                        │
tauri-plugin-cblite    @couchbase/lite-js
(Tauri / Android)      (browser)
```

### `DatabaseAdapter` interface

```typescript
interface DatabaseAdapter {
  openDatabase(path, name, encryptionPassword?, collections?): Promise<void>
  closeDatabase(): Promise<void>
  getDocument(collection, docId): Promise<unknown>
  saveDocument(collection, docId, body, encryptedFields?): Promise<void>
  executeQuery(language: "N1QL" | "JSON", queryStr, parameters?): Promise<unknown[]>
  startReplication(url, collection, direction, auth?, fieldEncryption?): Promise<void>
  stopReplication(): Promise<void>
  saveBlob(dataB64, contentType): Promise<string>   // returns digest
  getBlobData(digest): Promise<string>              // returns base64
  onCollectionChanged(handler): Promise<() => void>
  onReplicationStatus(handler): Promise<() => void>
  registerPredictiveModel(name, options?): Promise<void>
  unregisterPredictiveModel(name): Promise<void>
}
```

---

## Sub-projects

### `packages/shared` — `@cblite-uni-app/shared`

Platform-agnostic app logic, UI web components, and shared styles.

| Module | Purpose |
|---|---|
| `app.ts` | State machine: auth flow, note/conversation CRUD, sync lifecycle, profile |
| `storage.ts` | Query builders for notes, conversations, profile, sync config |
| `server.ts` | HTTP client for the auth server (register, login, AI proxy) |
| `ai.ts` | OpenAI chat reply — proxied via server or direct fallback |
| `crypto.ts` | WebCrypto AES-GCM helpers |
| `note-encryption.ts` | Per-field note encryption (app-level mode) |
| `editor-helpers.ts` | Tiptap JSON parsing, blob-link resolution |
| `auth-helpers.ts` | Sync URL and username resolution |
| `types.ts` | Shared domain types |
| `components/` | Web components: note list, conversation list, chat messages, server list, attachments |
| `styles.css` | Shared stylesheet |

**Exports:**

```json
{
  ".":            "src/index.ts",
  "./app":        "src/app.ts",
  "./components": "src/components/index.ts",
  "./styles.css": "src/styles.css"
}
```

---

### `packages/cblite-adapter` — `@cblite-uni-app/cblite-adapter`

The `DatabaseAdapter` interface and its browser implementation.

| File | Purpose |
|---|---|
| `src/interface.ts` | Canonical `DatabaseAdapter` interface |
| `src/web.ts` | Browser implementation using `@couchbase/lite-js` |
| `src/tauri.d.ts` | Ambient type declarations for `@cblite` (Tauri plugin guest-js) |

---

### `tauri-cblite-example` — Desktop + Android

A Tauri 2 app that targets Linux, macOS, Windows, and Android.

**Tech stack:** TypeScript, Vite, Tauri 2, `tauri-plugin-cblite`

**Platform-specific wiring (`src/main.ts`):**
- `DatabaseAdapter` → `tauri-plugin-cblite` guest-js (resolved via `@cblite` Vite alias)
- File attachments via `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs`
- DB directory via `appLocalDataDir()`
- Window close handling via `getCurrentWindow().onCloseRequested()`
- **Desktop:** enterprise (full-DB AES-256) or app-level (AES-GCM) encryption
- **Sync auth:** Sync Gateway session cookie (preferred over basic auth)

**Run:**
```bash
pnpm --filter tauri-cblite-example tauri dev        # desktop
pnpm --filter tauri-cblite-example tauri android dev # Android
```

---

### `web-cblite-example` — Browser

A pure-browser app with no native dependencies.

**Tech stack:** TypeScript, Vite, `@couchbase/lite-js`

**Platform-specific wiring (`src/main.ts`):**
- `DatabaseAdapter` → `@cblite-uni-app/cblite-adapter/web` (web implementation)
- File attachments via browser `<input type="file">`
- No database-level encryption (encryption_mode forced to `"none"`)
- **Sync auth:** HTTP Basic auth (username + password forwarded to Sync Gateway)

**Run:**
```bash
pnpm --filter web-cblite-example dev
```

---

### `cblite-auth-server` — Rust backend (optional)

An Axum-based REST server that handles user auth, provisions Sync Gateway, and proxies OpenAI requests.

**Tech stack:** Rust, Axum, Tokio, Couchbase Server SDK (`couchbase` 1.0), `argon2`, `jsonwebtoken`

#### API

| Method | Path | Description |
|---|---|---|
| `POST` | `/users` | Register a new user |
| `POST` | `/auth/token` | Login — returns JWT + sync config |
| `GET` | `/sync/config` | Fetch sync URL / collection / direction |
| `POST` | `/ai/chat` | Proxy an OpenAI chat completion (requires JWT) |

#### Startup provisioning

On start the server automatically:
1. Ensures the auth Couchbase bucket exists (default: `auth`)
2. If Sync Gateway is configured: ensures the notes bucket, `notes` and `conversations` collections, creates/updates the SG database with per-user channel sync functions and CORS settings

#### Environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **yes** | Secret for signing JWTs |
| `COUCHBASE_URI` | no | Couchbase Server URI (default: `couchbase://localhost`) |
| `COUCHBASE_USERNAME` | no | Username (default: `Administrator`) |
| `COUCHBASE_PASSWORD` | no | Password (default: `password`) |
| `COUCHBASE_BUCKET` | no | Auth bucket name (default: `auth`) |
| `SYNC_GATEWAY_ADMIN_URL` | no | SG Admin API, e.g. `http://localhost:4985` |
| `SYNC_GATEWAY_DB` | no | SG database name, e.g. `notes` |
| `SYNC_GATEWAY_SYNC_URL` | no | Public WebSocket URL clients use, e.g. `ws://localhost:4984/notes` |
| `SYNC_GATEWAY_BUCKET` | no | Couchbase bucket for SG (defaults to `SYNC_GATEWAY_DB`) |
| `SYNC_GATEWAY_ADMIN_AUTH` | no | `user:pass` for SG Admin API Basic auth |
| `CORS_ORIGINS` | no | Comma-separated allowed origins, e.g. `http://localhost:5173` or `*` |
| `OPENAI_API_KEY` | no | Server-level OpenAI key (users can override with their own) |
| `OPENAI_BASE_URL` | no | OpenAI-compatible base URL (default: `https://api.openai.com/v1`) |

**OpenAI key priority:** per-request user key > `OPENAI_API_KEY` env > error
**OpenAI base URL priority:** per-request user URL > `OPENAI_BASE_URL` env > `https://api.openai.com/v1`

Setting `OPENAI_BASE_URL` to an Ollama or LM Studio endpoint makes the server route all AI requests through a local model.

#### Run

```bash
cd cblite-auth-server
cp .env.example .env   # fill in values
cargo run
# Listening on http://0.0.0.0:3000
```

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18 and [pnpm](https://pnpm.io/)
- [Rust toolchain](https://rustup.rs/) (for `cblite-auth-server` and Tauri desktop)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (for the Tauri app)
- Couchbase Server + Sync Gateway (optional — required for multi-device sync)

```bash
# use nvm to ensure correct Node version
nvm use 22
unset NPM_CONFIG_PREFIX

cd cblite-uni-app
pnpm install
```

### Run the web example (no Rust required)

```bash
pnpm --filter web-cblite-example dev
# → http://localhost:5173
```

### Run the Tauri desktop example

```bash
pnpm --filter tauri-cblite-example tauri dev
```

### Run the auth server

```bash
cd cblite-auth-server
JWT_SECRET=changeme cargo run
```

---

## Encryption modes

| Mode | How it works | Platforms |
|---|---|---|
| `none` | No encryption | All |
| `app-level` | AES-GCM per-field encryption via WebCrypto, key derived from login password | All |
| `enterprise` | Full-database AES-256 encryption via Couchbase Lite Enterprise | Tauri (desktop + Android) |

---

## Sync

Documents are synced via Couchbase Sync Gateway. The sync function enforces per-user isolation — each document must have an `owner` field set to the username, and it is routed to the `user.<owner>` channel. Users only receive their own documents.

Sync can be configured in the app's Profile → Sync panel:
- **Server URL** — WebSocket URL of the Sync Gateway database
- **Direction** — push, pull, or both
- **Keep sync running** — continuously replicate in the background

When connected to the auth server, login automatically returns the sync URL and starts replication.

---

## AI Chat

Notes and conversations support AI-assisted chat powered by OpenAI-compatible APIs.

- When connected to the auth server the request is proxied server-side (keeps the API key off the wire on public networks)
- Without a server the request goes directly from the client
- The base URL is configurable per-user in Profile → AI, enabling Ollama, LM Studio, Azure OpenAI, or any compatible endpoint
- The API key can be set per-user in the profile or provided as a server-level default via `OPENAI_API_KEY`
