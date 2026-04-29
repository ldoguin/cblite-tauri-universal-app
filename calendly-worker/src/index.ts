import "dotenv/config";
import { mkdir } from "fs/promises";
import { SgWriter, DedupStore, loadUsersRaw, validateBaseConfig, loadBaseConfig } from "@cblite-uni-app/worker-core";
import { startCalendlyWebhookServer } from "./webhook.js";

async function main(): Promise<void> {
  console.log("[calendly-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw();
  const config = { ...base, pollIntervalSeconds: 0 }; // webhook-only
  validateBaseConfig(config, users);

  const provider = (process.env["SCHEDULING_PROVIDER"] ?? "calendly") as "calendly" | "calcom";
  if (provider !== "calendly" && provider !== "calcom")
    throw new Error(`SCHEDULING_PROVIDER must be "calendly" or "calcom"`);
  if (!config.webhookPort) throw new Error("WEBHOOK_PORT is required for calendly-worker");

  const secret = provider === "calendly"
    ? process.env["CALENDLY_WEBHOOK_SECRET"]
    : process.env["CALCOM_WEBHOOK_SECRET"];
  if (!secret) throw new Error(`${provider === "calendly" ? "CALENDLY" : "CALCOM"}_WEBHOOK_SECRET is required`);

  // Attach provider-specific IDs to user configs
  const enrichedUsers = users.map((u) => ({
    ...u,
    calendly_uri: process.env[`CALENDLY_URI_${u.username.toUpperCase()}`],
    calcom_user_id: process.env[`CALCOM_USER_ID_${u.username.toUpperCase()}`]
      ? parseInt(process.env[`CALCOM_USER_ID_${u.username.toUpperCase()}`]!, 10)
      : undefined,
  }));

  await mkdir(config.stateDbPath, { recursive: true });
  const dedup = new DedupStore(config.stateDbPath, "calendly-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);

  startCalendlyWebhookServer(config.webhookPort, provider, secret, enrichedUsers, config, writer, dedup);

  process.on("SIGINT", async () => { await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await dedup.close(); process.exit(0); });
  console.log(`[calendly-worker] Running on port ${config.webhookPort} (${provider}). Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[calendly-worker] Fatal:", err); process.exit(1); });
