# Spec: Multi-Source Actions Workers

---

## Problem Statement

Extend the Actions system beyond email to cover GitHub, GitLab, Jira, and Slack. Each source runs as its own independent Node.js/TypeScript microservice. All workers share a common library (`packages/worker-core`) that provides the LLM processor, SG writer, and dedup store — the same logic already implemented in `email-worker`. The existing `email-worker` is refactored to consume `worker-core` rather than duplicating those modules.

---

## Architecture

```
packages/
  worker-core/          ← shared: LLM, SG writer, dedup store, types
email-worker/           ← existing, refactored to use worker-core
github-worker/          ← new
gitlab-worker/          ← new
jira-worker/            ← new
slack-worker/           ← new
```

Each worker is fully self-contained (own `package.json`, `tsconfig.json`, `.env.example`, `Dockerfile`) and depends only on `worker-core` plus its provider-specific SDK.

---

## `packages/worker-core`

### Extracted from `email-worker`

Move the following modules verbatim into `worker-core`, adjusting imports:

| Module | Exported as |
|---|---|
| `src/llm.ts` | `extractActions(event, config)` |
| `src/sg-writer.ts` | `SgWriter` class |
| `src/dedup-store.ts` | `DedupStore` class |

### Generalised event type

Replace `EmailMessage` with a provider-agnostic `SourceEvent`:

```ts
interface SourceEvent {
  id: string;           // provider-native unique ID (used for dedup)
  source: string;       // e.g. "github", "gitlab", "jira", "slack", "email"
  type: string;         // e.g. "issue_assigned", "pr_review_requested", "dm"
  actor: string;        // who triggered the event
  title: string;        // short one-line summary
  body: string;         // full text content
  url: string;          // deep link back to the source
  receivedAt: string;   // ISO8601
  raw: Record<string, unknown>; // full provider payload
}
```

### LLM mode per source

`extractActions` accepts a `mode: "llm" | "passthrough"` parameter:
- `"llm"`: send event to LLM, return 0–N drafts (existing behaviour)
- `"passthrough"`: skip LLM, create exactly one `ActionItemDraft` directly from the event fields

Each worker sets its default mode via env var `LLM_MODE=llm|passthrough` (default: `llm`).

### Shared types

`worker-core` also exports `ActionItemDraft`, `ActionItemDoc`, `AppConfig` (base fields common to all workers), and `SgConfig`.

---

## `email-worker` refactor

- Remove `src/llm.ts`, `src/sg-writer.ts`, `src/dedup-store.ts`, `src/types.ts` (ActionItemDraft/Doc/AppConfig parts).
- Import equivalents from `@cblite-uni-app/worker-core`.
- `EmailMessage` becomes a local type that maps to `SourceEvent` before passing to `extractActions`.
- No behaviour changes.

---

## `github-worker`

### Auth
- Personal access token per user: `GITHUB_TOKEN_<USERNAME>` env vars.
- Uses GitHub REST API v3 (`@octokit/rest` package).

### Event source
- Polls `GET /notifications` (all unread notifications for the authenticated user).
- Covers: issue assignments, PR review requests, mentions in issues/PRs/comments, CI failures on watched repos.
- Each notification has a unique `id` used for dedup.
- After processing, marks notification as read via `PATCH /notifications/threads/{id}`.

### Polling / webhook
- Poll mode: `POLL_INTERVAL_SECONDS` (default: 60).
- Webhook mode: `POST /webhook` accepts GitHub webhook payloads (requires `GITHUB_WEBHOOK_SECRET` for HMAC validation). Supported events: `issues`, `pull_request`, `issue_comment`, `pull_request_review`.

### LLM mode
- Default: `llm`. GitHub notifications are structured enough that `passthrough` is also useful.

### User mapping
- `USERS` JSON array: `[{"username":"alice","github_token":"ghp_..."}]`

---

## `gitlab-worker`

### Auth
- Personal access token per user: stored in `USERS` config as `gitlab_token`.
- Uses GitLab REST API v4 (`axios`, no dedicated SDK needed).
- `GITLAB_BASE_URL` (default: `https://gitlab.com`).

### Event source
- Polls `GET /api/v4/todos` — GitLab's built-in "to-do" list covers: assigned issues/MRs, mentions, review requests, CI failures.
- Each to-do has a unique `id`.
- After processing, marks to-do as done via `POST /api/v4/todos/{id}/mark_as_done`.

### Polling / webhook
- Poll mode only (GitLab webhooks require project-level config; to-do polling is simpler and covers all projects).
- `POLL_INTERVAL_SECONDS` (default: 60).

### LLM mode
- Default: `passthrough` (GitLab to-dos are already action-oriented; LLM adds little value).

### User mapping
- `USERS` JSON array: `[{"username":"alice","gitlab_token":"glpat-..."}]`

---

## `jira-worker`

### Auth
- Atlassian Cloud only: email + API token per user.
- `JIRA_BASE_URL` (e.g. `https://yourorg.atlassian.net`).
- Per-user: `USERS` config includes `jira_email` and `jira_api_token`.

