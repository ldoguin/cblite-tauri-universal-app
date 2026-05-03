import axios, { type AxiosInstance } from "axios";
import { readFile } from "fs/promises";
import type { SgConfig, UserKnowledgeBase } from "./types.js";

/** Per-user document key — must match the auth server's kb_doc_id(username). */
const kbDocId = (username: string) => `user_kb::${username}`;
const CACHE_TTL_MS = 5 * 60 * 1000; // re-fetch at most every 5 minutes

interface CacheEntry {
  kb: UserKnowledgeBase;
  fetchedAt: number;
}

/**
 * Loads and caches per-user knowledge base documents from Sync Gateway.
 *
 * The document must have `type: "user_kb"` and `id: "user_kb::{username}"` in the
 * `_default.user_data` collection. Workers can fall back to a local JSON
 * file when SG is unavailable or the document doesn't exist yet.
 */
export class KnowledgeBaseLoader {
  private config: SgConfig;
  private client: AxiosInstance;
  private cache = new Map<string, CacheEntry>();
  private sessions = new Map<string, { token: string; expiresAt: number }>();

  constructor(config: SgConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.url.replace(/\/$/, ""),
      timeout: 10_000,
    });
  }

  /**
   * Return the knowledge base for `username`.
   * Order of precedence:
   *   1. In-memory cache (if fresh)
   *   2. Sync Gateway `_default.user_data/user_kb`
   *   3. Local JSON file at `KB_FILE_<USERNAME>` env var path
   *   4. Empty KB (no-op — LLM still works, just without user context)
   */
  async load(username: string): Promise<UserKnowledgeBase> {
    const cached = this.cache.get(username);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.kb;
    }

    let kb = await this.loadFromSg(username);
    if (!kb) kb = await this.loadFromFile(username);
    if (!kb) {
      console.debug(`[kb] No knowledge base found for '${username}' — using empty defaults`);
      kb = { type: "user_kb", owner: username };
    }

    this.cache.set(username, { kb, fetchedAt: Date.now() });
    return kb;
  }

  /** Invalidate the cache for a user (e.g. after the app updates the KB doc). */
  invalidate(username: string): void {
    this.cache.delete(username);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async loadFromSg(username: string): Promise<UserKnowledgeBase | null> {
    try {
      const token = await this.getSessionToken(username);
      const url = `/${this.config.db}/_default.user_data/${encodeURIComponent(kbDocId(username))}`;
      const res = await this.client.get<UserKnowledgeBase>(url, {
        headers: { Cookie: `SyncGatewaySession=${token}` },
      });
      if (res.data?.type === "user_kb") {
        console.debug(`[kb] Loaded knowledge base for '${username}' from SG`);
        return res.data;
      }
      return null;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        // Document doesn't exist yet — not an error
        return null;
      }
      console.warn(`[kb] Could not load KB from SG for '${username}':`, (err as Error).message);
      return null;
    }
  }

  private async loadFromFile(username: string): Promise<UserKnowledgeBase | null> {
    const envKey = `KB_FILE_${username.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const filePath = process.env[envKey] ?? process.env["KB_FILE"];
    if (!filePath) return null;

    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as UserKnowledgeBase;
      console.debug(`[kb] Loaded knowledge base for '${username}' from ${filePath}`);
      return { ...parsed, owner: username, type: "user_kb" };
    } catch (err) {
      console.warn(`[kb] Could not read KB file '${filePath}' for '${username}':`, (err as Error).message);
      return null;
    }
  }

  private async getSessionToken(username: string): Promise<string> {
    const cached = this.sessions.get(username);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const password = this.resolvePassword(username);
    if (!password) throw new Error(`[kb] No password configured for user '${username}'`);

    const res = await this.client.post<{ session_id: string; expires: string }>(
      `/${this.config.db}/_session`,
      { name: username, password },
      { headers: { "Content-Type": "application/json" } }
    );
    const token = res.data.session_id;
    const expiresAt = res.data.expires
      ? new Date(res.data.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.sessions.set(username, { token, expiresAt });
    return token;
  }

  private resolvePassword(username: string): string | undefined {
    if (this.config.serviceUsername && this.config.servicePassword) return this.config.servicePassword;
    return this.config.userPasswords[username.toLowerCase()];
  }
}

// ── Prompt serialisation ───────────────────────────────────────────────────────

/**
 * Render a `UserKnowledgeBase` as a compact text block for injection into the
 * LLM system prompt. Returns an empty string for an empty KB.
 */
export function renderKbForPrompt(kb: UserKnowledgeBase): string {
  const lines: string[] = [];

  if (kb.displayName || kb.role || kb.timezone || kb.language) {
    lines.push("## User profile");
    if (kb.displayName) lines.push(`- Name: ${kb.displayName}`);
    if (kb.role)        lines.push(`- Role: ${kb.role}`);
    if (kb.timezone)    lines.push(`- Timezone: ${kb.timezone}`);
    if (kb.language)    lines.push(`- Preferred language: ${kb.language}`);
  }

  if (kb.projects?.length) {
    lines.push("\n## Active projects");
    for (const p of kb.projects) {
      const kw = p.keywords?.length ? ` [${p.keywords.join(", ")}]` : "";
      lines.push(`- ${p.name}${kw}${p.description ? ": " + p.description : ""}`);
    }
  }

  if (kb.contacts?.length) {
    lines.push("\n## Known contacts");
    for (const c of kb.contacts) {
      const rel = c.relationship ? ` (${c.relationship})` : "";
      const notes = c.notes ? ` — ${c.notes}` : "";
      lines.push(`- ${c.name}${rel}${notes}`);
    }
  }

  if (kb.ignorePatterns?.length) {
    lines.push("\n## Low-priority patterns (rarely need action)");
    lines.push(kb.ignorePatterns.map((p) => `- ${p}`).join("\n"));
  }

  if (kb.priorityPatterns?.length) {
    lines.push("\n## High-priority patterns (always create an action)");
    lines.push(kb.priorityPatterns.map((p) => `- ${p}`).join("\n"));
  }

  if (kb.customInstructions?.trim()) {
    lines.push("\n## Additional instructions");
    lines.push(kb.customInstructions.trim());
  }

  return lines.join("\n");
}
