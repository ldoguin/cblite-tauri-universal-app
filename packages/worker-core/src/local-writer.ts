import type { ActionItemDoc, ActionItemDraft, SourceEvent } from "./types.js";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

interface CblModule {
  Database: {
    open(opts: { name: string; directory?: string; version: number; collections: AnyRecord }): Promise<AnyRecord>;
  };
  DocID: (id: string) => string;
}

let _cbl: CblModule | null = null;
async function cbl(): Promise<CblModule> {
  if (!_cbl) _cbl = await import("@couchbase/lite-js") as unknown as CblModule;
  return _cbl;
}

const COLLECTION_NAME = "actions";

/**
 * Writes action item documents directly to a local CBLite database,
 * bypassing Sync Gateway entirely. Used for sync_mode === "local" drafts.
 */
export class LocalWriter {
  private db: AnyRecord | null = null;
  private readonly dbPath: string;
  private readonly dbName: string;

  constructor(dbPath: string, dbName = "worker-local") {
    this.dbPath = dbPath;
    this.dbName = dbName;
  }

  async open(): Promise<void> {
    const { Database } = await cbl();
    this.db = await Database.open({
      name: this.dbName,
      directory: this.dbPath,
      version: 1,
      collections: { [COLLECTION_NAME]: {} },
    });
    console.log(`[local-writer] Local DB '${this.dbName}' opened at ${this.dbPath}`);
  }

  async close(): Promise<void> {
    if (!this.db) return;
    try { await this.db.close(); } catch { /* ignore */ }
    this.db = null;
  }

  /** Write local-only action drafts. Returns count written. */
  async writeActions(
    drafts: ActionItemDraft[],
    event: SourceEvent,
    username: string
  ): Promise<number> {
    if (drafts.length === 0) return 0;
    const coll = this.collection();
    const { DocID } = await cbl();
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    let written = 0;
    for (const draft of drafts) {
      const doc: ActionItemDoc = {
        id: `action-${randomUUID()}`,
        type: "action_item",
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
        status: "pending",
        owner: username,
        feedback: null,
        feedback_at: null,
        webhook_url: null,
        scheduled_date: today,
        created_at: now,
        updated_at: now,
        sync_mode: "local",
        local_only: true,
        vectorize: draft.vectorize ?? false,
      };

      try {
        const cblDoc = coll.createDocument(DocID(doc.id), doc);
        await coll.save(cblDoc);
        console.log(`[local-writer] Wrote local action '${doc.action_type}' for '${username}'.`);
        written++;
      } catch (err) {
        console.error(`[local-writer] Failed to write action for '${username}':`, err);
      }
    }
    return written;
  }

  private collection(): AnyRecord {
    if (!this.db) throw new Error("[local-writer] DB not open. Call open() first.");
    return this.db.getCollection(COLLECTION_NAME);
  }
}