### Event source
- Polls `GET /rest/api/3/issue/picker` is not suitable — instead uses JQL search:
  - `GET /rest/api/3/search?jql=watcher=currentUser() AND updated > -1h ORDER BY updated DESC`
  - Covers all activity on watched issues: assignments, comments, status changes, mentions.
- Each issue+updated_at combination forms the dedup key (`{issue_id}::{updated}`).
- Fetches issue changelog and comments to build a rich `SourceEvent.body`.

### Polling
- Poll mode only (Jira webhooks require admin setup; polling is simpler).
- `POLL_INTERVAL_SECONDS` (default: 300 — Jira activity is lower frequency).

### LLM mode
- Default: `llm` (Jira issues often need triage; LLM decides if action is needed).

### User mapping
- `USERS` JSON array: `[{"username":"alice","jira_email":"alice@company.com","jira_api_token":"ATATT..."}]`

---

## `slack-worker`

### Auth
- Slack Bot Token (`xoxb-...`) with scopes: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`.
- `SLACK_BOT_TOKEN` env var.
- `SLACK_SIGNING_SECRET` for request signature verification.

### Event source
- Events API (requires public URL): `POST /slack/events`.
- Subscribed event types: `message.im` (DMs), `app_mention` (@ mentions in channels).
- Each event has a unique `event_id` (from the outer envelope) used for dedup.
- Slack sends a URL verification challenge on first setup — worker handles `url_verification` event type.

### User mapping
- Slack events include `user` (Slack user ID). Worker maps Slack user IDs to app usernames via `USERS` config:
  - `[{"username":"alice","slack_user_id":"U012AB3CD"}]`
- Events from unmapped Slack users are ignored.

### LLM mode
- Default: `llm` (Slack messages are conversational; LLM filters noise and extracts actionable items).

### Webhook server
- Always-on (no poll mode — Slack Events API is push-only).
- Listens on `WEBHOOK_PORT` (required).

---

## Shared `.env` conventions across all workers

| Var | All workers |
|---|---|
| `OPENAI_API_KEY` | LLM API key |
| `OPENAI_BASE_URL` | LLM base URL (default: OpenAI) |
| `OPENAI_MODEL` | Model name (default: `gpt-4o-mini`) |
| `LLM_MODE` | `llm` or `passthrough` |
| `SYNC_GATEWAY_URL` | SG public URL |
| `SYNC_GATEWAY_DB` | SG database name |
| `SG_SERVICE_USERNAME` | Optional service account |
| `SG_SERVICE_PASSWORD` | Optional service account password |
| `SG_PASSWORD_<USERNAME>` | Per-user SG password fallback |
| `USERS` | JSON array of user configs |
| `POLL_INTERVAL_SECONDS` | Poll frequency (where applicable) |
| `WEBHOOK_PORT` | Webhook listener port (where applicable) |
| `STATE_DB_PATH` | CouchbaseLite dedup DB path |

---

## Acceptance Criteria

1. `worker-core` builds cleanly and is importable by all workers.
2. `email-worker` behaviour is unchanged after refactor.
3. `github-worker`: polling GitHub notifications creates ActionItems for assigned issues, review requests, and mentions.
4. `gitlab-worker`: polling GitLab to-dos creates ActionItems (passthrough mode by default).
5. `jira-worker`: polling watched Jira issues creates ActionItems when activity is detected.
6. `slack-worker`: DMs and @mentions received via Events API create ActionItems.
7. All workers: already-processed event IDs are not reprocessed after restart.
8. All workers: LLM failures do not mark events as processed (retry on next cycle).
9. `LLM_MODE=passthrough` skips LLM and creates one ActionItem per event directly.

---

## `calendly-worker` / `calcom-worker`

### Providers
- **Calendly**: webhook-only. Registers `invitee.created`, `invitee.canceled`, `invitee.rescheduled` via Calendly Webhooks API. Auth: personal access token (`CALENDLY_TOKEN`).
- **Cal.com**: webhook-only. Registers `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED` via Cal.com API. Auth: API key (`CALCOM_API_KEY`).
- Active provider selected via `SCHEDULING_PROVIDER=calendly|calcom`.

### Event source
- Always-on webhook server on `WEBHOOK_PORT` (required — no poll mode, both platforms are push-only).
- Each webhook payload has a unique event UUID used for dedup.
- Signature verification: Calendly uses HMAC-SHA256 (`CALENDLY_WEBHOOK_SECRET`); Cal.com uses a shared secret header (`CALCOM_WEBHOOK_SECRET`).

### LLM mode
- Default: `passthrough` — booking events are already fully structured. One ActionItem per event.
- `action_type` mapped from event type: `"meeting_booked"`, `"meeting_cancelled"`, `"meeting_rescheduled"`.

### User mapping
- `USERS` JSON array: `[{"username":"alice","calendly_uri":"https://api.calendly.com/users/XXXX"}]` or `[{"username":"alice","calcom_user_id":123}]`.
- Webhook payload includes organiser URI/ID; worker maps to app username.

---

## `outlook-worker`

### Auth
- Microsoft Graph API with OAuth2 per user.
- Auth flow: authorization code → refresh token stored in config.
- `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` env vars.
- Per-user: `USERS` config includes `outlook_refresh_token`.

### Event source
- Polls `GET /me/mailFolders/inbox/messages?$filter=isRead eq false` via Microsoft Graph.
- Same pattern as `email-worker` (Gmail): fetch unread, pass to LLM, mark as read after processing.
- `POLL_INTERVAL_SECONDS` (default: 60).
- Webhook mode: Microsoft Graph change notifications (`POST /subscriptions`) — optional, requires public URL and `OUTLOOK_WEBHOOK_SECRET`.

### LLM mode
- Default: `llm` — same as email, LLM decides 0–N actions per message.

### User mapping
- `USERS` JSON array: `[{"username":"alice","outlook_refresh_token":"0.AQAA..."}]`

---

## `telegram-worker`

### Auth
- Telegram Bot API token (`TELEGRAM_BOT_TOKEN`).
- One bot per deployment; users must `/start` the bot to register.

### Event source
- Long-polling via `getUpdates` (no public URL needed as fallback) **or** webhook mode via `setWebhook` when `WEBHOOK_PORT` is set.
- Handles `message` updates: private messages (DMs) and group messages where the bot is @mentioned.
- Each update has a unique `update_id` used for dedup.

### User mapping
- `USERS` config includes `telegram_chat_id` (the user's Telegram chat ID with the bot).
- `[{"username":"alice","telegram_chat_id":123456789}]`
- Messages from unmapped chat IDs are ignored.

### LLM mode
- Default: `llm`.

---

## `whatsapp-worker`

### Auth
- WhatsApp Business API (Meta Cloud).
- `WHATSAPP_ACCESS_TOKEN` (permanent system user token).
- `WHATSAPP_PHONE_NUMBER_ID` (the registered business phone number ID).
- `WHATSAPP_VERIFY_TOKEN` (for webhook verification handshake).
- `WHATSAPP_APP_SECRET` (for HMAC-SHA256 payload signature verification).

### Event source
- Webhook-only (`POST /webhook`). Meta calls the endpoint for every inbound message.
- Handles `messages` entries of type `text` and `audio` (audio transcription left to LLM if supported by model).
- Each message has a unique `id` from the Meta payload used for dedup.
- Webhook verification: `GET /webhook` responds to Meta's `hub.challenge` handshake.

### User mapping
- `USERS` config includes `whatsapp_phone` (the user's WhatsApp number in E.164 format).
- `[{"username":"alice","whatsapp_phone":"+14155552671"}]`
- Messages from unmapped numbers are ignored.

### LLM mode
- Default: `llm`.

---

## `signal-worker`

### Prerequisites
- `signal-cli` must run as a sidecar process, registered with a dedicated phone number.
- Worker communicates with `signal-cli` via its JSON-RPC daemon mode (`signal-cli daemon --socket`).
- Document in README: `signal-cli` installation, registration (`signal-cli -a +1... register`), and daemon startup.

### Auth
- `SIGNAL_CLI_SOCKET` — path to the Unix socket exposed by `signal-cli daemon` (default: `/var/run/signal-cli/socket`).
- `SIGNAL_ACCOUNT` — the registered Signal phone number used by the bot.

### Event source
- Worker connects to `signal-cli` JSON-RPC socket and subscribes to incoming messages via `subscribeReceive`.
- Handles private messages and group messages where the account is mentioned.
- Each message has a `timestamp` + `sourceName` composite ID used for dedup.

### User mapping
- `USERS` config includes `signal_number` (the user's Signal phone number).
- `[{"username":"alice","signal_number":"+14155552671"}]`

### LLM mode
- Default: `llm`.

---

## Loom as an output action type

Loom is not a source worker. Instead, the LLM system prompt (in `worker-core`) is updated to include `loom_response` as a known `action_type` that the model may choose when a video walkthrough is more appropriate than a text reply.

### When the LLM should suggest `loom_response`
Prompt guidance instructs the model to use `action_type: "loom_response"` when:
- The event involves a complex technical question, bug report, or code review that benefits from a visual walkthrough.
- A sales or demo request arrives that warrants a personalised video.
- The body of the event explicitly asks for a demo or screen share.

### ActionItem shape for `loom_response`
```json
{
  "action_type": "loom_response",
  "title": "Record a Loom for: <subject>",
  "body": "<LLM-generated description of what to cover in the video>",
  "raw_payload": {
    "loom_new_url": "https://www.loom.com/new",
    "suggested_title": "<pre-filled title for the recording>",
    "source_event": { ... }
  }
}
```

### App-side rendering
- `<cbl-action-card>` detects `action_type === "loom_response"` and renders a "Record Loom" button that opens `raw_payload.loom_new_url` (with `suggested_title` as a query param if Loom supports it).
- No Loom API key required — this is a UI hint only.

### `worker-core` prompt update
- Add `loom_response` to the list of known action types in the system prompt with a description of when to use it.

---

## Updated directory structure

```
packages/
  worker-core/
