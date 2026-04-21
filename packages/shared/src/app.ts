// ── Shared application logic ──────────────────────────────────────────────────
// All platform-agnostic state and UI functions for the cblite-uni-app.
// Platform-specific behaviour is injected via PlatformHooks at startup.

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Youtube from "@tiptap/extension-youtube";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import type {
  Note, Conversation, SyncConfig, UserProfile, AuthSession, SavedServer,
  ChatAttachment, EncryptionMode,
} from "./types.js";
import type {
  CblNoteList, CblConvList, CblChatMessages, CblPendingAttachments, CblServerList,
} from "./components/index.js";
import {
  migrateOwnerField as migrateOwnerFieldDB,
  loadSyncConfig as loadSyncConfigDB,
  persistSyncConfig as persistSyncConfigDB,
  loadUserProfile as loadUserProfileDB,
  saveUserProfile as saveUserProfileDB,
  loadSavedServers as loadSavedServersDB,
  persistSavedServers as persistSavedServersDB,
  loadAllNotes as loadAllNotesDB,
  saveNoteDoc, deleteNoteDoc,
  queryNotesBySearch as queryNotesBySearchDB,
  queryAllConversations as queryAllConversationsDB,
  saveConversationDoc, deleteConversationDoc,
} from "./storage.js";
import { generateSalt } from "./crypto.js";
import {
  serverLogin, serverRegister,
  fetchSyncConfig as fetchSyncConfigFromServer,
} from "./server.js";
import type { SyncConfigFromServer } from "./server.js";
import { resolveSyncUrl, userDbName } from "./auth-helpers.js";
import { parseContent, extractPlainText, resolveBlobRefs, stripDataUris } from "./editor-helpers.js";
import { getAIReply as getAIReplyShared } from "./ai.js";

// ── Platform hooks ────────────────────────────────────────────────────────────

export interface PlatformHooks {
  /** Returns the DB directory (Tauri: appLocalDataDir(); Web: "") */
  getDbDir: () => Promise<string>;
  /** Pick an image file and insert it into the note editor */
  attachImage: () => Promise<void>;
  /** Pick a file and insert a blob link into the note editor */
  attachFile: () => Promise<void>;
  /** Pick one or more files and add them to pending chat attachments */
  chatAttach: () => Promise<void>;
  /**
   * Return the DB-level encryption password for openDatabase.
   * Tauri: password for enterprise mode. Web: always undefined.
   */
  getDbEncPassword: (profile: UserProfile, password: string) => string | undefined;
  /**
   * Return the replication auth parameter.
   * Tauri: gateway session cookie. Web: basic auth {username, password}.
   */
  getSyncAuth: () => { sessionId: string; cookieName?: string } | { username: string; password: string } | undefined;
  /**
   * Return field-encryption params for replication.
   * Tauri enterprise only. Web: always undefined.
   */
  getSyncFieldEncryption: () => { password: string; salt: string } | undefined;
  /** Whether to store the plaintext password in AuthSession (web uses it for basic auth) */
  includePasswordInSession: boolean;
  /**
   * Normalize the encryption mode string from the create-account form.
   * Tauri: pass through as EncryptionMode. Web: map unknown values to "none".
   */
  normalizeEncMode: (mode: string) => EncryptionMode;
  /** Register a callback for window-close / page-unload to flush dirty notes */
  onWindowUnload: (save: () => Promise<void>) => void;
}

// ── Module-level state ────────────────────────────────────────────────────────
// Exported bindings let platform hooks in main.ts read live values via ES module
// live-binding semantics.

let _adapter: DatabaseAdapter;
let _hooks: PlatformHooks;

let notes: Note[] = [];
let selectedId: string | null = null;
let syncConfig: SyncConfig = { url: "", collection: "_default.notes", direction: "both" };
let isDirty = false;
let searchQuery = "";
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
export let currentUser: UserProfile | null = null;
export let authSession: AuthSession | null = null;
export let encryptionPassword: string | null = null;
let serverUrl = "";
let savedServers: SavedServer[] = [];
let dbDir = "";
let unlistenCollection: (() => void) | null = null;
let unlistenReplication: (() => void) | null = null;
export let editor: Editor | null = null;
let editorInitialized = false;
let conversations: Conversation[] = [];
let selectedConvId: string | null = null;
export let pendingAttachments: ChatAttachment[] = [];

let noteListEl: CblNoteList;
let convListEl: CblConvList;
let chatMessagesEl: CblChatMessages;
export let pendingAttachmentsEl: CblPendingAttachments;
let serverListEl: CblServerList;

// ── Error display ─────────────────────────────────────────────────────────────

