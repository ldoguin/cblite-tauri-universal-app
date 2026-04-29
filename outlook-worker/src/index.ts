import "dotenv/config";
import { mkdir } from "fs/promises";
import { SgWriter, DedupStore, Poller, loadUsersRaw, validateBaseConfig, loadBaseConfig } from "@cblite-uni-app/worker-core";
import type { UserConfig } from "@cblite-uni-app/worker-core";
import { OutlookProvider } from "./provider.js";

async function main(): Promise<void> {
  console.log("[outlook-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw();
  const config = { ...base, pollIntervalSeconds: parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "60", 10) };
  validateBaseConfig(config, users);

  const clientId = process.env["AZURE_CLIENT_ID"]; if (!clientId) throw new Error("AZURE_CLIENT_ID required");
  const clientSecret = process.env["AZURE_CLIENT_SECRET"]; if (!clientSecret) throw new Error("AZURE_CLIENT_SECRET required");
  const tenantId = process.env["AZURE_TENANT_ID"] ?? "common";

  const refreshTokens = new Map<string, string>();
  for (const u of users) {
    const t = process.env[`OUTLOOK_REFRESH_TOKEN_${u.username.toUpperCase()}`];
    if (t) refreshTokens.set(u.username, t);
    else console.warn(`[outlook-worker] No OUTLOOK_REFRESH_TOKEN_${u.username.toUpperCase()}`);
  }

  await mkdir(config.stateDbPath, { recursive: true });
  const provider = new OutlookProvider(clientId, clientSecret, tenantId, refreshTokens);
  const dedup = new DedupStore(config.stateDbPath, "outlook-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users as UserConfig[], provider, writer, dedup);
  poller.start();

  process.on("SIGINT", async () => { poller.stop(); await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { poller.stop(); await dedup.close(); process.exit(0); });
  console.log(`[outlook-worker] Running. Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[outlook-worker] Fatal:", err); process.exit(1); });
