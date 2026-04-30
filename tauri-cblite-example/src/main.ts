import { appLocalDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  openDatabase, closeDatabase, executeQuery, getDocument, saveDocument,
  startReplication as _startReplication, stopReplication,
  onCollectionChanged, onReplicationStatus,
  saveBlob, getBlobData, registerPredictiveModel, unregisterPredictiveModel,
} from "@cblite";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import "@cblite-uni-app/shared/components";
import {
  init, showError,
  editor, pendingAttachments, pendingAttachmentsEl,
  authSession, currentUser, encryptionPassword,
} from "@cblite-uni-app/shared/app";
import type { UserProfile, EncryptionMode } from "@cblite-uni-app/shared";

// ── DB adapter ────────────────────────────────────────────────────────────────

/**
 * Wraps the plugin's startReplication to always replicate notes, conversations,
 * tasks, actions, and chunks together in a single replicator.
 *
 * Local isolation of local_only documents is handled at two levels:
 *   1. The app omits local-only collections from the replicator list (app-level).
 *   2. The SG sync function throws forbidden when local_only === true (server-level).
 */
function startReplication(
  url: string,
  collection: string,
  direction: "push" | "pull" | "both",
  auth?: { username: string; password: string } | { sessionId: string; cookieName?: string },
  fieldEncryption?: { password: string; salt: string }
): Promise<void> {
  const primary = collection.includes(".") ? collection : `_default.${collection}`;
  const extras = [
    "_default.notes",
    "_default.conversations",
    "_default.tasks",
    "_default.actions",
    "_default.chunks",
  ].filter((c) => c !== primary);
  return _startReplication(url, primary, direction, auth, fieldEncryption, extras);
}

const adapter: DatabaseAdapter = {
  openDatabase, closeDatabase, getDocument, saveDocument, executeQuery,
  startReplication, stopReplication, saveBlob, getBlobData,
  onCollectionChanged, onReplicationStatus,
  registerPredictiveModel, unregisterPredictiveModel,
};

// ── Tauri file operations ─────────────────────────────────────────────────────

async function handleAttachImage(): Promise<void> {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
  });
  if (!path || typeof path !== "string") return;
  const bytes = await readFile(path);
  const b64 = btoa(String.fromCharCode(...bytes));
  const ext = path.split(".").pop()?.toLowerCase() ?? "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp"
    : ext === "svg" ? "image/svg+xml"
    : "image/png";
  const digest = await saveBlob(b64, mime);
  editor?.chain().focus().setImage({
    src: `data:${mime};base64,${b64}`,
    alt: path.split("/").pop() ?? "",
    // @ts-ignore — custom attr carried through by Tiptap
    "data-blob-digest": digest,
  }).run();
}

async function handleAttachFile(): Promise<void> {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: "Files", extensions: ["pdf", "mp3", "mp4", "wav", "ogg", "m4a"] }],
  });
  if (!path || typeof path !== "string") return;
  const bytes = await readFile(path);
  const b64 = btoa(String.fromCharCode(...bytes));
  const ext = path.split(".").pop()?.toLowerCase() ?? "bin";
  const mime = ext === "pdf" ? "application/pdf"
    : ext === "mp3" ? "audio/mpeg"
    : ext === "wav" ? "audio/wav"
    : ext === "ogg" ? "audio/ogg"
    : ext === "m4a" ? "audio/mp4"
    : ext === "mp4" ? "video/mp4"
    : "application/octet-stream";
  const digest = await saveBlob(b64, mime);
  const name = path.split("/").pop() ?? "attachment";
  editor?.chain().focus().insertContent(
    `<a href="cbl-blob:${digest}" data-blob-digest="${digest}">${name}</a>`
  ).run();
}

async function handleChatAttach(): Promise<void> {
  const path = await openFileDialog({ multiple: true, filters: [{ name: "All Files", extensions: ["*"] }] });
  const paths = Array.isArray(path) ? path : path ? [path] : [];
  for (const p of paths) {
    const bytes = await readFile(p);
    const b64 = btoa(String.fromCharCode(...bytes));
    const name = p.split("/").pop() ?? p;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "png" ? "image/png"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : ext === "pdf" ? "application/pdf"
      : ext === "mp3" ? "audio/mpeg"
      : ext === "mp4" ? "video/mp4"
      : ext === "wav" ? "audio/wav"
      : "application/octet-stream";
    const digest = await saveBlob(b64, mime);
    pendingAttachments.push({ digest, name, mime });
  }
  pendingAttachmentsEl.attachments = [...pendingAttachments];
}

// ── Platform hooks ────────────────────────────────────────────────────────────

const hooks = {
  getDbDir: () => appLocalDataDir(),
  attachImage: handleAttachImage,
  attachFile: handleAttachFile,
  chatAttach: handleChatAttach,
  getDbEncPassword: (profile: UserProfile, password: string) =>
    profile.encryption_mode === "enterprise" ? password : undefined,
  getSyncAuth: () => authSession?.gateway_session_id
    ? { sessionId: authSession.gateway_session_id, cookieName: authSession.gateway_cookie_name }
    : undefined,
  getSyncFieldEncryption: () =>
    currentUser?.encryption_mode === "enterprise" && encryptionPassword && currentUser.crypto_salt
      ? { password: encryptionPassword, salt: currentUser.crypto_salt }
      : undefined,
  includePasswordInSession: false,
  normalizeEncMode: (mode: string) => mode as EncryptionMode,
  onWindowUnload: (save: () => Promise<void>) => {
    getCurrentWindow().onCloseRequested(async () => {
      try { await save(); } catch { /* ignore save errors on close */ }
      // No preventDefault — Tauri awaits this handler, then closes normally.
    });
  },
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

window.addEventListener("unhandledrejection", (e) => {
  showError("Unhandled error: " + String(e.reason));
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    init(adapter, hooks).catch((e) => showError("init failed: " + String(e)));
  });
} else {
  init(adapter, hooks).catch((e) => showError("init failed: " + String(e)));
}