export function showError(msg: string): void {
  console.error(msg);
  const banner = document.getElementById("error-banner");
  if (!banner) return;
  banner.textContent = msg;
  banner.style.display = "block";
  setTimeout(() => { banner.style.display = "none"; }, 8000);
}

// ── Component setup ───────────────────────────────────────────────────────────

function setupComponents(): void {
  noteListEl = document.getElementById("note-list") as unknown as CblNoteList;
  convListEl = document.getElementById("conv-list") as unknown as CblConvList;
  chatMessagesEl = document.getElementById("chat-messages") as unknown as CblChatMessages;
  pendingAttachmentsEl = document.getElementById("chat-pending-attachments") as unknown as CblPendingAttachments;
  serverListEl = document.getElementById("server-list") as unknown as CblServerList;
  chatMessagesEl.getBlobData = (digest: string) => _adapter.getBlobData(digest);

  noteListEl.addEventListener("cbl-note-select", (e) =>
    selectNote((e as CustomEvent<{ id: string }>).detail.id).catch(console.error)
  );
  convListEl.addEventListener("cbl-conv-select", (e) =>
    selectConversation((e as CustomEvent<{ id: string }>).detail.id)
  );
  serverListEl.addEventListener("cbl-server-connect", (e) =>
    connectToServer((e as CustomEvent<{ url: string }>).detail.url).catch(console.error)
  );
  serverListEl.addEventListener("cbl-server-remove", (e) =>
    removeServer((e as CustomEvent<{ index: number }>).detail.index).catch(console.error)
  );
  pendingAttachmentsEl.addEventListener("cbl-attachment-remove", (e) => {
    pendingAttachments.splice((e as CustomEvent<{ index: number }>).detail.index, 1);
    pendingAttachmentsEl.attachments = [...pendingAttachments];
  });
}

// ── Rich text editor ──────────────────────────────────────────────────────────

function initEditor(): void {
  if (editorInitialized) return;
  editorInitialized = true;

  editor = new Editor({
    element: document.getElementById("rich-editor")!,
    extensions: [
      StarterKit,
      Image.configure({ inline: false, allowBase64: true }),
      Link.configure({ openOnClick: false }),
      Youtube.configure({ width: 480, height: 320 }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: "Start writing…" }),
    ],
    content: "",
    onUpdate: () => { isDirty = true; },
  });

  document.getElementById("editor-toolbar")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
    if (!btn || !editor) return;
    const cmd = btn.dataset["cmd"]!;
    const chain = editor.chain().focus();
    switch (cmd) {
      case "bold":        chain.toggleBold().run(); break;
      case "italic":      chain.toggleItalic().run(); break;
      case "strike":      chain.toggleStrike().run(); break;
      case "h1":          chain.toggleHeading({ level: 1 }).run(); break;
      case "h2":          chain.toggleHeading({ level: 2 }).run(); break;
      case "h3":          chain.toggleHeading({ level: 3 }).run(); break;
      case "bulletList":  chain.toggleBulletList().run(); break;
      case "orderedList": chain.toggleOrderedList().run(); break;
      case "taskList":    chain.toggleTaskList().run(); break;
      case "codeBlock":   chain.toggleCodeBlock().run(); break;
      case "blockquote":  chain.toggleBlockquote().run(); break;
      case "insertDate":
        chain.insertContent(new Date().toLocaleDateString()).run();
        break;
      case "attachImage":
        _hooks.attachImage().catch(console.error);
        break;
      case "attachFile":
        _hooks.attachFile().catch(console.error);
        break;
      case "embedYoutube": {
        const url = prompt("YouTube URL:");
        if (url) chain.setYoutubeVideo({ src: url }).run();
        break;
      }
    }
  });
}

// ── Note operations ───────────────────────────────────────────────────────────

