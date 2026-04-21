import {
  openDatabase, closeDatabase, executeQuery, getDocument, saveDocument,
  startReplication, stopReplication, onCollectionChanged, onReplicationStatus,
  saveBlob, getBlobData, registerPredictiveModel, unregisterPredictiveModel,
} from "@cblite";
import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import "@cblite-uni-app/shared/components";
import {
  init, showError,
  editor, pendingAttachments, pendingAttachmentsEl,
  authSession,
} from "@cblite-uni-app/shared/app";
import type { EncryptionMode } from "@cblite-uni-app/shared";

// ── DB adapter ────────────────────────────────────────────────────────────────

const adapter: DatabaseAdapter = {
  openDatabase, closeDatabase, getDocument, saveDocument, executeQuery,
  startReplication, stopReplication, saveBlob, getBlobData,
  onCollectionChanged, onReplicationStatus,
  registerPredictiveModel, unregisterPredictiveModel,
};

// ── Browser file-picker helpers ───────────────────────────────────────────────

function pickFile(inputId: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.getElementById(inputId) as HTMLInputElement;
    input.value = "";
    const handler = () => { input.removeEventListener("change", handler); resolve(input.files?.[0] ?? null); };
    input.addEventListener("change", handler);
    input.click();
  });
}

function pickFiles(inputId: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.getElementById(inputId) as HTMLInputElement;
    input.value = "";
    const handler = () => { input.removeEventListener("change", handler); resolve(Array.from(input.files ?? [])); };
    input.addEventListener("change", handler);
    input.click();
  });
}

async function readFileAsB64(file: File): Promise<{ b64: string; mime: string }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { b64: btoa(binary), mime: file.type || "application/octet-stream" };
}

// ── Web file operations ───────────────────────────────────────────────────────

async function handleAttachImage(): Promise<void> {
  const file = await pickFile("file-picker-image");
  if (!file) return;
  const { b64, mime } = await readFileAsB64(file);
  const digest = await saveBlob(b64, mime);
  editor?.chain().focus().setImage({
    src: `data:${mime};base64,${b64}`,
    alt: file.name,
    // @ts-ignore — custom attr carried through by Tiptap
    "data-blob-digest": digest,
  }).run();
}

async function handleAttachFile(): Promise<void> {
  const file = await pickFile("file-picker-file");
  if (!file) return;
  const { b64, mime } = await readFileAsB64(file);
  const digest = await saveBlob(b64, mime);
  editor?.chain().focus().insertContent(
    `<a href="cbl-blob:${digest}" data-blob-digest="${digest}">${file.name}</a>`
  ).run();
}

async function handleChatAttach(): Promise<void> {
  const files = await pickFiles("file-picker-chat");
  for (const file of files) {
    const { b64, mime } = await readFileAsB64(file);
    const digest = await saveBlob(b64, mime);
    pendingAttachments.push({ digest, name: file.name, mime });
  }
  pendingAttachmentsEl.attachments = [...pendingAttachments];
}

// ── Platform hooks ────────────────────────────────────────────────────────────

const hooks = {
  getDbDir: async () => "",
  attachImage: handleAttachImage,
  attachFile: handleAttachFile,
  chatAttach: handleChatAttach,
  getDbEncPassword: () => undefined,
  getSyncAuth: () => authSession?.username && authSession?.password
    ? { username: authSession.username, password: authSession.password }
    : undefined,
  getSyncFieldEncryption: () => undefined,
  includePasswordInSession: true,
  normalizeEncMode: (mode: string): EncryptionMode => mode === "app-level" ? "app-level" : "none",
  onWindowUnload: (save: () => Promise<void>) => {
    window.addEventListener("beforeunload", (e) => {
      e.preventDefault();
      save().catch(console.error);
    });
  },
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

window.addEventListener("unhandledrejection", (e) => {
  // Replication (WebSocket) errors are expected when sync gateway is unreachable — swallow silently.
  const msg = String(e.reason);
  if (msg.toLowerCase().includes("websocket") || msg.toLowerCase().includes("replicat")) return;
  showError("Unhandled error: " + msg);
});

init(adapter, hooks).catch((e) => showError("init failed: " + String(e)));
