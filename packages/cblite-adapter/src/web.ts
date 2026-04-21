// ── Couchbase Lite JavaScript web adapter ─────────────────────────────────────
// Implements the same interface as the Tauri @cblite module, backed by
// @couchbase/lite-js (https://docs.couchbase.com/couchbase-lite-javascript/)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

// Lazily resolved @couchbase/lite-js exports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cbl: any = null;
async function cbl(): Promise<AnyRecord> {
  if (!_cbl) _cbl = await import("@couchbase/lite-js");
  return _cbl;
}

// Module-level state
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let replicator: any = null;
// Change listener cleanup tokens: [{ coll, token }]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeListenerTokens: Array<{ coll: any; token: any }> = [];
// Handler registered via onReplicationStatus
let _replicationStatusHandler: ((activity: string, error?: string) => void) | null = null;

// Collections created / accessed by this adapter.
// "metadata" is used in place of "_default" because @couchbase/lite-js does
// not expose the built-in _default collection via getCollection('_default').
const NAMED_COLLECTIONS = ["notes", "conversations", "blobs", "metadata"] as const;

/** Map the Tauri convention of using "_default" for app metadata to "metadata". */
function resolveCollectionName(name: string): string {
  return name === "_default" ? "metadata" : name;
}

// ── Public constants (mirrors cblite.d.ts) ────────────────────────────────────
export const COLLECTION_CHANGED_EVENT = "cblite://collection-changed";
export const REPLICATION_STATUS_EVENT = "cblite://replication-status";

// ── openDatabase ──────────────────────────────────────────────────────────────

export async function openDatabase(
  _path: string,
  name: string,
  _encryptionPassword?: string,
  _collections?: string[]
): Promise<void> {
  if (db) {
    try {
      await closeDatabase();
    } catch { /* ignore */ }
  }

  const { Database } = await cbl();

  const collectionsConfig: AnyRecord = {};
  for (const c of NAMED_COLLECTIONS) collectionsConfig[c] = {};

  db = await Database.open({
    name,
    version: 1,
    collections: collectionsConfig,
  });
}

// ── closeDatabase ─────────────────────────────────────────────────────────────

