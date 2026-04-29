import "dotenv/config";
import { mkdir } from "fs/promises";
import { SgWriter, DedupStore, Poller, loadUsersRaw, validateBaseConfig, loadBaseConfig } from "@cblite-uni-app/worker-core";
import type { UserConfig } from "@cblite-uni-app/worker-core";
import { GitHubProvider } from "./provider.js";
import { startWebhookServer } from "./webhook.js";

async function main(): Promise<void> {
  console.log("[github-worker] Starting…");

  const base = loadBaseConfig();
  const users = loadUsersRaw();
  const config = { ...base, pollIntervalSeconds: parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "60", 10) };
  validateBaseConfig(config, users);

  // Build per-user token map from GITHUB_TOKEN_<USERNAME> env vars
  const tokens = new Map<string, string>();
  for (const u of users) {
    const token = process.env[`GITHUB_TOKEN_${u.username.toUpperCase()}`];
    if (token) tokens.set(u.username, token);
    else console.warn(`[github-worker] No GITHUB_TOKEN_${u.username.toUpperCase()} — user will be skipped`);
  }

  await mkdir(config.stateDbPath, { recursive: true });

  const provider = new GitHubProvider(tokens);
  const dedup = new DedupStore(config.stateDbPath, "github-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users as UserConfig[], provider, writer, dedup);
  poller.start();

  if (config.webhookPort) {
    const secret = process.env["GITHUB_WEBHOOK_SECRET"];
    startWebhookServer(config.webhookPort, secret, users as UserConfig[], poller);
  }

  const shutdown = async (sig: string) => {
    console.log(`[github-worker] ${sig} — shutting down…`);
    poller.stop(); await dedup.close(); process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  console.log(`[github-worker] Running. Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[github-worker] Fatal:", err); process.exit(1); });