async function createNote(): Promise<Note> {
  const id = `note-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const note: Note = { id, title: "New Note", content: "", content_text: "", created_at: now, updated_at: now };
  await saveNoteDoc(_adapter, note, currentUser!, encryptionPassword);
  return note;
}

async function saveNote(note: Note): Promise<void> {
  if (editor && note.id === selectedId) {
    const doc = stripDataUris(editor.getJSON());
    note.content = JSON.stringify(doc);
    note.content_text = extractPlainText(doc);
  }
  const updated = await saveNoteDoc(_adapter, note, currentUser!, encryptionPassword);
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx >= 0) notes[idx] = updated;
}

async function deleteNote(id: string): Promise<void> {
  await deleteNoteDoc(_adapter, id, currentUser!.username);
  notes = notes.filter((n) => n.id !== id);
}

async function searchNotes(q: string): Promise<void> {
  notes = await queryNotesBySearchDB(_adapter, q, currentUser, encryptionPassword);
  noteListEl.notes = notes;
}

async function selectNote(id: string): Promise<void> {
  if (isDirty && selectedId && selectedId !== id) {
    const current = notes.find((n) => n.id === selectedId);
    if (current) {
      current.title = (document.getElementById("note-title") as HTMLInputElement).value;
      await saveNote(current);
      isDirty = false;
    }
  }
  selectedId = id;
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  document.getElementById("editor-empty")!.hidden = true;
  document.getElementById("editor-content")!.hidden = false;
  mobileOpenEditor();
  (document.getElementById("note-title") as HTMLInputElement).value = note.title;
  const doc = await resolveBlobRefs(parseContent(note.content), (digest: string) => _adapter.getBlobData(digest));
  editor?.commands.setContent(doc as Parameters<typeof editor.commands.setContent>[0]);
  isDirty = false;
  noteListEl.selectedId = selectedId;
}

// ── Status ────────────────────────────────────────────────────────────────────

export function setStatus(activity: string): void {
  const cls = "status-dot " + activity.toLowerCase();
  document.getElementById("status-dot")!.className = cls;
  document.getElementById("status-dot-profile")!.className = cls;
  document.getElementById("status-label")!.textContent = activity;
  document.getElementById("status-dot")!.title = activity;
}

// ── Conversation operations ───────────────────────────────────────────────────

async function loadConversations(): Promise<void> {
  conversations = await queryAllConversationsDB(_adapter);
}

async function saveConversation(conv: Conversation): Promise<void> {
  const updated = await saveConversationDoc(_adapter, conv, currentUser!.username);
  const idx = conversations.findIndex((c) => c.id === conv.id);
  if (idx >= 0) conversations[idx] = updated; else conversations.unshift(updated);
}

async function createConversation(): Promise<Conversation> {
  const id = `conv-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const conv: Conversation = { id, title: "New Conversation", messages: [], created_at: now, updated_at: now };
  await saveConversation(conv);
  return conv;
}

async function deleteConversation(id: string): Promise<void> {
  await deleteConversationDoc(_adapter, id, currentUser!.username);
  conversations = conversations.filter((c) => c.id !== id);
}

function selectConversation(id: string): void {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  selectedConvId = id;
  pendingAttachments = [];
  document.getElementById("chat-empty")!.hidden = true;
  document.getElementById("chat-content")!.hidden = false;
  mobileOpenChat();
  (document.getElementById("conv-title") as HTMLInputElement).value = conv.title;
  chatMessagesEl.conversation = conv;
  pendingAttachmentsEl.attachments = [];
  convListEl.selectedId = selectedConvId;
  (document.getElementById("chat-input") as HTMLTextAreaElement).focus();
}

