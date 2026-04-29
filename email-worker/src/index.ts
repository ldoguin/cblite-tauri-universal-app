import "dotenv/config";
import { mkdir } from "fs/promises";
import { SgWriter, DedupStore, loadUsersRaw, validateBaseConfig } from "@cblite-uni-app/worker-core";
import type { AppConfig, UserConfig } from "./types.js";
import { AgentMailProvider } from "./providers/agentmail.js";
import { GmailProvider } from "./providers/gmail.js";
import { buildPoller } from "./poller.js";
import { WebhookServer } from "./webhook.js";

function loadConfig(): AppConfig {
  const provider = (process.env["EMAIL_PROVIDER"] ?? "agentmail") as "agentmail" | "gmail";
  if (provider !== "agentmail" && provider !== "gmail")
    throw new Error(`EMAIL_PROVIDER must be "agentmail" or "gmail", got "${provider}"`);

  const users = loadUsersRaw() as UserConfig[];

  const userPasswords: Record<string, string> = {};
  for (const u of users) {
    const pw = process.env[`SG_PASSWORD_${u.username.toUpperCase()}`];
    if (pw) userPasswords[u.username.toLowerCase()] = pw;
  }

  return {
    provider,
    users,
    agentmail: {
      apiKey: process.env["AGENTMAIL_API_KEY"] ?? "",
      domain: process.env["AGENTMAIL_DOMAIN"] ?? "",
    },
    gmail: {
      clientId: process.env["GMAIL_CLIENT_ID"] ?? "",
      clientSecret: process.env["GMAIL_CLIENT_SECRET"] ?? "",
    },
    llm: {
      apiKey: process.env["OPENAI_API_KEY"] ?? "",
      baseUrl: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
    },
    llmMode: (process.env["LLM_MODE"] ?? "llm") as "llm" | "passthrough",
    sg: {
      url: process.env["SYNC_GATEWAY_URL"] ?? "http://localhost:4984",
      db: process.env["SYNC_GATEWAY_DB"] ?? "notes",
      serviceUsername: process.env["SG_SERVICE_USERNAME"],
      servicePassword: process.env["SG_SERVICE_PASSWORD"],
      userPasswords,
    },
    pollIntervalSeconds: parseInt(process.env["POLL_INTERVAL_SECONDS"] ?? "60", 10),
    webhookPort: process.env["WEBHOOK_PORT"] ? parseInt(process.env["WEBHOOK_PORT"], 10) : undefined,
    stateDbPath: process.env["STATE_DB_PATH"] ?? "./data",
  };
}

function validateConfig(config: AppConfig): void {
  validateBaseConfig(config, config.users);
  if (config.provider === "agentmail") {
    if (!config.agentmail.apiKey) throw new Error("AGENTMAIL_API_KEY is required");
    if (!config.agentmail.domain) throw new Error("AGENTMAIL_DOMAIN is required");
    for (const u of config.users)
      if (!u.email) throw new Error(`User '${u.username}' missing 'email' (required for AgentMail)`);
  }
  if (config.provider === "gmail") {
    if (!config.gmail.clientId) throw new Error("GMAIL_CLIENT_ID is required");
    if (!config.gmail.clientSecret) throw new Error("GMAIL_CLIENT_SECRET is required");
    for (const u of config.users)
      if (!u.gmail_refresh_token) throw new Error(`User '${u.username}' missing 'gmail_refresh_token'`);
  }
}

async function main(): Promise<void> {
  console.log("[email-worker] Starting…");
  const config = loadConfig();
  validateConfig(config);
  await mkdir(config.stateDbPath, { recursive: true });

  const provider =
    config.provider === "agentmail"
      ? new AgentMailProvider(config.agentmail.apiKey, config.agentmail.domain)
      : new GmailProvider(
          config.gmail.clientId,
          config.gmail.clientSecret,
          new Map(config.users.filter((u) => u.gmail_refresh_token).map((u) => [u.username, u.gmail_refresh_token!]))
        );

  const dedup = new DedupStore(config.stateDbPath, "email-worker-state");
  await dedup.open();
  const writer = new SgWriter(config.sg);
  const poller = buildPoller(config, provider, writer, dedup);
  poller.start();

  if (config.webhookPort) {
    const webhookServer = new WebhookServer(config, poller);
    webhookServer.start(config.webhookPort);
  }

  const shutdown = async (sig: string) => {
    console.log(`[email-worker] ${sig} — shutting down…`);
    poller.stop();
    await dedup.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  console.log(`[email-worker] Running. Provider: ${config.provider}, Users: ${config.users.map((u) => u.username).join(", ")}`);
}

main().catch((err) => { console.error("[email-worker] Fatal:", err); process.exit(1); });
