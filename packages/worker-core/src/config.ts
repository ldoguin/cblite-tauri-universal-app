import type { BaseWorkerConfig, EmbeddingConfig, LlmMode, SgConfig, UserConfig } from "./types.js";

/** Parse the common env vars shared by every worker. */
export function loadBaseConfig(): Omit<BaseWorkerConfig, "pollIntervalSeconds"> {
  const llmMode = (process.env["LLM_MODE"] ?? "llm") as LlmMode;
  if (llmMode !== "llm" && llmMode !== "passthrough") {
    throw new Error(`LLM_MODE must be "llm" or "passthrough", got "${llmMode}"`);
  }

  const webhookPortRaw = process.env["WEBHOOK_PORT"];

  return {
    llm: {
      apiKey: process.env["OPENAI_API_KEY"] ?? "",
      baseUrl: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      model: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
    },
    llmMode,
    sg: loadSgConfig(),
    webhookPort: webhookPortRaw ? parseInt(webhookPortRaw, 10) : undefined,
    stateDbPath: process.env["STATE_DB_PATH"] ?? "./data",
    embedding: loadEmbeddingConfig(),
  };
}

/** Parse embedding / chunking env vars. */
export function loadEmbeddingConfig(): EmbeddingConfig {
  return {
    model: process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-large",
    chunkSize: parseInt(process.env["CHUNK_SIZE"] ?? "512", 10),
    chunkOverlap: parseInt(process.env["CHUNK_OVERLAP"] ?? "64", 10),
    ragTopK: parseInt(process.env["RAG_TOP_K"] ?? "5", 10),
  };
}

export function loadSgConfig(): SgConfig {
  const users = loadUsersRaw();
  const userPasswords: Record<string, string> = {};
  for (const u of users) {
    const key = `SG_PASSWORD_${u.username.toUpperCase()}`;
    const pw = process.env[key];
    if (pw) userPasswords[u.username.toLowerCase()] = pw;
  }
  return {
    url: process.env["SYNC_GATEWAY_URL"] ?? "http://localhost:4984",
    db: process.env["SYNC_GATEWAY_DB"] ?? "notes",
    serviceUsername: process.env["SG_SERVICE_USERNAME"],
    servicePassword: process.env["SG_SERVICE_PASSWORD"],
    userPasswords,
  };
}

export function loadUsersRaw(): UserConfig[] {
  try {
    const users = JSON.parse(process.env["USERS"] ?? "[]") as UserConfig[];
    if (!Array.isArray(users) || users.length === 0) throw new Error("empty");
    return users;
  } catch {
    throw new Error("USERS env var must be a non-empty JSON array");
  }
}

export function validateBaseConfig(config: BaseWorkerConfig, users: UserConfig[]): void {
  if (!config.llm.apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!config.sg.url) throw new Error("SYNC_GATEWAY_URL is required");
  if (!config.sg.serviceUsername) {
    for (const u of users) {
      if (!config.sg.userPasswords[u.username.toLowerCase()]) {
        throw new Error(
          `No SG password for '${u.username}'. Set SG_PASSWORD_${u.username.toUpperCase()} or SG_SERVICE_USERNAME/SG_SERVICE_PASSWORD.`
        );
      }
    }
  }
}
