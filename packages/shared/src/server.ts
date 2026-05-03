// ── Auth server HTTP client ───────────────────────────────────────────────────
// All functions throw on non-2xx so callers can wrap in try/catch.

export interface SyncConfigFromServer {
  sync_url: string;
  sync_collection: string;
  sync_direction: "push" | "pull" | "both";
  /** Sync Gateway session cookie — present when the auth server has SG Admin API access */
  gateway_session_id?: string;
  gateway_cookie_name?: string;
}

/** Dual sync config returned by the new auth server login response. */
export interface SyncConfigsFromServer {
  private: SyncConfigFromServer;
  public: SyncConfigFromServer;
}

export async function serverRegister(
  baseUrl: string,
  data: {
    username: string;
    password: string;
    sync_url: string;
    sync_collection: string;
    sync_direction: string;
  }
): Promise<{ user_id: string }> {
  const res = await fetch(`${baseUrl}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Register failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function serverLogin(
  baseUrl: string,
  username: string,
  password: string
): Promise<{ token: string; sync_config: SyncConfigFromServer; sync_configs?: SyncConfigsFromServer }> {
  const res = await fetch(`${baseUrl}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | OpenAIContentPart[];
}

/** Proxy a chat completion request through the auth server. */
export async function aiChat(
  serverUrl: string,
  token: string,
  messages: OpenAIMessage[],
  apiKey?: string,
  model?: string,
  openaiBaseUrl?: string
): Promise<string> {
  const res = await fetch(`${serverUrl}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages, api_key: apiKey ?? null, model, openai_base_url: openaiBaseUrl ?? null }),
  });
  if (!res.ok) throw new Error(`AI chat failed (${res.status}): ${await res.text()}`);
  const json: { content: string } = await res.json();
  return json.content;
}

export async function fetchSyncConfig(
  baseUrl: string,
  token: string
): Promise<SyncConfigFromServer> {
  const res = await fetch(`${baseUrl}/sync/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fetch config failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Exchange a still-valid JWT for a fresh one with a new expiry + new SG session. */
export async function refreshToken(
  baseUrl: string,
  token: string
): Promise<{ token: string; sync_config: unknown; sync_configs: unknown }> {
  const res = await fetch(`${baseUrl}/auth/refresh`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Apply approved/rejected KB fact proposals via the auth server. */
export async function applyKbFacts(
  baseUrl: string,
  token: string,
  proposalId: string,
  approvedFactIds: string[],
  rejectedFactIds: string[]
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/kb/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      proposal_id: proposalId,
      approved_fact_ids: approvedFactIds,
      rejected_fact_ids: rejectedFactIds,
    }),
  });
  if (!res.ok) throw new Error(`KB apply failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Fetch the current approved user_kb from the auth server. */
export async function fetchUserKb(
  baseUrl: string,
  token: string
): Promise<import("./types.js").UserKnowledgeBase | null> {
  const res = await fetch(`${baseUrl}/kb`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KB fetch failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Search registered users by prefix/substring. Returns up to 20 matching usernames. */
export async function searchUsers(
  baseUrl: string,
  token: string,
  query: string
): Promise<string[]> {
  const url = `${baseUrl}/users/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const json: { usernames: string[] } = await res.json();
  return json.usernames ?? [];
}