async function sendMessage(): Promise<void> {
  if (!selectedConvId) return;
  const input = document.getElementById("chat-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  input.value = "";
  input.style.height = "auto";

  const conv = conversations.find((c) => c.id === selectedConvId)!;
  const now = new Date().toISOString();
  const attachments = pendingAttachments.splice(0);
  pendingAttachmentsEl.attachments = [];

  const userMsg = { role: "user" as const, content: text, timestamp: now };
  if (attachments.length) (userMsg as typeof userMsg & { attachments: ChatAttachment[] }).attachments = attachments;
  conv.messages.push(userMsg);
  chatMessagesEl.conversation = conv;

  let replyContent: string;
  try {
    const history = conv.messages.filter((m) => m.role === "user" || m.role === "assistant");
    replyContent = await getAIReplyShared(history, currentUser, authSession, (digest: string) => _adapter.getBlobData(digest));
  } catch (err) {
    replyContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  conv.messages.push({ role: "assistant", content: replyContent, timestamp: new Date().toISOString() });
  chatMessagesEl.conversation = conv;

  if (conv.messages.filter((m) => m.role === "user").length === 1) {
    const titleSource = text || (attachments[0]?.name ?? "Attachment");
    conv.title = titleSource.slice(0, 48) + (titleSource.length > 48 ? "…" : "");
    (document.getElementById("conv-title") as HTMLInputElement).value = conv.title;
  }

  await saveConversation(conv);
  convListEl.conversations = conversations;
}

function wireConvTitleEdit(): void {
  document.getElementById("conv-title")!.addEventListener("change", async () => {
    if (!selectedConvId) return;
    const conv = conversations.find((c) => c.id === selectedConvId);
    if (!conv) return;
    conv.title = (document.getElementById("conv-title") as HTMLInputElement).value;
    await saveConversation(conv);
    convListEl.conversations = conversations;
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────

function showPanel(name: "notes" | "chat" | "profile"): void {
  document.getElementById("panel-notes")!.hidden = name !== "notes";
  document.getElementById("panel-chat")!.hidden = name !== "chat";
  document.getElementById("panel-profile")!.hidden = name !== "profile";
  document.getElementById("nav-notes")!.classList.toggle("active", name === "notes");
  document.getElementById("nav-chat")!.classList.toggle("active", name === "chat");
  document.getElementById("nav-profile")!.classList.toggle("active", name === "profile");
  document.querySelector<HTMLElement>("main.editor")!.hidden = name === "chat";
  document.getElementById("chat-view")!.hidden = name !== "chat";
  document.querySelector<HTMLElement>("main.editor")!.classList.remove("mobile-open");
  document.getElementById("chat-view")!.classList.remove("mobile-open");
}

function mobileOpenEditor(): void {
  document.querySelector<HTMLElement>("main.editor")!.classList.add("mobile-open");
}

function mobileOpenChat(): void {
  document.getElementById("chat-view")!.classList.add("mobile-open");
}

// ── Profile panel ─────────────────────────────────────────────────────────────

function updateProfilePanel(): void {
  if (!currentUser) return;

  const initials = currentUser.username.slice(0, 2).toUpperCase() || "?";
  document.getElementById("profile-avatar")!.textContent = initials;
  document.getElementById("profile-username")!.textContent = currentUser.username;

  const badge = document.getElementById("profile-enc-badge")!;
  badge.className = "profile-enc-badge";
  if (currentUser.encryption_mode === "enterprise") {
    badge.classList.add("enc-enterprise");
    badge.textContent = "Enterprise";
  } else if (currentUser.encryption_mode === "app-level") {
    badge.classList.add("enc-app-level");
    badge.textContent = "App-level";
  } else {
    badge.textContent = "No encryption";
  }

  (document.getElementById("openai-base-url-input") as HTMLInputElement).value =
    currentUser.openai_base_url ?? "";
  (document.getElementById("openai-api-key-input") as HTMLInputElement).value =
    currentUser.openai_api_key ?? "";

  serverListEl.update(
    savedServers,
    serverUrl,
    document.getElementById("saved-servers-datalist") as HTMLDataListElement
  );

  (document.getElementById("sync-continuous") as HTMLInputElement).checked =
    !!syncConfig.continuous_sync;
}

// ── Server management ─────────────────────────────────────────────────────────

async function connectToServer(url: string): Promise<void> {
  if (!authSession) return;
  try {
    const cfg = await fetchSyncConfigFromServer(url, authSession.token);
    serverUrl = url;
    authSession = { ...authSession, server_url: url };
    syncConfig = {
      url: resolveSyncUrl(cfg.sync_url, url),
      collection: "_default.notes",
      direction: cfg.sync_direction,
    };
    await persistSyncConfigDB(_adapter, syncConfig);
    serverListEl.update(savedServers, serverUrl, document.getElementById("saved-servers-datalist") as HTMLDataListElement);
  } catch (err) {
    console.error("Connect to server failed:", err);
  }
}

async function addServer(url: string): Promise<void> {
  if (!url || savedServers.some((s) => s.url === url)) return;
  savedServers = [...savedServers, { url }];
  await persistSavedServersDB(_adapter, savedServers);
  serverListEl.update(savedServers, serverUrl, document.getElementById("saved-servers-datalist") as HTMLDataListElement);
}

async function removeServer(index: number): Promise<void> {
  const removed = savedServers[index];
  savedServers = savedServers.filter((_, i) => i !== index);
  await persistSavedServersDB(_adapter, savedServers);
  if (removed.url === serverUrl) serverUrl = "";
  serverListEl.update(savedServers, serverUrl, document.getElementById("saved-servers-datalist") as HTMLDataListElement);
}

// ── Login screen ──────────────────────────────────────────────────────────────

function showLoginScreen(switchToSignIn = true): void {
  document.getElementById("screen-login")!.hidden = false;
  if (switchToSignIn) switchLoginTab("signin");
}

function hideLoginScreen(): void {
  document.getElementById("screen-login")!.hidden = true;
}

function switchLoginTab(tab: "signin" | "create"): void {
  document.getElementById("tab-signin")!.classList.toggle("active", tab === "signin");
  document.getElementById("tab-create")!.classList.toggle("active", tab === "create");
  document.getElementById("form-signin")!.hidden = tab !== "signin";
  document.getElementById("form-create")!.hidden = tab !== "create";
  (document.getElementById("signin-error") as HTMLElement).hidden = true;
  (document.getElementById("create-error") as HTMLElement).hidden = true;
}

function showLoginError(form: "signin" | "create", msg: string): void {
  const el = document.getElementById(`${form}-error`)!;
  el.textContent = msg;
  el.hidden = false;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function buildAuthSession(
  result: { token: string; sync_config: SyncConfigFromServer },
  url: string,
  username: string,
  password: string
): AuthSession {
  return {
    token: result.token,
    server_url: url,
    username,
    ...(_hooks.includePasswordInSession ? { password } : {}),
    gateway_session_id: result.sync_config.gateway_session_id,
    gateway_cookie_name: result.sync_config.gateway_cookie_name,
  };
}

// ── Auth handlers ─────────────────────────────────────────────────────────────

async function handleLogin(
  username: string,
  password: string,
  serverInput: string
): Promise<void> {
  let profile = await loadUserProfileDB(_adapter);

  if ((!profile || profile.username !== username) && serverInput) {
    const result = await serverLogin(serverInput, username, password);
    authSession = buildAuthSession(result, serverInput, username, password);
    serverUrl = serverInput;
    if (result.sync_config.sync_url) {
      syncConfig = {
        url: resolveSyncUrl(result.sync_config.sync_url, serverInput),
        collection: "_default.notes",
        direction: result.sync_config.sync_direction,
      };
    }
    if (!savedServers.some((s) => s.url === serverInput)) {
      savedServers = [...savedServers, { url: serverInput }];
    }
    profile = { username, encryption_mode: "none" };
    await saveUserProfileDB(_adapter, profile);
  }

  if (!profile) throw new Error("No account found. Please create one first, or provide a server URL to log in from an existing account.");
  if (profile.username !== username) throw new Error("Username not found.");

  const sharedSyncConfig = await loadSyncConfigDB(_adapter);
  const sharedServers = await loadSavedServersDB(_adapter);

  if (serverInput && !authSession) {
    const result = await serverLogin(serverInput, username, password);
    authSession = buildAuthSession(result, serverInput, username, password);
    serverUrl = serverInput;
    syncConfig = {
      url: resolveSyncUrl(result.sync_config.sync_url, serverInput),
      collection: "_default.notes",
      direction: result.sync_config.sync_direction,
    };
    if (!savedServers.some((s) => s.url === serverInput)) {
      savedServers = [...savedServers, { url: serverInput }];
    }
  }

  await _adapter.closeDatabase();
  const encPassword = _hooks.getDbEncPassword(profile, password);
  await _adapter.openDatabase(dbDir, userDbName(username), encPassword, ["notes", "conversations"]);
  if (profile.encryption_mode !== "none") encryptionPassword = password;

  const userSyncConfig = await loadSyncConfigDB(_adapter);
  const userServers = await loadSavedServersDB(_adapter);
  if (!serverInput) {
    syncConfig = userSyncConfig.url ? userSyncConfig : sharedSyncConfig;
    savedServers = userServers.length ? userServers : sharedServers;

    const autoServer = savedServers[0]?.url;
    if (autoServer) {
      try {
        const result = await serverLogin(autoServer, username, password);
        authSession = buildAuthSession(result, autoServer, username, password);
        serverUrl = autoServer;
        if (result.sync_config.sync_url) {
          syncConfig = {
            url: resolveSyncUrl(result.sync_config.sync_url, autoServer),
            collection: "_default.notes",
            direction: result.sync_config.sync_direction,
          };
        }
      } catch (err) {
        console.warn("[auto-login] failed (non-fatal):", err);
      }
    }
  }
  await persistSyncConfigDB(_adapter, syncConfig);
  await persistSavedServersDB(_adapter, savedServers);

  currentUser = profile;
  hideLoginScreen();
  await continueInit();
}

async function handleCreateAccount(
  username: string,
  password: string,
  encModeRaw: string,
  serverInput: string
): Promise<void> {
  if (serverInput) {
    await serverRegister(serverInput, {
      username,
      password,
      sync_url: "",
      sync_collection: "notes",
      sync_direction: "both",
    });
    try {
      const result = await serverLogin(serverInput, username, password);
      authSession = buildAuthSession(result, serverInput, username, password);
      if (result.sync_config.sync_url) {
        syncConfig = {
          url: resolveSyncUrl(result.sync_config.sync_url, serverInput),
          collection: "_default.notes",
          direction: result.sync_config.sync_direction,
        };
      }
    } catch (err) {
      console.warn("[create-account] login after register failed:", err);
    }
    serverUrl = serverInput;
    if (!savedServers.some((s) => s.url === serverInput)) {
      savedServers = [...savedServers, { url: serverInput }];
    }
  }

  const encMode = _hooks.normalizeEncMode(encModeRaw);
  const profile: UserProfile = {
    username,
    encryption_mode: encMode,
    ...(encMode !== "none" ? { crypto_salt: generateSalt() } : {}),
  };
  await saveUserProfileDB(_adapter, profile);

  await _adapter.closeDatabase();
  const encPassword = _hooks.getDbEncPassword(profile, password);
  await _adapter.openDatabase(dbDir, userDbName(username), encPassword, ["notes", "conversations"]);
  if (encMode !== "none") encryptionPassword = password;

  await persistSavedServersDB(_adapter, savedServers);
  await persistSyncConfigDB(_adapter, syncConfig);

  currentUser = profile;
  hideLoginScreen();
  await continueInit();
}

async function handleLogout(): Promise<void> {
  if (isDirty && selectedId) {
    const note = notes.find((n) => n.id === selectedId);
    if (note) {
      note.title = (document.getElementById("note-title") as HTMLInputElement).value;
      await saveNote(note);
    }
  }

  try { await _adapter.stopReplication(); } catch { /* ignore */ }

  if (unlistenCollection) { unlistenCollection(); unlistenCollection = null; }
  if (unlistenReplication) { unlistenReplication(); unlistenReplication = null; }

  await _adapter.closeDatabase();

  currentUser = null;
  authSession = null;
  encryptionPassword = null;
  serverUrl = "";
  notes = [];
  selectedId = null;
  isDirty = false;
  searchQuery = "";

  document.getElementById("editor-empty")!.hidden = false;
  document.getElementById("editor-content")!.hidden = true;
  (document.getElementById("note-search") as HTMLInputElement).value = "";
  noteListEl.notes = [];
  noteListEl.selectedId = null;
  setStatus("Idle");

  await _adapter.openDatabase(dbDir, "notes", undefined, ["notes", "conversations"]);
  savedServers = await loadSavedServersDB(_adapter);
  serverListEl.update(savedServers, serverUrl, document.getElementById("saved-servers-datalist") as HTMLDataListElement);

  unlistenReplication = await _adapter.onReplicationStatus((activity: string) => {
    setStatus(activity);
  });

  showLoginScreen(true);
}

// ── continueInit ──────────────────────────────────────────────────────────────

async function continueInit(): Promise<void> {
  initEditor();
  notes = [];
  selectedId = null;
  isDirty = false;
  searchQuery = "";
  document.getElementById("editor-empty")!.hidden = false;
  document.getElementById("editor-content")!.hidden = true;
  (document.getElementById("note-search") as HTMLInputElement).value = "";

  savedServers = await loadSavedServersDB(_adapter);
  notes = await loadAllNotesDB(_adapter, currentUser, encryptionPassword);
  console.log(`[continueInit] Loaded ${notes.length} notes`);
  await migrateOwnerFieldDB(_adapter, currentUser!.username);
  syncConfig = await loadSyncConfigDB(_adapter);

  updateProfilePanel();

  if (unlistenCollection) unlistenCollection();
  if (unlistenReplication) unlistenReplication();

  unlistenCollection = await _adapter.onCollectionChanged(async () => {
    if (searchQuery) {
      await searchNotes(searchQuery);
    } else {
      notes = await loadAllNotesDB(_adapter, currentUser, encryptionPassword);
      noteListEl.notes = notes;
    }
  });

  unlistenReplication = await _adapter.onReplicationStatus((activity: string, error?: string) => {
    setStatus(activity);
    if (error) showError("Replication error: " + error);
    // Reload notes when a sync batch completes (Idle = continuous caught up, Stopped = one-shot done)
    if (activity === "Idle" || activity === "Stopped") {
      loadAllNotesDB(_adapter, currentUser, encryptionPassword)
        .then((loaded) => { notes = loaded; noteListEl.notes = notes; })
        .catch(console.error);
    }
  });

  noteListEl.notes = notes;
  noteListEl.selectedId = null;
  showPanel("notes");

  if (syncConfig.continuous_sync && syncConfig.url) {
    setStatus("Connecting");
    const auth = _hooks.getSyncAuth();
    const fe = _hooks.getSyncFieldEncryption();
    _adapter.startReplication(syncConfig.url, syncConfig.collection, syncConfig.direction, auth, fe)
      .catch((e: unknown) => { setStatus("Stopped"); console.warn("auto-start replication:", e); });
  }
}

// ── Wire login form ───────────────────────────────────────────────────────────

function wireLoginForm(): void {
  document.getElementById("tab-signin")!.addEventListener("click", () =>
    switchLoginTab("signin")
  );
  document.getElementById("tab-create")!.addEventListener("click", () =>
    switchLoginTab("create")
  );

  document.getElementById("form-signin")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = (document.getElementById("signin-username") as HTMLInputElement).value.trim();
    const password = (document.getElementById("signin-password") as HTMLInputElement).value;
    const serverInput = (document.getElementById("signin-server") as HTMLInputElement).value.trim();
    try {
      await handleLogin(username, password, serverInput);
    } catch (err) {
      showLoginError("signin", err instanceof Error ? err.message : String(err));
    }
  });

  document.getElementById("form-create")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = (document.getElementById("create-username") as HTMLInputElement).value.trim();
    const password = (document.getElementById("create-password") as HTMLInputElement).value;
    const encMode = (document.getElementById("create-enc-mode") as HTMLSelectElement).value;
    const serverInput = (document.getElementById("create-server") as HTMLInputElement).value.trim();
    try {
      await handleCreateAccount(username, password, encMode, serverInput);
    } catch (err) {
      showLoginError("create", err instanceof Error ? err.message : String(err));
    }
  });
}

// ── Wire app buttons ──────────────────────────────────────────────────────────

function wireAppButtons(): void {
  // Nav
  document.getElementById("nav-notes")!.addEventListener("click", () => showPanel("notes"));
  document.getElementById("nav-chat")!.addEventListener("click", async () => {
    showPanel("chat");
    await loadConversations();
    convListEl.conversations = conversations;
  });
  document.getElementById("nav-profile")!.addEventListener("click", () => showPanel("profile"));
  document.querySelectorAll<HTMLButtonElement>(".profile-subnav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.dataset.section!;
      document.querySelectorAll<HTMLButtonElement>(".profile-subnav-btn").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
      document.getElementById("profile-section-sync")!.hidden = section !== "sync";
      document.getElementById("profile-section-ai")!.hidden = section !== "ai";
    });
  });
  document.getElementById("btn-logout")!.addEventListener("click", () =>
    handleLogout().catch(console.error)
  );

  // Notes
  document.getElementById("btn-new-note")!.addEventListener("click", () => {
    createNote()
      .then(async (note) => {
        notes.unshift(note);
        noteListEl.notes = notes;
        await selectNote(note.id);
      })
      .catch((e) => showError("Failed to create note: " + String(e)));
  });

  // Chat
  document.getElementById("btn-new-conv")!.addEventListener("click", () => {
    createConversation()
      .then((conv) => {
        convListEl.conversations = conversations;
        selectConversation(conv.id);
      })
      .catch((e) => showError("Failed to create conversation: " + String(e)));
  });

  // Mobile back buttons
  document.getElementById("btn-back-mobile")!.addEventListener("click", () => {
    document.querySelector<HTMLElement>("main.editor")!.classList.remove("mobile-open");
  });
  document.getElementById("btn-back-chat-mobile")!.addEventListener("click", () => {
    document.getElementById("chat-view")!.classList.remove("mobile-open");
  });

  document.getElementById("btn-send")!.addEventListener("click", () => sendMessage().catch(console.error));
  document.getElementById("btn-attach-chat")!.addEventListener("click", () => _hooks.chatAttach().catch(console.error));

  document.getElementById("btn-delete-conv")!.addEventListener("click", async () => {
    if (!selectedConvId) return;
    await deleteConversation(selectedConvId);
    selectedConvId = null;
    convListEl.selectedId = null;
    document.getElementById("chat-empty")!.hidden = false;
    document.getElementById("chat-content")!.hidden = true;
    convListEl.conversations = conversations;
  });

  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage().catch(console.error);
    }
  });
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
  });

  wireConvTitleEdit();

  document.getElementById("note-title")!.addEventListener("input", () => { isDirty = true; });

  document.getElementById("btn-save")!.addEventListener("click", async () => {
    if (!selectedId) return;
    const note = notes.find((n) => n.id === selectedId);
    if (!note) return;
    note.title = (document.getElementById("note-title") as HTMLInputElement).value;
    await saveNote(note);
    isDirty = false;
    noteListEl.notes = notes;
  });

  document.getElementById("btn-delete")!.addEventListener("click", async () => {
    if (!selectedId) return;
    await deleteNote(selectedId);
    selectedId = null;
    document.getElementById("editor-empty")!.hidden = false;
    document.getElementById("editor-content")!.hidden = true;
    noteListEl.notes = notes;
    noteListEl.selectedId = null;
  });

  // Search
  document.getElementById("note-search")!.addEventListener("input", (e) => {
    searchQuery = (e.target as HTMLInputElement).value.trim();
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { searchNotes(searchQuery); }, 300);
  });

  // Profile: AI key
  document.getElementById("btn-toggle-api-key")!.addEventListener("click", () => {
    const input = document.getElementById("openai-api-key-input") as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
  });

  document.getElementById("btn-save-api-key")!.addEventListener("click", async () => {
    if (!currentUser) return;
    const key = (document.getElementById("openai-api-key-input") as HTMLInputElement).value.trim();
    const baseUrl = (document.getElementById("openai-base-url-input") as HTMLInputElement).value.trim();
    currentUser.openai_api_key = key || undefined;
    currentUser.openai_base_url = baseUrl || undefined;
    await saveUserProfileDB(_adapter, currentUser);
    const status = document.getElementById("api-key-status")!;
    status.textContent = "Saved.";
    status.hidden = false;
    setTimeout(() => { status.hidden = true; }, 2500);
  });

  // Profile: server management
  document.getElementById("btn-add-server")!.addEventListener("click", async () => {
    const input = document.getElementById("new-server-url") as HTMLInputElement;
    const url = input.value.trim();
    if (!url) return;
    await addServer(url);
    input.value = "";
  });

  document.getElementById("new-server-url")!.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const input = e.target as HTMLInputElement;
    const url = input.value.trim();
    if (!url) return;
    await addServer(url);
    input.value = "";
  });

  // Sync
  document.getElementById("btn-sync-now")!.addEventListener("click", () => {
    if (!syncConfig.url) {
      showError("Sync URL not configured. Set it in Profile → Sync Server.");
      return;
    }
    setStatus("Connecting");
    const auth = _hooks.getSyncAuth();
    const fieldEncryption = _hooks.getSyncFieldEncryption();
    _adapter.startReplication(syncConfig.url, syncConfig.collection, syncConfig.direction, auth, fieldEncryption)
      .catch((e: unknown) => {
        setStatus("Stopped");
        console.warn("startReplication failed:", e);
      });
  });

  document.getElementById("btn-stop-sync")!.addEventListener("click", async () => {
    await _adapter.stopReplication();
    setStatus("Stopped");
  });

  document.getElementById("sync-continuous")!.addEventListener("change", async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    syncConfig = { ...syncConfig, continuous_sync: checked };
    await persistSyncConfigDB(_adapter, syncConfig);
    if (checked && syncConfig.url) {
      setStatus("Connecting");
      const auth = _hooks.getSyncAuth();
      const fe = _hooks.getSyncFieldEncryption();
      _adapter.startReplication(syncConfig.url, syncConfig.collection, syncConfig.direction, auth, fe)
        .catch((e: unknown) => { setStatus("Stopped"); console.warn("startReplication failed:", e); });
    } else {
      await _adapter.stopReplication();
      setStatus("Stopped");
    }
  });

  // Window close / page unload: flush any unsaved note
  _hooks.onWindowUnload(async () => {
    if (isDirty && selectedId) {
      const note = notes.find((n) => n.id === selectedId);
      if (note) {
        note.title = (document.getElementById("note-title") as HTMLInputElement).value;
        await saveNote(note);
        isDirty = false;
      }
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init(adapter: DatabaseAdapter, hooks: PlatformHooks): Promise<void> {
  _adapter = adapter;
  _hooks = hooks;
  dbDir = await hooks.getDbDir();

  setupComponents();
  wireLoginForm();
  wireAppButtons();

  try {
    await _adapter.openDatabase(dbDir, "notes", undefined, ["notes", "conversations"]);
    unlistenReplication = await _adapter.onReplicationStatus((activity: string) => {
      setStatus(activity);
    });
  } catch (e) {
    showError("openDatabase failed: " + String(e));
    showLoginScreen(true);
    return;
  }

  savedServers = await loadSavedServersDB(_adapter);

  const DEFAULT_SERVER = "http://192.168.1.109:3000";
  if (savedServers.length === 0) {
    savedServers = [{ url: DEFAULT_SERVER }];
    await persistSavedServersDB(_adapter, savedServers);
  }

  const signinServerInput = document.getElementById("signin-server") as HTMLInputElement;
  const createServerInput = document.getElementById("create-server") as HTMLInputElement;
  if (signinServerInput && !signinServerInput.value) signinServerInput.value = DEFAULT_SERVER;
  if (createServerInput && !createServerInput.value) createServerInput.value = DEFAULT_SERVER;

  serverListEl.update(savedServers, serverUrl, document.getElementById("saved-servers-datalist") as HTMLDataListElement);

  const profile = await loadUserProfileDB(_adapter);
  if (!profile) {
    showLoginScreen(false);
    switchLoginTab("create");
    return;
  }

  if (profile.encryption_mode === "app-level") {
    showLoginScreen(true);
    return;
  }

  currentUser = profile;
  await continueInit();
}
