import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { WebClient } from "@slack/web-api";
import type { DedupStore, Poller, SgWriter, SourceEvent, UserConfig, BaseWorkerConfig } from "@cblite-uni-app/worker-core";
import { extractActions } from "@cblite-uni-app/worker-core";

interface SlackUser { username: string; slack_user_id: string }

export function startSlackWebhookServer(
  port: number,
  botToken: string,
  signingSecret: string,
  users: SlackUser[],
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): void {
  const slack = new WebClient(botToken);
  // Build reverse map: slack_user_id → UserConfig
  const userMap = new Map<string, UserConfig>(
    users.map((u) => [u.slack_user_id, u as unknown as UserConfig])
  );

  const server = createServer((req, res) => {
    handle(req, res, signingSecret, slack, userMap, config, writer, dedup).catch((err) => {
      console.error("[slack-webhook] Error:", err);
      res.writeHead(500).end();
    });
  });
  server.listen(port, () => console.log(`[slack-webhook] Listening on port ${port}`));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  signingSecret: string,
  slack: WebClient,
  userMap: Map<string, UserConfig>,
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/slack/events") { res.writeHead(404).end(); return; }

  const body = await readBody(req);
  if (!verifySlackSignature(req, body, signingSecret)) {
    res.writeHead(401).end("Invalid signature");
    return;
  }

  const payload = JSON.parse(body) as Record<string, unknown>;

  // URL verification challenge
  if (payload["type"] === "url_verification") {
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ challenge: payload["challenge"] }));
    return;
  }

  res.writeHead(200).end("OK");

  if (payload["type"] !== "event_callback") return;
  const event = payload["event"] as Record<string, unknown>;
  const eventId = payload["event_id"] as string;
  const eventType = event["type"] as string;

  // Only handle DMs and app_mention
  if (eventType !== "message" && eventType !== "app_mention") return;
  // Ignore bot messages
  if (event["bot_id"] || event["subtype"]) return;

  const slackUserId = event["user"] as string | undefined;
  if (!slackUserId) return;

  const user = userMap.get(slackUserId);
  if (!user) { console.warn(`[slack] No user mapped for Slack ID '${slackUserId}'`); return; }

  if (await dedup.isProcessed(eventId)) return;

  // Resolve channel name for context
  let channelName = event["channel"] as string;
  try {
    const info = await slack.conversations.info({ channel: channelName });
    channelName = (info.channel as Record<string, unknown>)?.["name"] as string ?? channelName;
  } catch { /* use raw channel ID */ }

  const text = (event["text"] as string | undefined) ?? "";
  const sourceEvent: SourceEvent = {
    id: eventId,
    source: "slack",
    type: eventType === "app_mention" ? "mention" : "dm",
    actor: slackUserId,
    title: eventType === "app_mention" ? `Slack mention in #${channelName}` : `Slack DM`,
    body: text,
    url: `https://slack.com/app_redirect?channel=${event["channel"]}`,
    receivedAt: new Date(parseFloat(event["ts"] as string) * 1000).toISOString(),
    raw: event,
  };

  let drafts;
  try {
    drafts = await extractActions(sourceEvent, config.llm, config.llmMode);
  } catch (err) {
    console.warn(`[slack] LLM failed for event ${eventId}:`, err);
    return;
  }

  if (drafts.length > 0) {
    const written = await writer.writeActions(drafts, sourceEvent, user.username);
    if (written < drafts.length) return; // partial — don't mark processed
  }

  await dedup.markProcessed(eventId);
}

function verifySlackSignature(req: IncomingMessage, body: string, secret: string): boolean {
  const ts = req.headers["x-slack-request-timestamp"] as string | undefined;
  const sig = req.headers["x-slack-signature"] as string | undefined;
  if (!ts || !sig) return false;
  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;
  const baseStr = `v0:${ts}:${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(baseStr).digest("hex")}`;
  try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
