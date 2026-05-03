// ── Shared domain types ───────────────────────────────────────────────────────

export type EncryptionMode = "enterprise" | "app-level" | "none";

export interface Note {
  id: string;
  title: string;
  /** Stringified Tiptap JSON (or legacy plain text — see parseContent). */
  content: string;
  /** Plain-text extract for N1QL FTS. Not encrypted. */
  content_text?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatAttachment {
  digest: string;
  name: string;
  mime: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: ChatAttachment[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface SyncConfig {
  url: string;
  collection: string;
  direction: "push" | "pull" | "both";
  continuous_sync?: boolean;
}

export interface UserProfile {
  username: string;
  encryption_mode: EncryptionMode;
  crypto_salt?: string;
  openai_api_key?: string;
  openai_base_url?: string;
}

export interface AuthSession {
  token: string;
  server_url: string;
  username: string;
  /** SG session cookie for the private database (preferred over basic auth) */
  gateway_session_id?: string;
  gateway_cookie_name?: string;
  /** Public database sync URL — pull-only, no auth required beyond session */
  public_sync_url?: string;
  public_sync_collection?: string;
}

export interface SavedServer {
  url: string;
}

// ── Kanban / Tasks ────────────────────────────────────────────────────────────

export interface Board {
  id: string;
  type: "board";
  name: string;
  owner: string;
  members: string[];
  column_order: string[];
  created_at: string;
  updated_at: string;
}

export interface Column {
  id: string;
  type: "column";
  board_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  type: "task";
  board_id: string;
  column_id: string;
  title: string;
  description: string;
  assignee: string | null;
  due_date: string | null;
  labels: string[];
  position: number;
  owner: string;
  created_at: string;
  updated_at: string;
}

// ── Chunk documents ───────────────────────────────────────────────────────────

export interface ChunkDoc {
  id: string;                   // "chunk::<sourceDocId>::<index>"
  type: "chunk";
  source_id: string;
  source_collection: string;
  source_owner: string;
  chunk_index: number;
  text: string;
  /** Local embedding (~384 dims, MiniLM). Set by the Tauri app after save. */
  local_embedding?: number[];
  /** Server embedding (~3072 dims). Set by workers before SG write. */
  server_embedding?: number[];
  /**
   * When true the push filter excludes this doc from SG replication.
   * Set on locally-embedded chunks that should never leave the device.
   */
  local_only?: boolean;
  created_at: string;
  updated_at: string;
}

// ── Knowledge Base ────────────────────────────────────────────────────────────

export interface KbContact {
  name: string;
  relationship?: string;
  notes?: string;
}

export interface KbProject {
  name: string;
  description?: string;
  keywords?: string[];
}

/**
 * Per-user knowledge base document (type: "user_kb").
 * Field names are camelCase to match the Rust serde(rename_all = "camelCase") serialisation.
 */
export interface UserKnowledgeBase {
  type: "user_kb";
  owner: string;
  displayName?: string;
  role?: string;
  timezone?: string;
  language?: string;
  projects?: KbProject[];
  contacts?: KbContact[];
  ignorePatterns?: string[];
  priorityPatterns?: string[];
  customInstructions?: string;
  facts?: KbFact[];
  created_at?: string;
  updated_at?: string;
}

export type KbFactKind =
  | "contact"
  | "project"
  | "ignore_pattern"
  | "priority_pattern"
  | "custom_instruction";

export interface KbFact {
  id: string;
  kind: KbFactKind;
  /** KbContact for "contact", KbProject for "project", plain string for all other kinds. */
  value: KbContact | KbProject | string;
  confidence: number;
  rationale: string;
  /** "pending" | "approved" | "rejected" */
  status: string;
}

export interface KbFactProposal {
  id: string;
  type: "kb_fact_proposal";
  owner: string;
  source_event_id: string;
  source_event_title: string;
  source_worker: string;
  facts: KbFact[];
  created_at: string;
  updated_at: string;
}

// ── Daily Actions ─────────────────────────────────────────────────────────────

export type ActionStatus = "pending" | "approved" | "rejected" | "modified";

export interface ActionItem {
  id: string;
  type: "action_item";
  /** Free string identifying the kind of action, e.g. "email", "calendar_event", "webhook". */
  action_type: string;
  title: string;
  /** Human-readable rendered text set by the agent. Editable by the user. */
  body: string;
  /** Opaque JSON blob the agent uses when executing. Never interpreted by the app. */
  raw_payload: Record<string, unknown>;
  status: ActionStatus;
  owner: string;
  /** Free-text note written by the user when modifying. Sent in webhook POST. */
  feedback: string | null;
  feedback_at: string | null;
  /** If set, the app POSTs modification feedback to this URL. */
  webhook_url: string | null;
  /** ISO date string (YYYY-MM-DD) used for the "today" filter. */
  scheduled_date: string | null;
  created_at: string;
  updated_at: string;
}
