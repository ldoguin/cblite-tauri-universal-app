# Spec: Knowledge Base Facts Extraction

## Problem Statement

Workers process events (emails, GitHub issues, Slack messages, etc.) that contain implicit facts about the user's world — who they work with, what projects they're involved in, what they care about. Currently this information is lost after action extraction. This spec adds a **facts extraction pipeline** that:

1. Runs asynchronously after action extraction (non-blocking).
2. Extracts structured facts (contacts, projects, ignore/priority patterns, free-form facts) from each event using a dedicated LLM call.
3. Stores extracted facts as **pending proposals** in SG — one `kb_fact_proposal` document per event batch.
4. Merges approved facts into `user_kb` using an LLM-based reconciliation at write time.
5. Provides a new **KB tab** in the app UI for reviewing and approving/rejecting individual facts.

---

## Data Model

### `KbFact` — a single extracted fact

```typescript
interface KbFact {
  id: string;                  // stable UUID, assigned at extraction time
  /** Discriminates the target field on UserKnowledgeBase */
  kind: "contact" | "project" | "ignore_pattern" | "priority_pattern" | "custom_instruction";
  /** The extracted value — shape depends on kind */
  value: KbContact | KbProject | string;
  /** Confidence score 0–1 from the LLM */
  confidence: number;
  /** Human-readable reason the LLM extracted this fact */
  rationale: string;
  /** Approval state — set by the user in the app */
  status: "pending" | "approved" | "rejected";
}
```

### `KbFactProposal` — one SG document per extraction batch

```typescript
interface KbFactProposal {
  id: string;                  // "kb_proposal::<username>::<eventId>"
  type: "kb_fact_proposal";
  owner: string;               // username — used for SG channel routing
  source_event_id: string;
  source_event_title: string;
  source_worker: string;       // e.g. "email", "github", "slack"
  facts: KbFact[];
  created_at: string;
  updated_at: string;
}
```

Stored in the `_default.user_data` collection of the private SG database (same collection as `user_kb`). SG sync function routes by `owner` field.

### `UserKnowledgeBase` — extended with facts array

Add a `facts` field to capture free-form extracted facts that don't fit the structured fields:

```typescript
interface UserKnowledgeBase {
  // ... existing fields ...
  /** Free-form facts extracted by workers and approved by the user */
  facts?: KbFact[];
}
```

---

## Extraction Pipeline

### Trigger
After `handleEvent` completes (actions written), the poller fires `extractAndProposeFacts(event, user, config)` as a background async call — it does not block the event processing loop and failures are non-fatal.

### LLM call — `extractFacts(event, kb, config)`
A dedicated second LLM call with a facts-focused system prompt. Returns a `KbFact[]`.

**System prompt goals:**
- Extract contacts mentioned in the event (name, email, inferred relationship, notes).
- Extract project names / repo names / ticket keys and their descriptions.
- Identify topics the user should probably ignore (e.g. automated bots, CI noise).
- Identify topics that seem high-priority for this user.
- Extract any other notable facts about the user's context.
- Return `[]` if nothing worth storing is found.

**Response schema (JSON array):**
```json
[
  {
    "kind": "contact",
    "value": { "name": "alice@co.com", "relationship": "client", "notes": "reports bugs frequently" },
    "confidence": 0.9,
    "rationale": "Alice sent 3 bug reports this week"
  },
  {
    "kind": "project",
    "value": { "name": "Acme API", "keywords": ["acme-api"], "description": "REST API rewrite" },
    "confidence": 0.8,
    "rationale": "Referenced in subject line and body"
  }
]
```

### Deduplication
Before writing a proposal, check if a `kb_fact_proposal` doc already exists for `source_event_id`. If so, skip (idempotent).

### Proposal write
Construct a `KbFactProposal` doc and write it to `_default.user_data` via SG using the user's session (same auth as `SgWriter`).

---

## Merge at Write Time

When the user approves one or more facts, the app calls the auth server `POST /kb/apply` endpoint. The server:

1. Loads the current `user_kb` from SG.
2. For each approved fact, checks if a conflicting entry already exists in the KB (same contact name, same project name, same pattern string).
3. If **no conflict**: appends the fact directly.
4. If **conflict**: calls the LLM with a merge prompt — "Given the existing entry and the new fact, produce a single merged entry." Replaces the existing entry with the merged result.
5. Saves the updated `user_kb` back to SG.
6. Marks the approved/rejected facts on the `KbFactProposal` doc (`status` updated per fact).
7. Invalidates the `KnowledgeBaseLoader` cache for the user.

The merge LLM call uses the same `OPENAI_API_KEY` / `OPENAI_BASE_URL` as the rest of the system.

---

## Auth Server — New Endpoint

### `POST /kb/apply`

