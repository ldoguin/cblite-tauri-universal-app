import "dotenv/config";
import { mkdir } from "fs/promises";
import {
  SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig, extractActions,
} from "@cblite-uni-app/worker-core";
import type { BaseWorkerConfig, SourceEvent } from "@cblite-uni-app/worker-core";
import { ImapConnection, loadImapUserConfig } from "./provider.js";

// ── Mail handler ──────────────────────────────────────────────────────────────
// Called by each ImapConnection when new messages arrive (via IDLE or poll).
// Runs dedup → LLM → SG write for each message, same retry semantics as other workers.

async function handleNewMail(
  events: SourceEvent[],
  username: string,
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): Promise<void> {
  for (const event of events) {
    if (await dedup.isProcessed(event.id)) {
      console.log(`[imap] Already processed ${event.id} — skipping`);
      continue;
    }

    let drafts;
    try {
      drafts = await extractActions(event, config.llm, config.llmMode);
    } catch (err) {
      console.warn(`[imap] LLM failed for ${event.id} — will not mark processed:`, err);
      // Don't mark processed — IMAP message is already marked \Seen on the server,
      // so we won't re-fetch it. Log for manual review.
      continue;
    }

    console.log(`[imap] '${event.title}' → ${drafts.length} action(s) for '${username}'`);

    if (drafts.length > 0) {
      let written: number;
      try {
        written = await writer.writeActions(drafts, event, username);
      } catch (err) {
        console.error(`[imap] SG write failed for ${event.id}:`, err);
        continue; // don't mark processed
      }
      if (written < drafts.length) {
        console.warn(`[imap] Partial write (${written}/${drafts.length}) for ${event.id}`);
        continue;
      }
    }

    await dedup.markProcessed(event.id);
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
      (events, username) => handleNewMail(events, username, config, writer, dedup),
      pollIntervalSeconds * 1000
    );
    connections.push(conn);
    // Start each connection independently — failures in one don't affect others
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
