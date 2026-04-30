// ── Source event ──────────────────────────────────────────────────────────────
// Provider-agnostic event passed to the LLM and dedup store.

export interface SourceEvent {
  /** Provider-native unique ID — used for deduplication. */
  id: string;
  /** e.g. "github", "gitlab", "jira", "slack", "email", "telegram" */
  source: string;
  /** e.g. "issue_assigned", "pr_review_requested", "dm", "mention" */
  type: string;
  /** Who triggered the event (username, email, or display name). */
  actor: string;
  /** Short one-line summary shown in the LLM prompt. */
  title: string;
  /** Full text content of the event. */
  body: string;
  /** Deep link back to the source item. */
  url: string;
  receivedAt: string; // ISO8601
  /** Full provider-native payload for raw_payload storage. */
  raw: Record<string, unknown>;
}

// ── LLM output ────────────────────────────────────────────────────────────────

export interface ActionItemDraft {
  /**
   * Short snake_case action type chosen by the LLM.
   * Well-known values: "email_reply", "follow_up", "schedule_meeting",
   * "review_document", "make_payment", "loom_response".
   */
  action_type: string;
  title: string;
  body: string;
  raw_payload: Record<string, unknown>;
  /**
   * "synced" (default) — written to SG and replicated to all devices.
   * "local"  — written directly to CBLite only; never pushed to SG.
   */
  sync_mode?: "local" | "synced";
  /** When true, the document body will be chunked and embedded after writing. */
  vectorize?: boolean;
}

// ── ActionItem document written to SG ────────────────────────────────────────

export interface ActionItemDoc {
  id: string;
  type: "action_item";
  action_type: string;
  title: string;
  body: string;
  raw_payload: Record<string, unknown>;
  status: "pending";
  owner: string;
  feedback: null;
  feedback_at: null;
  webhook_url: null;
  scheduled_date: string; // YYYY-MM-DD
  created_at: string;     // ISO8601
  updated_at: string;     // ISO8601
  /** "synced" docs are replicated via SG; "local" docs live in CBLite only. */
  sync_mode: "local" | "synced";
  /** true when sync_mode === "local" — used as a replicator push filter. */
  local_only: boolean;
  /** When true, chunk docs with embeddings are written alongside this document. */
  vectorize: boolean;
}

// ── Chunk document ────────────────────────────────────────────────────────────

export interface ChunkDoc {
  id: string;                   // "chunk::<sourceDocId>::<index>"
  type: "chunk";
  source_id: string;
  source_collection: string;    // e.g. "actions", "notes"
  source_owner: string;
  chunk_index: number;
  text: string;
  /** Local embedding (small model, ~384 dims). Set by the Tauri app. */
  local_embedding?: number[];
  /** Server embedding (large model, ~3072 dims). Set by workers before SG write. */
  server_embedding?: number[];
  /**
   * When true the replicator push filter excludes this doc from SG.
   * Used for locally-embedded chunks that must not leave the device.
   */
  local_only?: boolean;
  created_at: string;
  updated_at: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface SgConfig {
  url: string;
  db: string;
  serviceUsername?: string;
  servicePassword?: string;
  /** Per-user SG passwords keyed by lowercase username. */
  userPasswords: Record<string, string>;
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** LLM mode: "llm" = ask the model; "passthrough" = one ActionItem per event, no LLM. */
export type LlmMode = "llm" | "passthrough";

/** Embedding / chunking config shared by every worker. */
export interface EmbeddingConfig {
  /** OpenAI-compatible embedding model name (default: "text-embedding-3-large"). */
  model: string;
  /** Target chunk size in tokens (default: 512). */
  chunkSize: number;
  /** Overlap between consecutive chunks in tokens (default: 64). */
  chunkOverlap: number;
  /** Number of top chunks to retrieve for RAG (default: 5). */
  ragTopK: number;
}

/** Base config fields shared by every worker. */
export interface BaseWorkerConfig {
  llm: LlmConfig;
  llmMode: LlmMode;
  sg: SgConfig;
  pollIntervalSeconds: number;
  webhookPort?: number;
  stateDbPath: string;
  embedding: EmbeddingConfig;
}

export interface UserConfig {
  username: string;
  [key: string]: unknown; // provider-specific fields
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

/** A known contact — helps the LLM understand relationship importance. */
export interface KbContact {
  /** Display name or email. */
  name: string;
  /** e.g. "manager", "direct_report", "client", "vendor", "colleague" */
  relationship?: string;
  /** Free-text notes about this person. */
  notes?: string;
}

/** An active project the user is involved in. */
export interface KbProject {
  name: string;
  /** Short description of the project's goal. */
  description?: string;
  /** Keywords / repo names / Jira project keys associated with this project. */
  keywords?: string[];
}

/**
 * Per-user knowledge base document stored in Sync Gateway (type: "user_kb").
 * Workers load this once per poll cycle to enrich LLM prompts.
 */
export interface UserKnowledgeBase {
  /** SG document type discriminator. */
  type: "user_kb";
  /** Matches the SG username. */
  owner: string;

  // ── Identity ──────────────────────────────────────────────────────────────
  /** Full display name, e.g. "Alice Smith". */
  displayName?: string;
  /** Job title or role, e.g. "Senior Engineer". */
  role?: string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /** Preferred language for action bodies, e.g. "en", "fr". */
  language?: string;

  // ── Work context ──────────────────────────────────────────────────────────
  /** Active projects the user is working on. */
  projects?: KbProject[];
  /** Known contacts and their relationship to the user. */
  contacts?: KbContact[];

  // ── Preferences ───────────────────────────────────────────────────────────
  /**
   * Topics, senders, or keywords the user wants to deprioritise.
   * Events matching these should rarely produce actions.
   */
  ignorePatterns?: string[];
  /**
   * Topics or senders that should always produce an action even if the LLM
   * would otherwise skip them.
   */
  priorityPatterns?: string[];
  /**
   * Free-text instructions appended verbatim to the LLM system prompt.
   * Use for anything not covered by the structured fields above.
   * e.g. "Always suggest a Loom response for customer bug reports."
   */
  customInstructions?: string;

  // ── Metadata ──────────────────────────────────────────────────────────────
  created_at?: string;
  updated_at?: string;
}