export async function closeDatabase(): Promise<void> {
  if (!db) return;

  // Remove all outstanding collection change listeners
  for (const { coll, token } of activeListenerTokens) {
    try { coll.removeChangeListener(token); } catch { /* ignore */ }
  }
  activeListenerTokens.length = 0;

  _replicationStatusHandler = null;

  try { await db.close(); } catch { /* ignore */ }
  db = null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function requireDb(): void {
  if (!db) throw new Error("Database is not open");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCollection(collectionName: string): any {
  requireDb();
  return db.getCollection(resolveCollectionName(collectionName));
}

// ── getDocument ───────────────────────────────────────────────────────────────

export async function getDocument(
  collection: string,
  docId: string
): Promise<unknown> {
  const { DocID } = await cbl();
  const coll = getCollection(collection);
  const doc = await coll.getDocument(DocID(docId));
  if (!doc) return null;
  return doc;
}

// ── saveDocument ──────────────────────────────────────────────────────────────

export async function saveDocument(
  collection: string,
  docId: string,
  body: unknown,
  _encryptedFields?: string[]
): Promise<void> {
  const { DocID } = await cbl();
  const coll = getCollection(collection);
  const data = body as AnyRecord;

  let doc = await coll.getDocument(DocID(docId));
  if (doc) {
    // Merge new fields onto the existing mutable document
    for (const [k, v] of Object.entries(data)) {
      doc[k] = v;
    }
    await coll.save(doc);
  } else {
    const newDoc = coll.createDocument(DocID(docId), data);
    await coll.save(newDoc);
  }
}

// ── executeQuery ──────────────────────────────────────────────────────────────

export async function executeQuery(
  _language: "N1QL" | "JSON",
  queryStr: string,
  parameters?: Record<string, unknown>
): Promise<unknown[]> {
  requireDb();

  // Normalize scope-qualified collection names: "FROM _default.X" → "FROM X"
  const normalized = queryStr.replace(/FROM\s+_default\./gi, "FROM ");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query: any = db.createQuery(normalized);
  if (parameters && Object.keys(parameters).length > 0) {
    query.parameters = parameters;
  }
  return query.execute();
}

// ── startReplication ──────────────────────────────────────────────────────────

export async function startReplication(
  url: string,
  collection: string,
  direction: "push" | "pull" | "both",
  auth?: { username: string; password: string } | { sessionId: string; cookieName?: string },
  _fieldEncryption?: { password: string; salt: string }
): Promise<void> {
  if (replicator) {
    try { replicator.stop(); } catch { /* ignore */ }
    replicator = null;
  }

  const { Replicator } = await cbl();

  // Strip optional scope prefix so we get the bare collection name
  const collName = collection.replace(/^_default\./, "");

  function directionConfig() {
    const d: AnyRecord = {};
    if (direction === "pull" || direction === "both") d.pull = { continuous: true };
    if (direction === "push" || direction === "both") d.push = { continuous: true };
    return d;
  }

  const collectionsConfig: AnyRecord = {
    [collName]: directionConfig(),
    conversations: directionConfig(),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: AnyRecord = {
    database: db,
    url,
    collections: collectionsConfig,
    // Note: @couchbase/lite-js Replicator has no "continuous" config flag;
    // it stays alive until stop() is called (WebSocket remains open).
  };

  if (auth && "username" in auth) {
    config.credentials = { username: auth.username, password: auth.password };
  }
  // Note: session-cookie auth (gateway_session_id) is not yet exposed in the
  // CBLite JS public API surface — basic-auth credentials are used instead.

  replicator = new Replicator(config);

  replicator.onStatusChange = (status: AnyRecord) => {
    if (_replicationStatusHandler) {
      const error: string | undefined = status.error ? String(status.error) : undefined;
      _replicationStatusHandler(mapActivity(status.status ?? status), error);
    }
  };

  // run() returns a Promise that resolves only when replication ends (or on error).
  // Fire-and-forget — let it run in the background; stop() cancels it.
  replicator.run().catch((err: unknown) => {
    console.error("[replicator] run error:", err);
    if (_replicationStatusHandler) _replicationStatusHandler("stopped", String(err));
  });
}

// ── stopReplication ───────────────────────────────────────────────────────────

export async function stopReplication(): Promise<void> {
  if (replicator) {
    try { replicator.stop(); } catch { /* ignore */ }
    replicator = null;
  }
}

// ── saveBlob ──────────────────────────────────────────────────────────────────
// Stores binary data in the "blobs" collection and returns an opaque ID that
// can later be passed to getBlobData().  We use a UUID so the ID is known
// before the save round-trip, avoiding a second read to retrieve the CBLite
// digest.

export async function saveBlob(dataB64: string, contentType: string): Promise<string> {
  const { DocID, NewBlob } = await cbl();
  const buffer = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
  const blob = new NewBlob(buffer, contentType);

  const blobId = "blob-" + crypto.randomUUID();
  const coll = getCollection("blobs");
  const doc = coll.createDocument(DocID(blobId), { data: blob, contentType });
  await coll.save(doc);
  return blobId;
}

// ── getBlobData ───────────────────────────────────────────────────────────────

export async function getBlobData(digest: string): Promise<string> {
  const { DocID } = await cbl();
  const coll = getCollection("blobs");
  const doc = await coll.getDocument(DocID(digest));
  if (!doc) throw new Error(`Blob not found: ${digest}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob: any = doc.data;
  if (!blob) throw new Error(`Blob document has no 'data' field: ${digest}`);

  const contents: Uint8Array = await blob.getContents();
  // Convert Uint8Array → base64
  let binary = "";
  const len = contents.length;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(contents[i]);
  return btoa(binary);
}

// ── onCollectionChanged ───────────────────────────────────────────────────────

export async function onCollectionChanged(
  handler: (docIds: string[]) => void
): Promise<() => void> {
  const localTokens: Array<{ coll: unknown; token: unknown }> = [];

  for (const collName of ["notes", "conversations"] as const) {
    const coll = getCollection(collName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = coll.addChangeListener((changes: any) => {
      handler(Array.isArray(changes.documentIDs) ? changes.documentIDs : []);
    });
    const entry = { coll, token };
    localTokens.push(entry);
    activeListenerTokens.push(entry);
  }

  return () => {
    for (const { coll, token } of localTokens) {
      try { (coll as AnyRecord).removeChangeListener(token); } catch { /* ignore */ }
      const idx = activeListenerTokens.findIndex((t) => t.token === token);
      if (idx >= 0) activeListenerTokens.splice(idx, 1);
    }
  };
}

// ── onReplicationStatus ───────────────────────────────────────────────────────

export async function onReplicationStatus(
  handler: (activity: string, error?: string) => void
): Promise<() => void> {
  _replicationStatusHandler = handler;

  // If a replicator is already running, wire it up immediately
  if (replicator) {
    replicator.onStatusChange = (status: AnyRecord) => {
      handler(mapActivity(status.status ?? status));
    };
  }

  return () => {
    _replicationStatusHandler = null;
  };
}

// ── Predictive model stubs (not supported in browser) ────────────────────────

export async function registerPredictiveModel(
  _name: string,
  _options?: { onnxPath?: string; inputField?: string; outputField?: string }
): Promise<void> {
  console.warn("[cblite-web] registerPredictiveModel is not supported in the browser");
}

export async function unregisterPredictiveModel(_name: string): Promise<void> {
  console.warn("[cblite-web] unregisterPredictiveModel is not supported in the browser");
}

// ── Internal: map CBLite activity enum → CSS-friendly string ─────────────────

function mapActivity(status: string | undefined): string {
  if (!status) return "idle";
  const s = String(status).toLowerCase();
  if (s.includes("stop")) return "stopped";
  if (s.includes("connect")) return "connecting";
  if (s.includes("busy") || s.includes("activ")) return "busy";
  if (s.includes("offline")) return "stopped";
  return "idle";
}
