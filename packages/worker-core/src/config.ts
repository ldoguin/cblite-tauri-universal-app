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
    webhookPort: webhookPortRaw ? parseIntEnv("WEBHOOK_PORT", 3001) : undefined,
    stateDbPath: process.env["STATE_DB_PATH"] ?? "./data",
    embedding: loadEmbeddingConfig(),
  };
}

/** Parse an integer env var, falling back to `defaultVal` if missing or non-numeric. */
function parseIntEnv(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    console.warn(`[config] ${name}="${raw}" is not a valid integer — using default ${defaultVal}`);
    return defaultVal;
  }
  return n;
}

/** Parse embedding / chunking env vars. */
export function loadEmbeddingConfig(): EmbeddingConfig {
  return {
    model: process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-large",
    chunkSize: parseIntEnv("CHUNK_SIZE", 512),
    chunkOverlap: parseIntEnv("CHUNK_OVERLAP", 64),
    ragTopK: parseIntEnv("RAG_TOP_K", 5),
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env["USERS"] ?? "[]");
  } catch {
    throw new Error("USERS env var is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("USERS env var must be a non-empty JSON array");
  }
  // Validate each entry has the required `username` field.
  for (let i = 0; i < parsed.length; i++) {
    const u = parsed[i];
    if (typeof u !== "object" || u === null || typeof (u as Record<string, unknown>)["username"] !== "string") {
      throw new Error(`USERS[${i}] is missing a required string "username" field`);
    }
  }
  return parsed as UserConfig[];
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

  // Validate CB_CREDENTIALS early so a misconfigured value is caught at startup
  // rather than silently producing an invalid Authorization header at query time.
  const cbCreds = process.env["CB_CREDENTIALS"] ?? "";
  if (cbCreds) {
    if (!cbCreds.includes(":")) {
      throw new Error(
        'CB_CREDENTIALS must be in "username:password" format (colon-separated)'
      );
    }
    // Reject values that look like they are already base64-encoded (common misconfiguration).
    if (/^[A-Za-z0-9+/]+=*$/.test(cbCreds) && !cbCreds.includes(":")) {
      throw new Error(
        "CB_CREDENTIALS appears to be base64-encoded — provide the raw username:password value"
      );
    }
  }
}
