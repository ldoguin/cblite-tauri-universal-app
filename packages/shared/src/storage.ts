// ── DB helpers (adapter-agnostic) ─────────────────────────────────────────────

import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import type { Note, Conversation, SyncConfig, UserProfile, SavedServer, Board, Column, Task, ActionItem, ActionStatus, ChunkDoc, KbFactProposal } from "./types.js";
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

// ── Boards ────────────────────────────────────────────────────────────────────

export async function loadBoards(
  adapter: DatabaseAdapter,
  username: string
): Promise<Board[]> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, name, owner, members, column_order, created_at, updated_at" +
        " FROM tasks" +
        " WHERE type = 'board'" +
        " AND (deleted IS MISSING OR deleted = false)" +
        " ORDER BY created_at ASC",
      {}
    )) as Array<Board & { members: unknown }>;
    return rows
      .filter((r) => r && r.id)
      .filter((r) => r.owner === username || (Array.isArray(r.members) && r.members.includes(username)))
      .map((r) => ({ ...r, members: Array.isArray(r.members) ? r.members : [], column_order: Array.isArray(r.column_order) ? r.column_order : [] }));
  } catch {
    return [];
  }
}

export async function saveBoardDoc(
  adapter: DatabaseAdapter,
  board: Board
): Promise<Board> {
  const updated = { ...board, updated_at: new Date().toISOString() };
  await adapter.saveDocument("tasks", board.id, {
    type: "board",
    name: updated.name,
    owner: updated.owner,
    members: updated.members,
    column_order: updated.column_order,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
    board_id: board.id, // required by SG sync function
  });
  return updated;
}

export async function deleteBoardDoc(
  adapter: DatabaseAdapter,
  id: string,
  username: string
): Promise<void> {
  await adapter.saveDocument("tasks", id, { deleted: true, owner: username, board_id: id });
}

// ── Columns ───────────────────────────────────────────────────────────────────

export async function loadColumns(
  adapter: DatabaseAdapter,
  boardId: string
): Promise<Column[]> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, board_id, name, position, created_at, updated_at" +
        " FROM tasks" +
        " WHERE type = 'column'" +
        " AND board_id = $boardId" +
        " AND (deleted IS MISSING OR deleted = false)" +
        " ORDER BY position ASC",
      { boardId }
    )) as Column[];
    return rows.filter((r) => r && r.id);
  } catch {
    return [];
  }
}

export async function saveColumnDoc(
  adapter: DatabaseAdapter,
  col: Column
): Promise<Column> {
  const updated = { ...col, updated_at: new Date().toISOString() };
  await adapter.saveDocument("tasks", col.id, {
    type: "column",
    board_id: updated.board_id,
    name: updated.name,
    position: updated.position,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
  });
  return updated;
}

export async function deleteColumnDoc(
  adapter: DatabaseAdapter,
  id: string,
  boardId: string
): Promise<void> {
  await adapter.saveDocument("tasks", id, { deleted: true, board_id: boardId });
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export async function loadTasks(
  adapter: DatabaseAdapter,
  boardId: string
): Promise<Task[]> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, board_id, column_id, title, description," +
        " assignee, due_date, labels, position, owner, created_at, updated_at" +
        " FROM tasks" +
        " WHERE type = 'task'" +
        " AND board_id = $boardId" +
        " AND (deleted IS MISSING OR deleted = false)" +
        " ORDER BY position ASC",
      { boardId }
    )) as Array<Task & { labels: unknown }>;
    return rows
      .filter((r) => r && r.id)
      .map((r) => ({ ...r, labels: Array.isArray(r.labels) ? r.labels : [] }));
  } catch {
    return [];
  }
}

export async function saveTaskDoc(
  adapter: DatabaseAdapter,
  task: Task
): Promise<Task> {
  const updated = { ...task, updated_at: new Date().toISOString() };
  await adapter.saveDocument("tasks", task.id, {
    type: "task",
    board_id: updated.board_id,
    column_id: updated.column_id,
    title: updated.title,
    description: updated.description,
    assignee: updated.assignee,
    due_date: updated.due_date,
    labels: updated.labels,
    position: updated.position,
    owner: updated.owner,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
  });
  return updated;
}

export async function deleteTaskDoc(
  adapter: DatabaseAdapter,
  id: string,
  boardId: string
): Promise<void> {
  await adapter.saveDocument("tasks", id, { deleted: true, board_id: boardId });
}

// ── Action Items ──────────────────────────────────────────────────────────────

/**
 * Load action items for a user.
 * @param dateFilter  ISO date string (YYYY-MM-DD). When provided, returns only
 *                    items whose scheduled_date matches OR is null.
 */
export async function loadActionItems(
  adapter: DatabaseAdapter,
  username: string,
  dateFilter?: string
): Promise<ActionItem[]> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, action_type, title, body, raw_payload," +
        " status, owner, feedback, feedback_at, webhook_url, scheduled_date," +
        " created_at, updated_at" +
        " FROM actions" +
        " WHERE type = 'action_item'" +
        " AND owner = $username" +
        " AND (deleted IS MISSING OR deleted = false)" +
        " ORDER BY created_at DESC",
      { username }
    )) as ActionItem[];

    const items = rows.filter((r) => r && r.id);

    if (dateFilter) {
      return items.filter(
        (r) => r.scheduled_date === null || r.scheduled_date === dateFilter
      );
    }
    return items;
  } catch {
    return [];
  }
}