email-worker/
github-worker/
gitlab-worker/
jira-worker/
slack-worker/
calendly-worker/        (handles both Calendly and Cal.com)
outlook-worker/
telegram-worker/
whatsapp-worker/
signal-worker/
```

---

## Updated acceptance criteria

10. `calendly-worker`: new/cancelled/rescheduled bookings create ActionItems via webhook.
11. `outlook-worker`: unread Outlook emails create ActionItems (same LLM behaviour as `email-worker`).
12. `telegram-worker`: DMs and @mentions to the bot create ActionItems.
13. `whatsapp-worker`: inbound WhatsApp messages create ActionItems via Meta webhook.
14. `signal-worker`: inbound Signal messages create ActionItems via `signal-cli` JSON-RPC.
15. LLM produces `action_type: "loom_response"` for events where a video reply is appropriate.
16. `<cbl-action-card>` renders a "Record Loom" button for `loom_response` action items.

---

## Updated implementation order

1. **`packages/worker-core`** — extract + generalise + add `loom_response` to prompt
2. **Refactor `email-worker`** — consume `worker-core`
3. **`github-worker`**
4. **`gitlab-worker`**
5. **`jira-worker`**
6. **`slack-worker`**
7. **`outlook-worker`** — mirrors email-worker pattern
8. **`calendly-worker`**
9. **`telegram-worker`**
10. **`whatsapp-worker`**
11. **`signal-worker`**
12. **App: `loom_response` card rendering** in `<cbl-action-card>`

---

## Implementation Order

1. **`packages/worker-core`** — extract and generalise from `email-worker`
2. **Refactor `email-worker`** — consume `worker-core`
3. **`github-worker`** — highest value, simplest auth
4. **`gitlab-worker`** — similar pattern to GitHub
5. **`jira-worker`** — JQL polling
6. **`slack-worker`** — Events API, always-on webhook

---

# Spec: Email-to-Actions Worker

---

## Problem Statement

An autonomous email worker reads user inboxes (AgentMail.to or Gmail), passes each unprocessed email to an LLM, and writes zero or more `ActionItem` documents into Sync Gateway so they appear in the user's Actions tab. The worker runs as a standalone Node.js/TypeScript service, supports both polling and webhook-push delivery, and tracks processed message IDs in a local CouchbaseLite database to survive restarts without reprocessing.

---

## Requirements

### Provider Support

- **AgentMail.to**: one inbox per user, addressed as `<username>@<domain>.agentmail.to`. Configured via `AGENTMAIL_API_KEY` and `AGENTMAIL_DOMAIN`.
- **Gmail**: one OAuth2 refresh token per user, stored in config. Configured via `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and per-user `GMAIL_REFRESH_TOKEN_<USERNAME>`.
- Active provider selected via `EMAIL_PROVIDER=agentmail|gmail` env var.
- Both providers expose the same internal `EmailProvider` interface so the rest of the worker is provider-agnostic.

