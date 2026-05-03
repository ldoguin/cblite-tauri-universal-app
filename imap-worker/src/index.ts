import "dotenv/config";
import { mkdir } from "fs/promises";
import {
  Poller, SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig,
} from "@cblite-uni-app/worker-core";
import type { BaseWorkerConfig, SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";
import { ImapConnection, loadImapUserConfig } from "./provider.js";

// ── Mail handler ──────────────────────────────────────────────────────────────
// Called by each ImapConnection when new messages arrive (via IDLE or poll).
// Runs dedup → LLM → SG write for each message, same retry semantics as other workers.

async function handleNewMail(
  events: SourceEvent[],
  user: UserConfig,
  poller: Poller,
  dedup: DedupStore
): Promise<void> {
  for (const event of events) {
    if (await dedup.isProcessed(event.id)) {
      console.log(`[imap] Already processed ${event.id} — skipping`);
      continue;
    }
    console.log(`[imap] Processing '${event.title}' for '${user.username}'`);
    await poller.processEvent(event, user).catch((err) =>
      console.warn(`[imap] processEvent failed for ${event.id}:`, err)
    );
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[imap-worker] Starting…");

  const base = loadBaseConfig();
  const users = loadUsersRaw();
  const pollIntervalSeconds = parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "60", 10);
  const config: BaseWorkerConfig = { ...base, pollIntervalSeconds };
  validateBaseConfig(config, users);

  await mkdir(config.stateDbPath, { recursive: true });
  const dedup = new DedupStore(config.stateDbPath, "imap-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users, { listEvents: async () => [] }, writer, dedup);
  await poller.start();

  const connections: ImapConnection[] = [];

  for (const user of users) {
    const imapConfig = loadImapUserConfig(user.username);
    if (!imapConfig) {
      console.warn(
        `[imap-worker] Missing IMAP_HOST_/IMAP_USER_/IMAP_PASS_ for '${user.username}' — skipping`
      );
      continue;
    }

    const conn = new ImapConnection(
      user.username,
      imapConfig,
      (events, _username) => handleNewMail(events, user, poller, dedup),
      pollIntervalSeconds * 1000
    );
    connections.push(conn);
    conn.start().catch((err) =>
      console.error(`[imap-worker] Fatal error for '${user.username}':`, err)
    );
  }

  if (connections.length === 0) {
    throw new Error("[imap-worker] No users with valid IMAP credentials. Check your .env file.");
  }

  const shutdown = async (sig: string) => {
    console.log(`[imap-worker] ${sig} — shutting down…`);
    await Promise.allSettled(connections.map((c) => c.stop()));
    await poller.stop();
    await dedup.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(
    `[imap-worker] Running. Users: ${users.map((u) => u.username).join(", ")} | ` +
    `Poll fallback: ${pollIntervalSeconds}s`
  );

  // Keep process alive — IMAP connections drive the event loop via IDLE/timers
  await new Promise<never>(() => { /* intentionally never resolves */ });
}

main().catch((err) => { console.error("[imap-worker] Fatal:", err); process.exit(1); });
