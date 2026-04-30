import axios, { type AxiosInstance } from "axios";
import { randomUUID } from "crypto";
import type { ActionItemDoc, ActionItemDraft, SgConfig, SourceEvent } from "./types.js";

interface CachedSession {
  token: string;
  expiresAt: number;
}

export class SgWriter {
  private config: SgConfig;
  private client: AxiosInstance;
  private sessions = new Map<string, CachedSession>();

  constructor(config: SgConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: config.url.replace(/\/$/, ""),
      timeout: 15_000,
    });
  }

  /**
   * Build ActionItemDoc objects from drafts without writing them.
   * Gives the caller stable IDs so chunk docs can be written first.
   */
  buildActionDocs(
    drafts: ActionItemDraft[],
    event: SourceEvent,
    username: string
  ): ActionItemDoc[] {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    return drafts.map((draft) => ({
      id: `action-${randomUUID()}`,
      type: "action_item" as const,
      action_type: draft.action_type,
      title: draft.title,
      body: draft.body,
      raw_payload: {
        ...draft.raw_payload,
        source_event: {
          id: event.id,
          source: event.source,
          type: event.type,
          actor: event.actor,
          url: event.url,
          received_at: event.receivedAt,
        },
      },
      status: "pending" as const,
      owner: username,
      feedback: null,
      feedback_at: null,
      webhook_url: null,
      scheduled_date: today,
      created_at: now,
      updated_at: now,
      sync_mode: "synced" as const,
      local_only: false,
      vectorize: draft.vectorize ?? false,
    }));
  }

  /** Write pre-built ActionItemDocs to SG. Returns count written. */
  async writeActionDocs(docs: ActionItemDoc[], username: string): Promise<number> {
    if (docs.length === 0) return 0;
    const token = await this.getSessionToken(username);
    let written = 0;
    for (const doc of docs) {
      const ok = await this.putDocument(doc, token, username);
      if (ok) written++;
    }
    return written;
  }

  /** Write all action drafts derived from one event. Returns count written.
   *  Convenience wrapper — use buildActionDocs + writeActionDocs when you need
   *  to write chunk docs between the two steps.
   */
  async writeActions(
    drafts: ActionItemDraft[],
    event: SourceEvent,
    username: string
  ): Promise<number> {
    const docs = this.buildActionDocs(drafts, event, username);
    return this.writeActionDocs(docs, username);
  }

  private async putDocument(doc: ActionItemDoc, token: string, username: string): Promise<boolean> {
    const url = `/${this.config.db}/_default.actions/${doc.id}`;
    try {
      await this.client.put(url, doc, {
        headers: { "Content-Type": "application/json", Cookie: `SyncGatewaySession=${token}` },
      });
      console.log(`[sg] Wrote '${doc.action_type}' action for '${username}'.`);
      return true;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.sessions.delete(username);
        try {
          const fresh = await this.getSessionToken(username);
          await this.client.put(url, doc, {
            headers: { "Content-Type": "application/json", Cookie: `SyncGatewaySession=${fresh}` },
          });
          return true;
        } catch (retryErr) {
          console.error(`[sg] Write failed after re-auth for '${username}':`, retryErr);
          return false;
        }
      }
      console.error(`[sg] Write failed for '${username}':`, err);
      return false;
    }
  }

  private async getSessionToken(username: string): Promise<string> {
    const cached = this.sessions.get(username);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const password = this.resolvePassword(username);
    if (!password) throw new Error(`[sg] No password configured for user '${username}'`);

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