### User Mapping

- Each configured user has a username and a corresponding inbox (AgentMail address or Gmail account).
- Users are declared in a `USERS` env var as a JSON array: `[{"username":"alice","email":"alice@domain.agentmail.to"}]` (AgentMail) or `[{"username":"alice","gmail_refresh_token":"..."}]` (Gmail).

### Email Ingestion

- **Poll mode** (default): worker polls each user's inbox every `POLL_INTERVAL_SECONDS` (default: 60) seconds.
- **Webhook mode**: when `WEBHOOK_PORT` is set, the worker starts an HTTP server and accepts provider push notifications at `POST /webhook`. Falls back to polling for any user not covered by webhooks.
- Both modes can be active simultaneously.

### LLM Processing

- Each new email is sent to the OpenAI-compatible API (same `OPENAI_API_KEY` / `OPENAI_BASE_URL` env vars as the auth server).
- System prompt instructs the LLM to return a JSON array of zero or more action items. Empty array = email requires no action.
- Each action item in the LLM response maps to one `ActionItem` document:
  - `action_type`: LLM-chosen string (e.g. `"email_reply"`, `"follow_up"`, `"calendar_event"`)
  - `title`: short summary
  - `body`: human-readable description of the suggested action
  - `raw_payload`: full original email metadata (message ID, from, subject, snippet) plus any LLM-extracted structured data
  - `scheduled_date`: today's ISO date (YYYY-MM-DD)
  - `status`: `"pending"`
  - `owner`: the target username
- Model configurable via `OPENAI_MODEL` (default: `gpt-4o-mini`).

### Writing to Sync Gateway

- Worker writes `ActionItem` documents via the SG Public REST API: `PUT /{db}/_default.actions/{doc_id}`.
- Authenticates using a per-user SG session obtained by calling `POST /{db}/_session` with the user's credentials (username + password stored in config, or a dedicated service account).
- SG URL configured via `SYNC_GATEWAY_URL` and `SYNC_GATEWAY_DB`.
- Service account credentials via `SG_SERVICE_USERNAME` / `SG_SERVICE_PASSWORD` (optional; falls back to per-user credentials).

### Deduplication

- Processed message IDs are stored in a local CouchbaseLite database (`processed-messages.cblite2`) via the `cblite` Node.js adapter already used by the web app.
- Before processing any email, the worker checks if its message ID exists in the local DB. If found, skip.
- After successfully writing all resulting ActionItems to SG, the message ID is saved to the local DB.
- DB path configurable via `STATE_DB_PATH` (default: `./data`).

### Error Handling

