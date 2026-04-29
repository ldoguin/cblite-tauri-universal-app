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
  /** Plaintext password kept for platforms that use basic auth (web). */
  password?: string;
  /** SG session cookie issued by the auth server (preferred over basic auth) */
  gateway_session_id?: string;
  gateway_cookie_name?: string;
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
