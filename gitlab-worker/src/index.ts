import "dotenv/config";
import { mkdir } from "fs/promises";
import { SgWriter, DedupStore, Poller, loadUsersRaw, validateBaseConfig, loadBaseConfig } from "@cblite-uni-app/worker-core";
import type { UserConfig } from "@cblite-uni-app/worker-core";
import { GitLabProvider } from "./provider.js";

async function main(): Promise<void> {
  console.log("[gitlab-worker] Starting…");
  const base = loadBaseConfig();
  const users = loadUsersRaw();
  const config = { ...base, pollIntervalSeconds: parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "60", 10) };
  validateBaseConfig(config, users);

  const baseUrl = process.env["GITLAB_BASE_URL"] ?? "https://gitlab.com";
  const tokens = new Map<string, string>();
  for (const u of users) {
    const t = process.env[`GITLAB_TOKEN_${u.username.toUpperCase()}`];
    if (t) tokens.set(u.username, t);
    else console.warn(`[gitlab-worker] No GITLAB_TOKEN_${u.username.toUpperCase()}`);
  }

  await mkdir(config.stateDbPath, { recursive: true });
  const provider = new GitLabProvider(baseUrl, tokens);
  const dedup = new DedupStore(config.stateDbPath, "gitlab-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = new Poller(config, users as UserConfig[], provider, writer, dedup);
  poller.start();

  process.on("SIGINT", async () => { poller.stop(); await dedup.close(); process.exit(0); });
  process.on("SIGTERM", async () => { poller.stop(); await dedup.close(); process.exit(0); });
  console.log(`[gitlab-worker] Running. Users: ${users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[gitlab-worker] Fatal:", err); process.exit(1); });
