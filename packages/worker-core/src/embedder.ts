import axios from "axios";
import type { LlmConfig } from "./types.js";

/** OpenAI limits embeddings to 2048 inputs per request. */
const EMBED_BATCH_SIZE = 2048;
/** Retry up to this many times on 429 / 5xx before giving up. */
const EMBED_MAX_RETRIES = 3;
/** Base delay (ms) for exponential back-off on retryable errors. */
const EMBED_RETRY_BASE_MS = 500;

/**
 * Calls an OpenAI-compatible embeddings endpoint to produce a dense vector
 * for a given text string.
 *
 * Uses the same `baseUrl` and `apiKey` as the LLM chat completions calls,
 * so a single `OPENAI_BASE_URL` switch (e.g. to Ollama or Azure) covers both.
 */
export class ServerEmbedder {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: LlmConfig, embeddingModel?: string) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    // Use the dedicated embedding model if provided; fall back to the LLM model.
    this.model = embeddingModel ?? config.model;
  }

  /**
   * Embed a single text string. Returns a float32 array.
   * Throws on API error.
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  /**
   * Embed multiple texts. Splits into sub-batches of at most EMBED_BATCH_SIZE
   * to stay within the OpenAI 2048-input limit. Each sub-batch is retried up
   * to EMBED_MAX_RETRIES times on 429 / 5xx with exponential back-off.
   *
   * Returns embeddings in the same order as the input.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = new Array(texts.length);

    // Split into sub-batches to respect the API limit.
    for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
      const slice = texts.slice(offset, offset + EMBED_BATCH_SIZE);
      const embeddings = await this._embedSliceWithRetry(slice);
      for (let i = 0; i < embeddings.length; i++) {
        results[offset + i] = embeddings[i]!;
      }
    }

    return results;
  }

  private async _embedSliceWithRetry(texts: string[]): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = EMBED_RETRY_BASE_MS * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        const res = await axios.post(
          url,
          { model: this.model, input: texts },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            timeout: 60_000,
          }
        );
        const data: Array<{ index: number; embedding: number[] }> = res.data?.data;
        if (!Array.isArray(data)) {
          throw new Error(`[embedder] Unexpected response: ${JSON.stringify(res.data).slice(0, 200)}`);
        }
        // Sort by index to guarantee order matches input.
        return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } catch (err: unknown) {
        lastErr = err;
        if (axios.isAxiosError(err)) {
          const status = err.response?.status ?? 0;
          // Retry on rate-limit or server errors; give up on client errors.
          if (status >= 400 && status < 500 && status !== 429) {
            throw err;
          }
        }
        if (attempt < EMBED_MAX_RETRIES) {
          console.warn(`[embedder] Attempt ${attempt + 1} failed, retrying:`, err);
        }
      }
    }

    throw lastErr;
  }
}