- LLM parse errors (non-JSON response): log warning, skip email, do **not** mark as processed (will retry next poll).
- SG write failure: log error, do not mark as processed.
- Provider API errors: log, back off with exponential retry (max 5 attempts), then skip until next poll cycle.

---

## Acceptance Criteria

1. `EMAIL_PROVIDER=agentmail` — worker polls AgentMail inbox for each configured user, creates ActionItems visible in the app's Actions tab.
2. `EMAIL_PROVIDER=gmail` — worker polls Gmail inbox using OAuth2 refresh token, same result.
3. LLM returns empty array for a non-actionable email → no ActionItem created, email still marked processed.
4. LLM returns multiple items for one email → multiple ActionItems created, all owned by the correct user.
5. Worker restarted mid-run → already-processed emails are not reprocessed (CouchbaseLite state survives restart).
6. `WEBHOOK_PORT` set → worker accepts provider push at `POST /webhook` and processes immediately without waiting for next poll.
7. Invalid LLM JSON response → email is not marked processed; next poll retries it.
8. SG write fails → email not marked processed; retried next cycle.

---

## Implementation Approach

### New service: `email-worker/`

A new top-level directory alongside `cblite-auth-server/` and the app packages.

#### Steps

1. **Scaffold `email-worker/`**
   - `package.json` with dependencies: `node-couchbase-lite` (or `cblite` adapter), `axios`, `dotenv`, `zod` (for LLM response validation).
   - `tsconfig.json` targeting Node 20, ESM output.
   - `.env.example` documenting all env vars.

2. **Define shared types** (`src/types.ts`)
   - `EmailMessage`: `{ id, from, to, subject, body, receivedAt }`
   - `EmailProvider` interface: `listNew(username): Promise<EmailMessage[]>`, `markRead?(id): Promise<void>`
   - `ActionItemDraft`: fields the LLM returns before enrichment

3. **Implement `AgentMailProvider`** (`src/providers/agentmail.ts`)
   - Uses AgentMail REST API to list messages for each user's inbox.
   - Fetches full message body on demand.

4. **Implement `GmailProvider`** (`src/providers/gmail.ts`)
   - Uses Google Gmail API (`googleapis` package) with OAuth2 refresh token.
   - Lists `UNREAD` messages in `INBOX`, fetches full payload.

5. **Implement LLM processor** (`src/llm.ts`)
   - Builds system prompt instructing the model to return `ActionItem[]` JSON.
   - Calls OpenAI-compatible API.
   - Validates response with Zod; returns empty array on parse failure.

6. **Implement SG writer** (`src/sg-writer.ts`)
   - Obtains SG session token (cached, refreshed on 401).
   - `PUT /{db}/_default.actions/{doc_id}` for each ActionItem draft.

7. **Implement dedup store** (`src/dedup-store.ts`)
   - Opens local CouchbaseLite DB via the existing `@cblite-uni-app/cblite-adapter` web adapter (or direct `cblite` CLI if adapter not suitable for Node).
   - `isProcessed(messageId): Promise<boolean>`
   - `markProcessed(messageId): Promise<void>`

8. **Implement poll loop** (`src/poller.ts`)
   - For each user: `listNew` → filter unprocessed → LLM → write to SG → mark processed.
   - Runs on `setInterval` with `POLL_INTERVAL_SECONDS`.

9. **Implement webhook server** (`src/webhook.ts`)
   - Minimal HTTP server (Node `http` or `express`).
   - `POST /webhook` validates provider signature, extracts message ID, triggers immediate processing for that message.

10. **Entry point** (`src/index.ts`)
    - Loads env, selects provider, starts poller, optionally starts webhook server.

11. **`Dockerfile`** for the worker (optional, for deployment).

---

# Spec: Daily Actions Tab

---

## Problem Statement

Users need a dedicated "Daily Actions" tab that surfaces agent-generated action items requiring human approval before execution. An external agent (e.g. an email-drafting bot, calendar scheduler, or any automation) pushes action items into the app via Sync Gateway. The user reviews each item, swipes/clicks to approve or reject, or edits the item and sends feedback back to the agent via a webhook. The tab shows today's pending items by default with a toggle to see all.

This is distinct from the Kanban tasks tab: action items are personal (not shared), agent-driven (not user-created), and have a linear approve/reject/modify lifecycle rather than a board-column workflow.

---

## Requirements

### Data Model

New document type stored in a new **`actions`** collection (`_default.actions`):

