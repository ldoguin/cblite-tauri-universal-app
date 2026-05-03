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

const COLLECTION_NAME = "processed_events";

export class DedupStore {
  private db: AnyRecord | null = null;
  private readonly dbPath: string;
  private readonly dbName: string;
  /** In-flight set: events claimed by this process but not yet persisted. */
  private readonly inFlight = new Set<string>();

  constructor(dbPath: string, dbName = "worker-state") {
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
    console.log(`[dedup] State DB '${this.dbName}' opened at ${this.dbPath}`);
  }

  async close(): Promise<void> {
    if (!this.db) return;
    try { await this.db.close(); } catch { /* ignore */ }
    this.db = null;
  }

  /**
   * Atomically claim an event for processing.
   *
   * Returns true if the caller should process this event; false if it is
   * already in-flight (claimed by a concurrent call in this process) or
   * already persisted in the DB.
   *
   * The in-flight check is synchronous within the Node.js event loop, so
   * two concurrent async callers cannot both receive true for the same id.
   */
  async claimEvent(eventId: string): Promise<boolean> {
    // Synchronous in-flight guard — safe within a single Node.js event loop tick.
    if (this.inFlight.has(eventId)) return false;
    this.inFlight.add(eventId);

    // Check persistent store.
    try {
      const coll = this.collection();
      const { DocID } = await cbl();
      const doc = await coll.getDocument(DocID(this.docId(eventId)));
      if (doc !== null && doc !== undefined) {
        this.inFlight.delete(eventId);
        return false;
      }
      return true;
    } catch (err) {
      this.inFlight.delete(eventId);
      throw err;
    }
  }

  /** Release an in-flight claim without persisting (call on processing failure). */
  releaseClaim(eventId: string): void {
    this.inFlight.delete(eventId);
  }

  async markProcessed(eventId: string): Promise<void> {
    const coll = this.collection();
    const { DocID } = await cbl();
    const id = this.docId(eventId);
    const existing = await coll.getDocument(DocID(id));
    if (!existing) {
      const doc = coll.createDocument(DocID(id), {
        event_id: eventId,
        processed_at: new Date().toISOString(),
      });
      await coll.save(doc);
    }
    this.inFlight.delete(eventId);
  }

  /** @deprecated Use claimEvent/releaseClaim/markProcessed instead. */
  async isProcessed(eventId: string): Promise<boolean> {
    if (this.inFlight.has(eventId)) return true;
    const coll = this.collection();
    const { DocID } = await cbl();
    const doc = await coll.getDocument(DocID(this.docId(eventId)));
    return doc !== null && doc !== undefined;
  }

  private collection(): AnyRecord {
    if (!this.db) throw new Error("[dedup] Store not open. Call open() first.");
    return this.db.getCollection(COLLECTION_NAME);
  }

  private docId(eventId: string): string {
    return "evt::" + Buffer.from(eventId).toString("base64url");
  }
}
