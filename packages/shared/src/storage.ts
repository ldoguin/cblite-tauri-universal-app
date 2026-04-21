// ── DB helpers (adapter-agnostic) ─────────────────────────────────────────────

import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import type { Note, Conversation, SyncConfig, UserProfile, SavedServer } from "./types.js";
import { unwrapEncryptable, encryptNoteFields, decryptNoteFields } from "./note-encryption.js";

// ── Config / profile ──────────────────────────────────────────────────────────

/** One-time migration: stamp `owner` on any documents that pre-date the field. */
export async function migrateOwnerField(
  adapter: DatabaseAdapter,
  username: string
): Promise<void> {
  try {
    const notesRows = (await adapter.executeQuery("N1QL",
      "SELECT META().id AS id, title, content, content_text, created_at, updated_at" +
      " FROM notes WHERE owner IS MISSING",
      {}
    )) as Array<Record<string, unknown>>;
    for (const row of notesRows) {
      await adapter.saveDocument("notes", row.id as string, { ...row, owner: username });
    }

    const convRows = (await adapter.executeQuery("N1QL",
      "SELECT META().id AS id, title, messages, created_at, updated_at" +
      " FROM conversations WHERE owner IS MISSING",
      {}
    )) as Array<Record<string, unknown>>;
    for (const row of convRows) {
      await adapter.saveDocument("conversations", row.id as string, { ...row, owner: username });
    }

    if (notesRows.length + convRows.length > 0) {
      console.log(`[migrateOwnerField] Stamped owner on ${notesRows.length} note(s) and ${convRows.length} conversation(s)`);
    }
  } catch (e) {
    console.warn("[migrateOwnerField] Migration failed (non-fatal):", e);
  }
}

export async function loadSyncConfig(adapter: DatabaseAdapter): Promise<SyncConfig> {
  try {
    const cfg = await adapter.getDocument("_default", "sync_config") as SyncConfig;
    // Migration: fix existing saved configs with incorrect collection name
    if (cfg.collection === "notes") {
      cfg.collection = "_default.notes";
      await persistSyncConfig(adapter, cfg);
    }
    return cfg;
  } catch {
    return { url: "", collection: "_default.notes", direction: "both" };
  }
}

export async function persistSyncConfig(adapter: DatabaseAdapter, cfg: SyncConfig): Promise<void> {
  await adapter.saveDocument("_default", "sync_config", cfg);
}

export async function loadUserProfile(adapter: DatabaseAdapter): Promise<UserProfile | null> {
  try {
    const doc = (await adapter.getDocument("_default", "user_profile")) as UserProfile;
    return doc?.username ? doc : null;
  } catch {
    return null;
  }
}

export async function saveUserProfile(adapter: DatabaseAdapter, profile: UserProfile): Promise<void> {
  await adapter.saveDocument("_default", "user_profile", profile);
}

export async function loadSavedServers(adapter: DatabaseAdapter): Promise<SavedServer[]> {
  try {
    const doc = (await adapter.getDocument("_default", "servers_config")) as { servers: SavedServer[] };
    return Array.isArray(doc?.servers) ? doc.servers : [];
  } catch {
    return [];
  }
}

export async function persistSavedServers(adapter: DatabaseAdapter, servers: SavedServer[]): Promise<void> {
  await adapter.saveDocument("_default", "servers_config", { servers });
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export async function loadAllNotes(
  adapter: DatabaseAdapter,
  user: UserProfile | null,
  password: string | null
): Promise<Note[]> {
  const rows = (await adapter.executeQuery(
    "N1QL",
    "SELECT META().id AS id, title, content, content_text, created_at, updated_at " +
      "FROM notes " +
      "WHERE deleted IS MISSING OR deleted = false " +
      "ORDER BY updated_at DESC",
    {}
  )) as Array<Note & { title: unknown; content: unknown }>;

  const results: Note[] = [];
  for (const row of rows) {
    try {
      const rawTitle = unwrapEncryptable(row.title);
      const rawContent = unwrapEncryptable(row.content);
      const { title, content } = await decryptNoteFields(rawTitle, rawContent, user, password);
      results.push({ ...row, title, content });
    } catch (err) {
      console.error(`[loadAllNotes] Failed to load note ${row.id}:`, err);
    }
  }
  return results;
}

/** Persist a note document (DB only — caller must update local array). */
export async function saveNoteDoc(
  adapter: DatabaseAdapter,
  note: Note,
  user: UserProfile,
  password: string | null
): Promise<Note> {
  const updated = { ...note, updated_at: new Date().toISOString() };
  const { title, content } = await encryptNoteFields(updated.title, updated.content, user, password);
  const encFields = user.encryption_mode === "enterprise" ? ["title", "content"] : undefined;
  await adapter.saveDocument("notes", note.id, {
    title,
    content,
    content_text: updated.content_text ?? "",
    created_at: updated.created_at,
    updated_at: updated.updated_at,
    owner: user.username,
  }, encFields);
  return updated;
}

/** Soft-delete a note (DB only — caller must update local array). */
export async function deleteNoteDoc(
  adapter: DatabaseAdapter,
  id: string,
  username: string
): Promise<void> {
  await adapter.saveDocument("notes", id, { deleted: true, owner: username });
}

/** Full-text search: returns matching notes (or all if q is empty). */
export async function queryNotesBySearch(
  adapter: DatabaseAdapter,
  q: string,
  user: UserProfile | null,
  password: string | null
): Promise<Note[]> {
  if (!q) return loadAllNotes(adapter, user, password);

  // For app-level encryption content is encrypted in DB — filter in-memory
  if (user?.encryption_mode === "app-level") {
    const lq = q.toLowerCase();
    const all = await loadAllNotes(adapter, user, password);
    return all.filter(
      (n) => n.title.toLowerCase().includes(lq) || n.content.toLowerCase().includes(lq)
    );
  }

  const pattern = `%${q.toLowerCase()}%`;
  const rows = (await adapter.executeQuery(
    "N1QL",
    "SELECT META().id AS id, title, content, content_text, created_at, updated_at " +
      "FROM notes " +
      "WHERE LOWER(title) LIKE $pattern OR LOWER(content_text) LIKE $pattern",
    { pattern }
  )) as Note[];
  return rows.filter((r) => r && r.id);
}

// ── Conversations ─────────────────────────────────────────────────────────────

export async function queryAllConversations(adapter: DatabaseAdapter): Promise<Conversation[]> {
  const rows = (await adapter.executeQuery(
    "N1QL",
    "SELECT META().id AS id, title, messages, created_at, updated_at FROM conversations ORDER BY updated_at DESC",
    {}
  )) as Conversation[];
  return rows.filter((r) => r && r.id).map((r) => ({
    ...r,
    messages: Array.isArray(r.messages) ? r.messages : [],
  }));
}

/** Persist a conversation (DB only — caller must update local array). Returns updated conv. */
export async function saveConversationDoc(
  adapter: DatabaseAdapter,
  conv: Conversation,
  username: string
): Promise<Conversation> {
  const updated = { ...conv, updated_at: new Date().toISOString() };
  await adapter.saveDocument("conversations", conv.id, {
    title: updated.title,
    messages: updated.messages,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
    owner: username,
  });
  return updated;
}

/** Soft-delete a conversation (DB only — caller must update local array). */
export async function deleteConversationDoc(
  adapter: DatabaseAdapter,
  id: string,
  username: string
): Promise<void> {
  await adapter.saveDocument("conversations", id, { deleted: true, owner: username });
}