```json
{
  "id": "action-<uuid>",
  "type": "action_item",
  "action_type": "string",
  "title": "string",
  "body": "string (rendered/human-readable text)",
  "raw_payload": "object (arbitrary JSON — agent-defined)",
  "status": "pending | approved | rejected | modified",
  "owner": "username",
  "feedback": "string | null",
  "feedback_at": "ISO8601 | null",
  "webhook_url": "string | null",
  "scheduled_date": "ISO8601 date | null",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

- `action_type`: free string identifying the kind of action (e.g. `"email"`, `"calendar_event"`, `"webhook"`). Used for display icons and future plugin rendering.
- `body`: human-readable summary rendered in the card. The agent sets this.
- `raw_payload`: opaque JSON blob the agent uses when executing. The app never interprets it.
- `webhook_url`: when set, the app POSTs feedback/modification requests to this URL. If null, the agent must poll the doc status via Sync Gateway.
- `scheduled_date`: ISO date string (YYYY-MM-DD). Used for the "today only" filter.
- `feedback`: free-text note the user writes when modifying. Sent in the webhook POST body.

### Sync Gateway

- New `actions` collection added to the SG database config.
- Sync function routes docs to `user.<owner>` (personal, same pattern as `notes`).
- Auth server: `actions` added to `collection_access` in `ensure_sg_user` and `register`.
- `ensure_indexes`: new index on `actions(owner, status, scheduled_date)`.

### UI — Daily Actions Tab

**Navigation**: New rail button `#nav-actions` (lightning bolt icon) inserted between Tasks and Profile.

**Panel** (`#panel-actions`): empty aside (no sidebar list needed — all content is in the main view).

**Main view** (`#actions-view`):

- **Header bar**: "Daily Actions" title + date display + "Today" / "All" toggle button.
- **Empty state**: illustrated empty state when no items match the current filter.
- **Action card stack**: vertically scrollable list of `<cbl-action-card>` elements.

**Action card** (`<cbl-action-card>`):

Each card displays:
- Action type badge (icon + `action_type` label, e.g. ✉ Email, 📅 Calendar, ⚡ Webhook).
- Title (bold).
- Body text (truncated to ~3 lines, expandable).
- Scheduled date if set.
- Status badge (pending / approved / rejected / modified).

Interaction:
- **Swipe right** (touch) / **`→` key** / **Approve button**: sets `status = "approved"`, stamps `updated_at`. Card animates out to the right.
- **Swipe left** (touch) / **`←` key** / **Edit button**: opens the edit/feedback drawer.
- **Reject button** (visible on hover / keyboard `R`): sets `status = "rejected"`. Card animates out to the left.
- Approved and rejected cards are hidden from the "Today" view immediately; visible in "All" view with a muted style.

**Edit / feedback drawer** (slides up from bottom or in from right):

Two sections:
1. **Edit fields**: editable `title`, `body`, and `feedback` (free-text note to the agent). `raw_payload` shown as read-only JSON for transparency.
2. **Re-prompt** (optional): a single-line text input that calls the existing AI chat endpoint (`getAIReply`) with the current `body` + user instruction as context, and replaces `body` with the AI response. This is optional — the user can edit directly without re-prompting.

On **Save**:
- Sets `status = "modified"`, saves `feedback` and updated `body`/`title` to the local DB (syncs to agent via SG).
- If `webhook_url` is set: POSTs `{ action_id, status: "modified", feedback, body, raw_payload }` to the webhook URL. Non-fatal on failure (logs error, shows toast).

### Keyboard shortcuts (desktop)

| Key | Action |
|-----|--------|
| `→` or `A` | Approve focused card |
| `←` or `R` | Reject focused card |
| `E` | Open edit drawer for focused card |
| `Escape` | Close drawer |
| `↑` / `↓` | Move focus between cards |

### Shared Package Changes (`packages/shared`)

**`types.ts`**: Add `ActionItem` interface.

**`storage.ts`**: Add:
- `loadActionItems(adapter, username, dateFilter?: string)` — queries `actions` collection filtered by `owner` and optionally `scheduled_date`.
- `saveActionItem(adapter, item)` — upsert.
- `updateActionStatus(adapter, id, status, feedback?)` — partial update.

**`components/action-card.ts`**: New `<cbl-action-card>` Web Component.
- Properties: `item: ActionItem`, `currentUser: string`.
- Emits: `cbl-action-approve`, `cbl-action-reject`, `cbl-action-edit`.
- Handles touch swipe (touchstart/touchend delta) and keyboard events internally.
- Renders type badge, title, body preview, date, status.

**`components/action-drawer.ts`**: New `<cbl-action-drawer>` Web Component.
- Properties: `item: ActionItem | null`, `userSearch callback`.
- Emits: `cbl-action-save`, `cbl-action-close`.
- Contains edit form + optional AI re-prompt input.
- Calls `getAIReply` for re-prompt.

**`app.ts`**: Add actions panel state and wiring:
- `showPanel("actions")` branch.
- Load/reload actions on panel open and on `onCollectionChanged`.
- Handle `cbl-action-approve`, `cbl-action-reject`, `cbl-action-save` events.
- Webhook POST helper (fire-and-forget, non-fatal).
- Today/All toggle state.

**`styles.css` (both app files)**: Action card styles, swipe animation, drawer, type badge colors.

**`index.html` (both apps)**: `#nav-actions` rail button, `#panel-actions` aside, `#actions-view` div.

### Auth Server Changes

**`main.rs`** — `ensure_sg_database`: add `actions` collection with user-channel sync function.

**`routes/sync.rs`** — `ensure_sg_user`: add `actions` to `collection_access`.

**`routes/users.rs`** — `register`: add `actions` to `collection_access`.

**`db.rs`** — `ensure_indexes`: add index on `actions(owner, status, scheduled_date)`.

**`web.ts`** (cblite-adapter): add `"actions"` to `NAMED_COLLECTIONS` and replication `collectionsConfig`.

