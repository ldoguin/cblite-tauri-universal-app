import axios from "axios";
import type { LlmConfig } from "./types.js";

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
    const url = `${this.baseUrl}/embeddings`;
    const res = await axios.post(
      url,
      { model: this.model, input: text },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );
    const embedding = res.data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`[embedder] Unexpected response shape: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    return embedding as number[];
  }

  /**
   * Embed multiple texts in a single API call (batch).
   * Returns an array of embeddings in the same order as the input.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const url = `${this.baseUrl}/embeddings`;
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
      throw new Error(`[embedder] Unexpected batch response: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    // Sort by index to guarantee order matches input
    return data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
