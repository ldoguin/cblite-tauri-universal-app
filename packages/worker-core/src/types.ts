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

/** Base config fields shared by every worker. */
export interface BaseWorkerConfig {
  llm: LlmConfig;
  llmMode: LlmMode;
  sg: SgConfig;
  pollIntervalSeconds: number;
  webhookPort?: number;
  stateDbPath: string;
}

export interface UserConfig {
  username: string;
  [key: string]: unknown; // provider-specific fields
}