**`main.ts`** (tauri app): add `"_default.actions"` to `extras` in the `startReplication` wrapper.

---

## Acceptance Criteria

1. A "Daily Actions" tab appears in the icon rail of both apps.
2. Action items pushed by an external agent via Sync Gateway appear in the tab for the assigned user only.
3. "Today" filter shows only items with `scheduled_date` matching today (or null). "All" toggle shows everything.
4. Swiping right / pressing `→` / clicking Approve sets `status = "approved"` and removes the card from the Today view.
5. Swiping left / pressing `←` / clicking Edit opens the drawer with editable title, body, and feedback fields.
6. The drawer's re-prompt input calls the AI endpoint and updates the `body` field in-place.
7. Saving from the drawer sets `status = "modified"`, persists changes, and POSTs to `webhook_url` if set.
8. Pressing `R` / clicking Reject sets `status = "rejected"` and removes the card from the Today view.
9. Approved/rejected/modified items are visible in "All" view with a muted style.
10. Keyboard navigation (↑/↓ to move focus, shortcuts to act) works on desktop.
11. The `actions` collection syncs bidirectionally via Sync Gateway (agent pushes, app updates status/feedback, agent polls).
12. Existing Notes, Chat, and Kanban tabs are unaffected.

---

## Implementation Steps

1. **`types.ts`** — Add `ActionItem` interface.
2. **`storage.ts`** — Add `loadActionItems`, `saveActionItem`, `updateActionStatus`.
3. **`components/action-card.ts`** — Implement `<cbl-action-card>` with swipe, keyboard, and event emission.
4. **`components/action-drawer.ts`** — Implement `<cbl-action-drawer>` with edit form and AI re-prompt.
5. **`components/index.ts`** — Export both new components.
6. **`app.ts`** — Add actions panel state, event wiring, webhook POST helper, today/all toggle.
7. **`styles.css` (both apps)** — Action card, swipe animation, drawer, type badge styles.
8. **`index.html` (both apps)** — `#nav-actions` rail button, `#panel-actions`, `#actions-view`.
9. **Auth server `main.rs`** — Add `actions` to SG database config and `ensure_indexes`.
10. **Auth server `routes/sync.rs` + `users.rs`** — Add `actions` to `collection_access`.
11. **`web.ts`** — Add `"actions"` to `NAMED_COLLECTIONS` and replication config.
12. **Tauri `main.ts`** — Add `"_default.actions"` to `startReplication` extras.

# Spec: Kanban Tasks Tab

## Problem Statement

The app currently has Notes and AI Chat panels. Users need a collaborative task management view — a Trello-style Kanban board — where multiple users can share boards, manage cards across configurable columns, and have changes sync in real time via Couchbase Sync Gateway.

The existing SG sync function routes all documents to per-user channels (`user.<owner>`), which prevents cross-user sharing. Tasks require a board-scoped channel model managed by the auth server.

---

## Requirements

### Data Model

Three new document types, stored in a new `tasks` collection (`_default.tasks`):