**Auth**: JWT bearer token (same as existing endpoints).

**Request body:**
```json
{
  "proposal_id": "kb_proposal::alice::evt-123",
  "approved_fact_ids": ["uuid-1", "uuid-3"],
  "rejected_fact_ids": ["uuid-2"]
}
```

**Response:** `200 OK` with the updated `UserKnowledgeBase`.

**Implementation** (`cblite-auth-server/src/routes/kb.rs`):
- Load proposal doc from SG Admin API.
- Load current `user_kb` from SG Admin API.
- For each approved fact: merge into KB (with LLM reconciliation on conflict).
- Save updated `user_kb` to SG Admin API.
- Update proposal doc with per-fact status.
- Return updated KB.

---

## App UI — KB Tab

A new **KB** tab added to the main navigation alongside Notes, Conversations, Tasks, Actions.

### Sections

1. **Pending proposals** — list of `kb_fact_proposal` docs with `status: "pending"` facts.
   - Each proposal shows: source worker icon, event title, timestamp.
   - Each fact shows: kind badge, value summary, confidence bar, rationale.
   - Per-fact approve ✅ / reject ❌ buttons.
   - "Approve all" / "Reject all" buttons per proposal.

2. **Knowledge base** — read-only view of the current `user_kb` fields:
   - Profile (name, role, timezone, language)
   - Projects list
   - Contacts list
   - Priority / ignore patterns
   - Custom instructions
   - Facts array

### Web component
`<cbl-kb-panel>` in `packages/shared/src/components/kb-panel.ts`.

---

## Acceptance Criteria

1. After a worker processes an event, a `kb_fact_proposal` doc appears in SG within 60 seconds (async, non-blocking).
2. The proposal contains at least one fact when the event has identifiable contacts, projects, or patterns.
3. Empty extractions (`[]`) produce no proposal doc.
4. The KB tab in the app lists pending proposals and their individual facts.
5. Approving a fact merges it into `user_kb` via `POST /kb/apply`. The updated KB is visible in the KB tab immediately.
6. Rejecting a fact marks it rejected on the proposal doc; it does not appear in `user_kb`.
7. Approving a fact that conflicts with an existing KB entry triggers an LLM merge — the result replaces the old entry.
8. Fact extraction failures are non-fatal — the action extraction pipeline is unaffected.
9. The `KnowledgeBaseLoader` cache is invalidated after a successful apply so workers pick up the updated KB within one poll cycle.
10. The `KbFactProposal` doc is routed to `user.<username>` channel in SG — users only see their own proposals.

---

## Implementation Steps

### worker-core

1. **`types.ts`**: Add `KbFact`, `KbFactProposal` interfaces. Add `facts?: KbFact[]` to `UserKnowledgeBase`.
2. **`fact-extractor.ts`**: New `extractFacts(event, kb, config): Promise<KbFact[]>` — dedicated LLM call with facts-focused system prompt and Zod schema validation.
3. **`fact-writer.ts`**: New `FactWriter` class — checks for existing proposal (dedup), constructs `KbFactProposal`, writes to `_default.user_data` via SG.
4. **`poller.ts`**: After `handleEvent` completes, fire `extractAndProposeFacts(event, user, userKb)` as a detached async call (`.catch()` logs, never throws).
5. **`index.ts`**: Export `extractFacts`, `FactWriter`, `KbFact`, `KbFactProposal`.

### Auth server

6. **`src/routes/kb.rs`**: New route module. Implement `POST /kb/apply` — load proposal + KB from SG Admin API, merge approved facts (with LLM reconciliation on conflict), save KB, update proposal, return KB.
7. **`src/main.rs`**: Register `/kb/apply` route.
8. **`src/models.rs`**: Add `KbApplyRequest`, `KbApplyResponse` structs.

### App (shared)

9. **`types.ts`**: Add `KbFact`, `KbFactProposal` to shared types.
10. **`storage.ts`**: Add `loadKbProposals(adapter)` — queries `user_data` collection for `type = 'kb_fact_proposal'` with pending facts.
11. **`server.ts`**: Add `applyKbFacts(serverUrl, token, proposalId, approvedIds, rejectedIds)` HTTP helper.
12. **`components/kb-panel.ts`**: New `<cbl-kb-panel>` web component — pending proposals list + KB viewer.
13. **`app.ts`**: Add KB tab to navigation. Wire up `<cbl-kb-panel>`. Load proposals on tab activation. Call `applyKbFacts` on approve/reject.

### Config / docs

14. **`.env.example`**: Document `KB_FACTS_ENABLED=true` (opt-in flag to disable fact extraction per worker if needed).
15. **`docker-compose.yml`**: Add `KB_FACTS_ENABLED` to the `x-worker-base` env block.
