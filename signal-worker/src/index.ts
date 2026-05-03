import "dotenv/config";
import { mkdir } from "fs/promises";
import { createConnection, type Socket } from "net";
import {
  Poller, SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig,
} from "@cblite-uni-app/worker-core";
import type { SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";

interface SignalUser extends UserConfig { signal_number: string }

// ── signal-cli JSON-RPC client ────────────────────────────────────────────────

class SignalCliClient {
  private socket: Socket;
  private buffer = "";
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private nextId = 1;
  private messageHandler: ((msg: SignalMessage) => void) | null = null;

  constructor(socketPath: string) {
    this.socket = createConnection(socketPath);
    this.socket.setEncoding("utf-8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (err) => console.error("[signal-cli] Socket error:", err));
  }

  onMessage(handler: (msg: SignalMessage) => void): void {
    this.messageHandler = handler;
  }

  async subscribe(account: string): Promise<void> {
    await this.call("subscribeReceive", { account });
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.socket.write(req);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if ("id" in msg) {
          // Response to a call
          const pending = this.pendingRequests.get(msg["id"] as number);
          if (pending) {
            this.pendingRequests.delete(msg["id"] as number);
            if ("error" in msg) pending.reject(msg["error"]);
            else pending.resolve(msg["result"]);
          }
        } else if (msg["method"] === "receive") {
          // Incoming message notification
          const envelope = (msg["params"] as Record<string, unknown>)?.["envelope"] as SignalEnvelope | undefined;
          if (envelope) this.messageHandler?.(envelope);
        }
      } catch (e) {
        console.warn("[signal-cli] Failed to parse line:", line.slice(0, 100), e);
      }
    }
  }
}

interface SignalEnvelope {
  source: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: { message?: string; groupInfo?: { groupId: string } };
}

type SignalMessage = SignalEnvelope;

// ── Message processor ─────────────────────────────────────────────────────────

function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function processEnvelope(
  envelope: SignalEnvelope,
  users: SignalUser[],
  poller: Poller,
  dedup: DedupStore
): Promise<void> {
  const text = envelope.dataMessage?.message;
  if (!text) return; // ignore receipts, typing indicators, etc.

  const fromPhone = normalisePhone(envelope.sourceNumber ?? envelope.source ?? "");
  const user = users.find((u) => normalisePhone(u.signal_number) === fromPhone);
  if (!user) { console.warn(`[signal] No user mapped for number +${fromPhone}`); return; }

  const isGroup = !!envelope.dataMessage?.groupInfo;
  const eventId = `signal::${envelope.source}::${envelope.timestamp}`;
  if (await dedup.isProcessed(eventId)) return;

  const actor = envelope.sourceName ?? `+${fromPhone}`;
  const event: SourceEvent = {
    id: eventId,
    source: "signal",
    type: isGroup ? "group_message" : "dm",
    actor,
    title: isGroup ? `Signal group message from ${actor}` : `Signal DM from ${actor}`,
    body: text,
    url: "",
    receivedAt: new Date(envelope.timestamp).toISOString(),
    raw: envelope as unknown as Record<string, unknown>,
  };

  await poller.processEvent(event, user).catch((err) =>
    console.warn(`[signal] processEvent failed for ${eventId}:`, err)
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[signal-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw() as SignalUser[];
  const config = { ...base, pollIntervalSeconds: 0 };
  validateBaseConfig(config, users);

  const socketPath = process.env["SIGNAL_CLI_SOCKET"] ?? "/var/run/signal-cli/socket";
  const account = process.env["SIGNAL_ACCOUNT"];
  if (!account) throw new Error("SIGNAL_ACCOUNT is required");
  for (const u of users)
    if (!u.signal_number) throw new Error(`User '${u.username}' missing 'signal_number'`);

  await mkdir(config.stateDbPath, { recursive: true });
  const dedup = new DedupStore(config.stateDbPath, "signal-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users, { listEvents: async () => [] }, writer, dedup);
  await poller.start();

  const client = new SignalCliClient(socketPath);

  client.onMessage((envelope) => {
    processEnvelope(envelope, users, poller, dedup).catch((err) =>
      console.error("[signal] processEnvelope error:", err)
    );
  });

  await client.subscribe(account);
  console.log(`[signal-worker] Subscribed to ${account}. Users: ${users.map((u) => u.username).join(", ")}`);

  process.on("SIGINT", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await poller.stop(); await dedup.close(); process.exit(0); });

  // Keep process alive — the socket event loop drives everything
  await new Promise<never>(() => { /* intentionally never resolves */ });
}

main().catch((err) => { console.error("[signal-worker] Fatal:", err); process.exit(1); });
