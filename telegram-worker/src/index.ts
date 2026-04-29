import "dotenv/config";
import { mkdir } from "fs/promises";
import { createServer } from "http";
import axios from "axios";
import { SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig, extractActions } from "@cblite-uni-app/worker-core";
import type { BaseWorkerConfig, SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";

interface TelegramUser { username: string; telegram_chat_id: number }
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
    entities?: Array<{ type: string }>;
  };
}

async function processUpdate(
  update: TelegramUpdate,
  users: TelegramUser[],
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === "private";
  const isMention = msg.entities?.some((e) => e.type === "mention") ?? false;
  if (!isPrivate && !isMention) return;

  const user = users.find((u) => u.telegram_chat_id === chatId);
  if (!user) { console.warn(`[telegram] No user mapped for chat ID ${chatId}`); return; }

  const eventId = `telegram::${msg.message_id}::${chatId}`;
  if (await dedup.isProcessed(eventId)) return;

  const actor = msg.from?.username ?? msg.from?.first_name ?? String(msg.from?.id ?? "unknown");
  const event: SourceEvent = {
    id: eventId,
    source: "telegram",
    type: isPrivate ? "dm" : "mention",
    actor,
    title: isPrivate ? `Telegram DM from ${actor}` : `Telegram mention from ${actor}`,
    body: msg.text,
    url: `https://t.me/c/${chatId}/${msg.message_id}`,
    receivedAt: new Date(msg.date * 1000).toISOString(),
    raw: msg as unknown as Record<string, unknown>,
  };

  let drafts;
  try {
    drafts = await extractActions(event, config.llm, config.llmMode);
  } catch (err) {
    console.warn(`[telegram] LLM failed for event ${eventId}:`, err);
    return;
  }

  if (drafts.length > 0) {
    const written = await writer.writeActions(drafts, event, user.username);
    if (written < drafts.length) return;
  }
  await dedup.markProcessed(eventId);
}

async function startLongPolling(
  botToken: string,
  users: TelegramUser[],
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): Promise<void> {
  const base = `https://api.telegram.org/bot${botToken}`;
  let offset = 0;
  console.log("[telegram] Starting long-poll loop…");

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await axios.get<{ result: TelegramUpdate[] }>(`${base}/getUpdates`, {
        params: { offset, timeout: 30, allowed_updates: ["message"] },
        timeout: 35_000,
      });
      for (const update of res.data.result) {
        await processUpdate(update, users, config, writer, dedup);
        offset = update.update_id + 1;
      }
    } catch (err) {
      console.error("[telegram] Long-poll error:", err);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

function startWebhookMode(
  port: number,
  botToken: string,
  webhookUrl: string,
  users: TelegramUser[],
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): void {
  const base = `https://api.telegram.org/bot${botToken}`;
  // Register webhook
  axios.post(`${base}/setWebhook`, { url: `${webhookUrl}/telegram` })
    .then(() => console.log(`[telegram] Webhook registered at ${webhookUrl}/telegram`))
    .catch((err) => console.error("[telegram] Failed to register webhook:", err));

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/telegram") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200).end("OK");
      try {
        const update = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as TelegramUpdate;
        processUpdate(update, users, config, writer, dedup).catch((e) =>
          console.error("[telegram] processUpdate error:", e)
        );
      } catch (e) { console.error("[telegram] JSON parse error:", e); }
    });
  });
  server.listen(port, () => console.log(`[telegram] Webhook server on port ${port}`));
}

async function main(): Promise<void> {
  console.log("[telegram-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw() as TelegramUser[];
  const config = { ...base, pollIntervalSeconds: 0 };
  validateBaseConfig(config, users);

  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");
  for (const u of users)
    if (!u.telegram_chat_id) throw new Error(`User '${u.username}' missing 'telegram_chat_id'`);

  await mkdir(config.stateDbPath, { recursive: true });
  const dedup = new DedupStore(config.stateDbPath, "telegram-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);

  process.on("SIGINT", async () => { await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await dedup.close(); process.exit(0); });

  const webhookUrl = process.env["TELEGRAM_WEBHOOK_URL"];
  if (config.webhookPort && webhookUrl) {
    startWebhookMode(config.webhookPort, botToken, webhookUrl, users, config, writer, dedup);
    console.log(`[telegram-worker] Running in webhook mode. Users: ${users.map((u) => u.username).join(", ")}`);
  } else {
    console.log(`[telegram-worker] Running in long-poll mode. Users: ${users.map((u) => u.username).join(", ")}`);
    await startLongPolling(botToken, users, config, writer, dedup);
  }
}

main().catch((err) => { console.error("[telegram-worker] Fatal:", err); process.exit(1); });
