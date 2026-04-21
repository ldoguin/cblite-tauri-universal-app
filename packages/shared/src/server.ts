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
): Promise<{ token: string; sync_config: SyncConfigFromServer }> {
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
