import "dotenv/config";
import { mkdir } from "fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import {
  Poller, SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig,
} from "@cblite-uni-app/worker-core";
import type { SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";

interface WAUser extends UserConfig { whatsapp_phone: string }

function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function handleWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  appSecret: string,
  verifyToken: string,
  users: WAUser[],
  poller: Poller,
  dedup: DedupStore
): Promise<void> {
  // GET: Meta verification handshake
  if (req.method === "GET" && req.url?.startsWith("/webhook")) {
    const url = new URL(req.url, "http://localhost");
    if (
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === verifyToken
    ) {
      res.writeHead(200).end(url.searchParams.get("hub.challenge") ?? "");
    } else {
      res.writeHead(403).end("Forbidden");
    }
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/webhook")) { res.writeHead(404).end(); return; }

  const body = await readBody(req);

  // Verify HMAC-SHA256 signature
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  if (sig) {
    const expected = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
    try {
      if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        res.writeHead(401).end("Invalid signature"); return;
      }
    } catch { res.writeHead(401).end("Invalid signature"); return; }
  }

  res.writeHead(200).end("OK");

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body) as Record<string, unknown>; } catch { return; }

  // Navigate Meta webhook structure: entry[].changes[].value.messages[]
  const entries = (payload["entry"] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const entry of entries) {
    const changes = (entry["changes"] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const change of changes) {
      const value = change["value"] as Record<string, unknown> | undefined;
      const messages = (value?.["messages"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const msg of messages) {
        await processMessage(msg, users, poller, dedup);
      }
    }
  }
}

async function processMessage(
  msg: Record<string, unknown>,
  users: WAUser[],
  poller: Poller,
  dedup: DedupStore
): Promise<void> {
  const msgId = msg["id"] as string | undefined;
  if (!msgId) return;

  const fromPhone = normalisePhone((msg["from"] as string | undefined) ?? "");
  const user = users.find((u) => normalisePhone(u.whatsapp_phone) === fromPhone);
  if (!user) { console.warn(`[whatsapp] No user mapped for phone ${fromPhone}`); return; }

  const eventId = `whatsapp::${msgId}`;
  if (await dedup.isProcessed(eventId)) return;

  const textBody = (msg["text"] as Record<string, string> | undefined)?.["body"] ?? "";
  const timestamp = parseInt((msg["timestamp"] as string | undefined) ?? "0", 10);

  const event: SourceEvent = {
    id: eventId,
    source: "whatsapp",
    type: "dm",
    actor: fromPhone,
    title: `WhatsApp message from +${fromPhone}`,
    body: textBody,
    url: "",
    receivedAt: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    raw: msg,
  };

  await poller.processEvent(event, user).catch((err) =>
    console.warn(`[whatsapp] processEvent failed for ${eventId}:`, err)
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  console.log("[whatsapp-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw() as WAUser[];
  const config = { ...base, pollIntervalSeconds: 0 };
  validateBaseConfig(config, users);

  const accessToken = process.env["WHATSAPP_ACCESS_TOKEN"]; if (!accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN required");
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"]; if (!phoneNumberId) throw new Error("WHATSAPP_PHONE_NUMBER_ID required");
  const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"]; if (!verifyToken) throw new Error("WHATSAPP_VERIFY_TOKEN required");
  const appSecret = process.env["WHATSAPP_APP_SECRET"]; if (!appSecret) throw new Error("WHATSAPP_APP_SECRET required");
  if (!config.webhookPort) throw new Error("WEBHOOK_PORT required for whatsapp-worker");

  for (const u of users)
    if (!u.whatsapp_phone) throw new Error(`User '${u.username}' missing 'whatsapp_phone'`);

  await mkdir(config.stateDbPath, { recursive: true });
  const dedup = new DedupStore(config.stateDbPath, "whatsapp-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users, { listEvents: async () => [] }, writer, dedup);
  await poller.start();

  const server = createServer((req, res) => {
    handleWebhook(req, res, appSecret, verifyToken, users, poller, dedup)
      .catch((err) => { console.error("[whatsapp] Error:", err); res.writeHead(500).end(); });
  });
  server.listen(config.webhookPort, () =>
    console.log(`[whatsapp-worker] Listening on port ${config.webhookPort}`)
  );

  process.on("SIGINT", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  console.log(`[whatsapp-worker] Running. Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[whatsapp-worker] Fatal:", err); process.exit(1); });
