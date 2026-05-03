import axios, { type AxiosInstance } from "axios";
import type { KbFact, KbFactProposal, SgConfig, SourceEvent } from "./types.js";

const USER_DATA_COLLECTION = "_default.user_data";

interface CachedSession {
  token: string;
  expiresAt: number;
}

/**
 * Writes `KbFactProposal` documents to the SG `user_data` collection.
 *
 * Deduplicates by `source_event_id` — if a proposal already exists for an
 * event, the write is skipped (idempotent).
 */
export class FactWriter {
  private sgConfig: SgConfig;
  private client: AxiosInstance;
  private sessions = new Map<string, CachedSession>();

  constructor(sgConfig: SgConfig) {
    this.sgConfig = sgConfig;
    this.client = axios.create({
      baseURL: sgConfig.url.replace(/\/$/, ""),
      timeout: 10_000,
    });
  }

  /**
   * Write a fact proposal for the given event and facts.
   * Returns the written proposal, or null if skipped (no facts / already exists).
   */
  async writeProposal(
    facts: KbFact[],
    event: SourceEvent,
    owner: string,
    workerName: string
  ): Promise<KbFactProposal | null> {
    if (facts.length === 0) return null;

    const docId = `kb_proposal::${owner}::${event.id}`;
    const now = new Date().toISOString();
    const proposal: KbFactProposal = {
      id: docId,
      type: "kb_fact_proposal",
      owner,
      source_event_id: event.id,
      source_event_title: event.title,
      source_worker: workerName,
      facts,
      created_at: now,
      updated_at: now,
    };

    const token = await this.getSessionToken(owner);
    const url = `/${this.sgConfig.db}/${USER_DATA_COLLECTION}/${encodeURIComponent(docId)}`;

    try {
      // Use POST to _bulk_docs with new_edits=true (default) so SG rejects
      // a duplicate via 409 Conflict rather than requiring a prior HEAD check.
      // This eliminates the TOCTOU window between "check exists" and "write".
      await this.client.put(url, proposal, {
        headers: {
          "Content-Type": "application/json",
          Cookie: `SyncGatewaySession=${token}`,
          // No _rev supplied — SG will reject with 409 if the doc already exists.
        },
      });
      console.log(`[fact-writer] Wrote ${facts.length} fact(s) for event '${event.id}' (owner: '${owner}').`);
      return proposal;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 409) {
          // Another worker already wrote this proposal — treat as success.
          console.debug(`[fact-writer] Proposal already exists for event '${event.id}' — skipping.`);
          return null;
        }
        if (err.response?.status === 401) {
          // Retry once with a fresh session.
          this.sessions.delete(owner);
          try {
            const fresh = await this.getSessionToken(owner);
            await this.client.put(url, proposal, {
              headers: {
                "Content-Type": "application/json",
                Cookie: `SyncGatewaySession=${fresh}`,
              },
            });
            return proposal;
          } catch (retryErr: unknown) {
            if (axios.isAxiosError(retryErr) && retryErr.response?.status === 409) {
              console.debug(`[fact-writer] Proposal already exists for event '${event.id}' — skipping.`);
              return null;
            }
            console.error(`[fact-writer] Write failed after re-auth for '${owner}':`, retryErr);
            return null;
          }
        }
      }
      console.error(`[fact-writer] Write failed for event '${event.id}':`, err);
      return null;
    }
  }

  private async getSessionToken(username: string): Promise<string> {
    const cached = this.sessions.get(username);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const password = this.resolvePassword(username);
    if (!password) throw new Error(`[fact-writer] No password configured for user '${username}'`);

    const res = await this.client.post<{ session_id: string; expires: string }>(
      `/${this.sgConfig.db}/_session`,
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
    if (this.sgConfig.serviceUsername && this.sgConfig.servicePassword) return this.sgConfig.servicePassword;
    return this.sgConfig.userPasswords[username.toLowerCase()];
  }
}
