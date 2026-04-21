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
