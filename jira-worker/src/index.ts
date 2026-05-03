import "dotenv/config";
import { mkdir } from "fs/promises";
import { SgWriter, DedupStore, Poller, loadUsersRaw, validateBaseConfig, loadBaseConfig } from "@cblite-uni-app/worker-core";
import type { UserConfig } from "@cblite-uni-app/worker-core";
import { JiraProvider } from "./provider.js";

async function main(): Promise<void> {
  console.log("[jira-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw();
  const config = { ...base, pollIntervalSeconds: parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "300", 10) };
  validateBaseConfig(config, users);

  const baseUrl = process.env["JIRA_BASE_URL"];
  if (!baseUrl) throw new Error("JIRA_BASE_URL is required");

  const creds = new Map<string, { email: string; apiToken: string }>();
  for (const u of users) {
    const email = process.env[`JIRA_EMAIL_${u.username.toUpperCase()}`];
    const token = process.env[`JIRA_API_TOKEN_${u.username.toUpperCase()}`];
    if (email && token) creds.set(u.username, { email, apiToken: token });
    else console.warn(`[jira-worker] Missing JIRA_EMAIL_/JIRA_API_TOKEN_ for '${u.username}'`);
  }

  await mkdir(config.stateDbPath, { recursive: true });
  const provider = new JiraProvider(baseUrl, creds);
  const dedup = new DedupStore(config.stateDbPath, "jira-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users as UserConfig[], provider, writer, dedup);
  await poller.start();

  process.on("SIGINT", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { await poller.stop(); await dedup.close(); process.exit(0); });
  console.log(`[jira-worker] Running. Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[jira-worker] Fatal:", err); process.exit(1); });
