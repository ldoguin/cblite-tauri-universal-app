// IMAP provider using imapflow for connection management and IDLE support.
// Each user gets their own persistent IMAP connection. When the server supports
// IDLE (RFC 2177), the connection parks in IDLE and wakes on new mail — no
// polling needed. Servers that don't support IDLE fall back to periodic SEARCH.

import { ImapFlow, type ImapFlowOptions, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";

// ── Per-user IMAP config ──────────────────────────────────────────────────────

export interface ImapUserConfig {
  host: string;
  port: number;
  user: string;       // IMAP login (usually the email address)
  pass: string;
  tls: boolean;       // true = implicit TLS (port 993); false = STARTTLS (port 143)
  mailbox: string;    // e.g. "INBOX"
}

// ── Callback type ─────────────────────────────────────────────────────────────

export type NewMailCallback = (events: SourceEvent[], username: string) => Promise<void>;

// ── IMAP connection wrapper ───────────────────────────────────────────────────

export class ImapConnection {
  private client: ImapFlow;
  private username: string;
  private imapConfig: ImapUserConfig;
  private onNewMail: NewMailCallback;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private idleAbort: (() => void) | null = null;
  private running = false;

  constructor(
    username: string,
    imapConfig: ImapUserConfig,
    onNewMail: NewMailCallback,
    pollIntervalMs: number
  ) {
    this.username = username;
    this.imapConfig = imapConfig;
    this.onNewMail = onNewMail;
    this.pollIntervalMs = pollIntervalMs;

    const opts: ImapFlowOptions = {
      host: imapConfig.host,
      port: imapConfig.port,
      secure: imapConfig.tls,
      auth: { user: imapConfig.user, pass: imapConfig.pass },
      logger: false, // suppress imapflow's built-in logging
    };
    this.client = new ImapFlow(opts);
  }

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.idleAbort?.();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try { await this.client.logout(); } catch { /* ignore */ }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    try {
      await this.client.connect();
      console.log(`[imap] Connected for '${this.username}' (${this.imapConfig.host})`);
      await this.client.mailboxOpen(this.imapConfig.mailbox);

      // Do an initial fetch of unseen messages
      await this.fetchUnseen();

      if (this.client.serverInfo?.capabilities?.has("IDLE")) {
        this.runIdleLoop();
      } else {
        console.log(`[imap] Server for '${this.username}' does not support IDLE — using poll`);
        this.pollTimer = setInterval(() => {
          this.fetchUnseen().catch((err) =>
            console.error(`[imap] Poll error for '${this.username}':`, err)
          );
        }, this.pollIntervalMs);
      }
    } catch (err) {
      console.error(`[imap] Connection failed for '${this.username}':`, err);
      if (this.running) {
        const delay = 30_000;
        console.log(`[imap] Retrying '${this.username}' in ${delay / 1000}s…`);
        await sleep(delay);
        // Recreate client on reconnect (imapflow connections are not reusable)
        this.client = new ImapFlow({
          host: this.imapConfig.host,
          port: this.imapConfig.port,
          secure: this.imapConfig.tls,
          auth: { user: this.imapConfig.user, pass: this.imapConfig.pass },
          logger: false,
        });
        await this.connect();
      }
    }
  }

  private runIdleLoop(): void {
    // IDLE loop: wait for server notification, fetch new mail, repeat.
    const loop = async () => {
      while (this.running) {
        try {
          await new Promise<void>((resolve, reject) => {
            this.idleAbort = resolve;
            this.client.idle().then(resolve).catch(reject);
          });
          this.idleAbort = null;
          if (!this.running) break;
          await this.fetchUnseen();
        } catch (err) {
          console.error(`[imap] IDLE error for '${this.username}':`, err);
          if (this.running) {
            await sleep(5_000);
            // Reconnect
            try {
              await this.client.mailboxOpen(this.imapConfig.mailbox);
            } catch {
              // Full reconnect
              await this.connect();
              return;
            }
          }
        }
      }
    };
    loop().catch((err) => console.error(`[imap] IDLE loop crashed for '${this.username}':`, err));
  }

  private async fetchUnseen(): Promise<void> {
    const messages: SourceEvent[] = [];

    // Search for UNSEEN messages
    const uids = await this.client.search({ seen: false });
    if (uids.length === 0) return;

    console.log(`[imap] ${uids.length} unseen message(s) for '${this.username}'`);

    for await (const msg of this.client.fetch(uids, {
      uid: true,
      envelope: true,
      bodyStructure: true,
      source: true,
    }) as AsyncIterable<FetchMessageObject>) {
      try {
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.text ?? "";
        const to = parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((a) => a.text).join(", ") : parsed.to.text) : "";
        const subject = parsed.subject ?? "(no subject)";
        const body = parsed.text ?? stripHtml(parsed.html ?? "");
        const receivedAt = (parsed.date ?? new Date()).toISOString();
        const messageId = parsed.messageId ?? `imap::${this.username}::${msg.uid}`;

        messages.push({
          id: `imap::${messageId}`,
          source: "imap",
          type: "email",
          actor: from,
          title: subject,
          body: body.trim().slice(0, 4000),
          url: "",
          receivedAt,
          raw: {
            message_id: messageId,
            uid: msg.uid,
            from,
            to,
            subject,
            received_at: receivedAt,
            host: this.imapConfig.host,
            mailbox: this.imapConfig.mailbox,
          },
        });

        // Mark as seen so we don't reprocess on next IDLE wake
        await this.client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"]);
      } catch (err) {
        console.warn(`[imap] Failed to parse message uid=${msg.uid} for '${this.username}':`, err);
      }
    }

    if (messages.length > 0) {
      await this.onNewMail(messages, this.username);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Config loader ─────────────────────────────────────────────────────────────

export function loadImapUserConfig(username: string): ImapUserConfig | null {
  const key = username.toUpperCase();
  const host = process.env[`IMAP_HOST_${key}`];
  const user = process.env[`IMAP_USER_${key}`];
  const pass = process.env[`IMAP_PASS_${key}`];
  if (!host || !user || !pass) return null;

  return {
    host,
    port: parseInt(process.env[`IMAP_PORT_${key}`] ?? "993", 10),
    user,
    pass,
    tls: (process.env[`IMAP_TLS_${key}`] ?? "true") !== "false",
    mailbox: process.env[`IMAP_MAILBOX_${key}`] ?? "INBOX",
  };
}