**Board** (`type: "board"`)
```json
{
  "id": "board-<uuid>",
  "type": "board",
  "name": "string",
  "owner": "username",
  "members": ["username", ...],
  "column_order": ["col-<uuid>", ...],
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Column** (`type: "column"`)
```json
{
  "id": "col-<uuid>",
  "type": "column",
  "board_id": "board-<uuid>",
  "name": "string",
  "position": 0,
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Task** (`type: "task"`)
```json
{
  "id": "task-<uuid>",
  "type": "task",
  "board_id": "board-<uuid>",
  "column_id": "col-<uuid>",
  "title": "string",
  "description": "string (plain text)",
  "assignee": "username | null",
  "due_date": "ISO8601 date | null",
  "labels": ["string", ...],
  "position": 0,
  "owner": "username",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

All three document types carry `board_id` so the SG sync function can route them to `board.<boardId>`.

### Sync Gateway Changes

**New `tasks` collection** added to the SG database config (alongside `notes` and `conversations`).

**Sync function for `tasks`**:
```javascript
function(doc, oldDoc) {
  var boardId = doc.board_id || (oldDoc && oldDoc.board_id);
  if (!boardId) throw({ forbidden: "missing board_id" });
  channel("board." + boardId);
  // Board docs also route to owner's personal channel so they can discover their boards
  if (doc.type === "board") {
    var members = doc.members || [];
    for (var i = 0; i < members.length; i++) {
      channel("user." + members[i]);
    }
  }
}
```

**Auth server changes** (`cblite-auth-server`):

1. New endpoint: `POST /boards/:boardId/members` — adds a username to a board's SG channel access.
2. When a user is created or logs in, the auth server grants them access to all boards they are a member of (by reading board docs from Couchbase Server and calling the SG Admin API to add `board.<boardId>` to their channels).
3. `ensure_sg_user` extended to include `tasks` collection in `collection_access`.
4. New helper: `grant_board_channel(sg_url, sg_db, username, board_id)` — calls `PUT /{db}/_user/{username}` to add `board.<boardId>` to the user's channels.

**`main.rs` / `ensure_sg_database`**: add `tasks` to the `scopes_config` collections with the new sync function.

### UI — Tasks Tab

A new **Tasks** panel added to both `tauri-cblite-example` and `web-cblite-example`.

**Navigation**: A new icon-rail button `#nav-tasks` (checklist icon) inserted between Chat and Profile.

**Panel layout** (`#panel-tasks`):
- Header with "Tasks" title and a "New Board" button.
- Board selector: dropdown or list of boards the user is a member of.
- "Invite member" input (username + Add button) visible when a board is selected.
- Kanban board area: horizontal scrollable row of columns.
- Each column has: title (editable inline), "Add card" button, delete column button, and a list of task cards.
- "Add column" button at the end of the column row.

**Task card**:
- Title (editable inline on click).
- Expand button opens a card detail modal/drawer with: title, description (plain text textarea), assignee (text input), due date (date input), labels (comma-separated tags).
- Delete button.

**Drag-and-drop**: Native HTML5 drag-and-drop.
- Cards are draggable between columns and reorderable within a column.
- `position` field on tasks is updated on drop (integer index within column).
- Columns are not draggable (column order is managed via `column_order` on the board doc).

**Real-time sync**: The existing `onCollectionChanged` listener is extended to also reload tasks when the `tasks` collection changes.

### Shared Package Changes (`packages/shared`)

**`types.ts`**: Add `Board`, `Column`, `Task` interfaces.

**`storage.ts`**: Add CRUD helpers:
- `loadBoards(adapter, username)` — query boards where `owner = username OR members CONTAINS username`.
- `saveBoard / deleteBoard`
- `loadColumns(adapter, boardId)`
- `saveColumn / deleteColumn`
- `loadTasks(adapter, boardId)`
- `saveTask / deleteTask`

**`app.ts`**: Add tasks panel state and wire-up:
- `showPanel` extended to handle `"tasks"`.
- Board/column/task load on panel open.
- `onCollectionChanged` callback extended to reload tasks.
- Board invite flow: calls auth server `POST /boards/:boardId/members`, then updates board doc locally.

**`components/`**: New Web Component `<cbl-kanban-board>` (`kanban-board.ts`) that:
- Accepts `board`, `columns`, `tasks`, `currentUser` as properties.
- Renders columns and cards.
- Emits custom events: `cbl-task-move`, `cbl-task-create`, `cbl-task-update`, `cbl-task-delete`, `cbl-column-create`, `cbl-column-update`, `cbl-column-delete`.
- Handles HTML5 drag-and-drop internally.

---

## Acceptance Criteria

1. A "Tasks" tab appears in the icon rail of both the Tauri and web apps.
2. A logged-in user can create a new board with a name.
3. The board creator can invite another registered user by username; that user sees the board after their next login or sync.
4. Boards have configurable columns: add, rename, and delete columns.
5. Task cards can be created in any column with title, description, assignee, due date, and labels.
6. Cards can be dragged between columns; the new column assignment persists after a page reload.
7. Cards can be reordered within a column via drag-and-drop; order persists.
8. All changes (tasks, columns, board membership) sync to other users on the same board via Sync Gateway in real time (continuous sync).
9. The `tasks` collection is registered in SG with the board-channel sync function.
10. The auth server grants `board.<boardId>` channel access to invited members via the SG Admin API.
11. Existing Notes and Chat functionality is unaffected.

---

## Implementation Steps

1. **`types.ts`** — Add `Board`, `Column`, `Task` interfaces.

2. **`storage.ts`** — Add `loadBoards`, `saveBoard`, `deleteBoard`, `loadColumns`, `saveColumn`, `deleteColumn`, `loadTasks`, `saveTask`, `deleteTask` helpers. All queries target the `tasks` collection.

3. **`components/kanban-board.ts`** — Implement `<cbl-kanban-board>` Web Component with column rendering, card rendering, inline editing, card detail modal, and HTML5 drag-and-drop.

4. **`components/index.ts`** — Export `CblKanbanBoard`.

5. **`app.ts`** — Add tasks panel state variables, `showPanel("tasks")` branch, board/column/task load logic, board creation, member invite (calls auth server), `onCollectionChanged` extension, and event wiring for all kanban events.

6. **`styles.css`** — Add Kanban board layout styles (column strip, card styles, drag-over highlight, card detail modal).

7. **`index.html` (both apps)** — Add `#nav-tasks` rail button, `#panel-tasks` aside with board selector, invite row, and `<cbl-kanban-board>` element.

8. **Auth server — `main.rs`** — Add `tasks` collection to `ensure_sg_database` scopes config with the board-channel sync function.

9. **Auth server — `routes/sync.rs` / `ensure_sg_user`** — Add `tasks` to `collection_access` when creating/updating SG users.

10. **Auth server — new route `routes/boards.rs`** — `POST /boards/:boardId/members` endpoint: validates JWT, reads board doc from Couchbase, adds the new member, calls SG Admin API to grant `board.<boardId>` channel to the new member, saves updated board doc.

11. **Auth server — `main.rs` router** — Register the new `/boards/:boardId/members` route.

12. **Auth server — login flow** — On login, read all boards where the user is a member and ensure their SG channels include all relevant `board.<boardId>` entries.
