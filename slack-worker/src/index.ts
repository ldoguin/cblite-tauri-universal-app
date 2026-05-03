import "dotenv/config";
import { mkdir } from "fs/promises";
import { Poller, SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig } from "@cblite-uni-app/worker-core";
import { startSlackWebhookServer } from "./webhook.js";

async function main(): Promise<void> {
  console.log("[slack-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw() as Array<{ username: string; slack_user_id: string }>;
  const config = { ...base, pollIntervalSeconds: 0 }; // webhook-only, no poll
  validateBaseConfig(config, users);

  const botToken = process.env["SLACK_BOT_TOKEN"];
  if (!botToken) throw new Error("SLACK_BOT_TOKEN is required");
  const signingSecret = process.env["SLACK_SIGNING_SECRET"];
  if (!signingSecret) throw new Error("SLACK_SIGNING_SECRET is required");
  if (!config.webhookPort) throw new Error("WEBHOOK_PORT is required for slack-worker");

  for (const u of users)
    if (!u.slack_user_id) throw new Error(`User '${u.username}' missing 'slack_user_id'`);

  await mkdir(config.stateDbPath, { recursive: true });
  const dedup = new DedupStore(config.stateDbPath, "slack-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users, { listEvents: async () => [] }, writer, dedup);
  await poller.start();

  startSlackWebhookServer(config.webhookPort, botToken, signingSecret, users, poller, dedup);

  process.on("SIGINT", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  console.log(`[slack-worker] Running on port ${config.webhookPort}. Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[slack-worker] Fatal:", err); process.exit(1); });
