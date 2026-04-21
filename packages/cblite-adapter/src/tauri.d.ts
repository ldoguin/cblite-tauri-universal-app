// ── Type declarations for the @cblite Tauri plugin module ────────────────────
// This ambient declaration tells TypeScript about the types of @cblite.
// At build time, Vite resolves @cblite → tauri-plugin-cblite/guest-js/index.ts
// (desktop/Android) via the alias in vite.config.ts.

declare module "@cblite" {
  export const COLLECTION_CHANGED_EVENT: string;
  export const REPLICATION_STATUS_EVENT: string;

  export function openDatabase(
    path: string,
    name: string,
    encryptionPassword?: string,
    collections?: string[]
  ): Promise<void>;

  export function closeDatabase(): Promise<void>;

  export function getDocument(
    collection: string,
    docId: string
  ): Promise<unknown>;

  export function saveDocument(
    collection: string,
    docId: string,
    body: unknown,
    encryptedFields?: string[]
  ): Promise<void>;

  export function startReplication(
    url: string,
    collection: string,
    direction: "push" | "pull" | "both",
    auth?: { username: string; password: string } | { sessionId: string; cookieName?: string },
    fieldEncryption?: { password: string; salt: string }
  ): Promise<void>;

  export function stopReplication(): Promise<void>;

  export function executeQuery(
    language: "N1QL" | "JSON",
    queryStr: string,
    parameters?: Record<string, unknown>
  ): Promise<unknown[]>;

  export function registerPredictiveModel(
    name: string,
    options?: { onnxPath?: string; inputField?: string; outputField?: string }
  ): Promise<void>;

  export function unregisterPredictiveModel(name: string): Promise<void>;

  export function saveBlob(dataB64: string, contentType: string): Promise<string>;

  export function getBlobData(digest: string): Promise<string>;

  export function onCollectionChanged(
    handler: (docIds: string[]) => void
  ): Promise<() => void>;

  export function onReplicationStatus(
    handler: (activity: string) => void
  ): Promise<() => void>;
}