export async function saveActionItem(
  adapter: DatabaseAdapter,
  item: ActionItem
): Promise<ActionItem> {
  const updated = { ...item, updated_at: new Date().toISOString() };
  await adapter.saveDocument("actions", item.id, {
    type: "action_item",
    action_type: updated.action_type,
    title: updated.title,
    body: updated.body,
    raw_payload: updated.raw_payload,
    status: updated.status,
    owner: updated.owner,
    feedback: updated.feedback,
    feedback_at: updated.feedback_at,
    webhook_url: updated.webhook_url,
    scheduled_date: updated.scheduled_date,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
  });
  return updated;
}

export async function updateActionStatus(
  adapter: DatabaseAdapter,
  item: ActionItem,
  status: ActionStatus,
  feedback?: string
): Promise<ActionItem> {
  const now = new Date().toISOString();
  const updated: ActionItem = {
    ...item,
    status,
    feedback: feedback ?? item.feedback,
    feedback_at: feedback ? now : item.feedback_at,
    updated_at: now,
  };
  return saveActionItem(adapter, updated);
}

// ── KB Fact Proposals ─────────────────────────────────────────────────────────

/**
 * Load all pending KB fact proposals for the current user.
 * Proposals live in the `actions` collection (synced from SG private-db).
 */
export async function loadKbProposals(
  adapter: DatabaseAdapter,
  username: string
): Promise<KbFactProposal[]> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, owner, source_event_id, source_event_title," +
        " source_worker, facts, created_at, updated_at" +
        " FROM user_data" +
        " WHERE type = 'kb_fact_proposal'" +
        " AND owner = $username" +
        " AND (deleted IS MISSING OR deleted = false)" +
        " ORDER BY created_at DESC",
      { username }
    )) as Array<KbFactProposal & { facts: unknown }>;
    return rows
      .filter((r) => r && r.id)
      .map((r) => ({ ...r, facts: Array.isArray(r.facts) ? r.facts : [] }));
  } catch {
    return [];
  }
}

// ── User Knowledge Base ───────────────────────────────────────────────────────

/** Load the approved user_kb document from the local CBLite store. */
export async function loadUserKb(
  adapter: DatabaseAdapter,
  username: string
): Promise<import("./types.js").UserKnowledgeBase | null> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, owner, displayName, role, timezone, language," +
        " projects, contacts, ignorePatterns, priorityPatterns, customInstructions," +
        " facts, created_at, updated_at" +
        " FROM user_data" +
        " WHERE type = 'user_kb' AND owner = $username" +
        " LIMIT 1",
      { username }
    )) as Array<import("./types.js").UserKnowledgeBase>;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// ── Chunks ────────────────────────────────────────────────────────────────────

/** Upsert a chunk document in the `chunks` collection. */
export async function saveChunkDoc(
  adapter: DatabaseAdapter,
  chunk: ChunkDoc
): Promise<void> {
  await adapter.saveDocument("chunks", chunk.id, {
    type: "chunk",
    source_id: chunk.source_id,
    source_collection: chunk.source_collection,
    source_owner: chunk.source_owner,
    chunk_index: chunk.chunk_index,
    text: chunk.text,
    ...(chunk.local_embedding !== undefined ? { local_embedding: chunk.local_embedding } : {}),
    ...(chunk.server_embedding !== undefined ? { server_embedding: chunk.server_embedding } : {}),
    created_at: chunk.created_at,
    updated_at: chunk.updated_at,
  });
}

/** Load all chunk docs for a given source document. */
export async function loadChunksBySource(
  adapter: DatabaseAdapter,
  sourceId: string
): Promise<ChunkDoc[]> {
  try {
    const rows = (await adapter.executeQuery(
      "N1QL",
      "SELECT META().id AS id, type, source_id, source_collection, source_owner," +
        " chunk_index, text, local_embedding, server_embedding, created_at, updated_at" +
        " FROM chunks" +
        " WHERE type = 'chunk' AND source_id = $sourceId" +
        " ORDER BY chunk_index ASC",
      { sourceId }
    )) as ChunkDoc[];
    return rows.filter((r) => r && r.id);
  } catch {
    return [];
  }
}

/**
 * Ensure a CBLite vector index exists on the `local_embedding` field of the
 * `chunks` collection. Called once after the database is opened.
 *
 * Uses the `registerPredictiveModel` adapter hook as a proxy — the actual
 * vector index creation is handled by the Tauri plugin via the ONNX model
 * registration path. For the web adapter this is a no-op.
 */
/**
 * Create a cosine-distance vector index on `chunks.local_embedding`.
 *
 * Uses 384 dimensions (all-MiniLM-L6-v2 output size) and SQ8 scalar
 * quantization. Non-fatal — if the platform doesn't support vector indexes
 * (web adapter, Android) the call is silently ignored and local RAG falls
 * back to keyword search.
 */
export async function ensureVectorIndex(adapter: DatabaseAdapter): Promise<void> {
  try {
    await adapter.createVectorIndex(
      "_default.chunks",
      "chunks_local_embedding_idx",
      "local_embedding",
      384,   // all-MiniLM-L6-v2 output dimensions
      0      // centroids = 0 → CBLite auto-selects sqrt(n)
    );
  } catch {
    // Non-fatal — vector search degrades gracefully if index is unavailable.
  }
}
