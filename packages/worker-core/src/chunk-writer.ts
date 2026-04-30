import axios, { type AxiosInstance } from "axios";
import { randomUUID } from "crypto";
import type { ChunkDoc, SgConfig } from "./types.js";
import { chunkText } from "./chunker.js";
import { ServerEmbedder } from "./embedder.js";
import type { LlmConfig } from "./types.js";

interface CachedSession {
  token: string;
  expiresAt: number;
}

/**
 * Chunks a document body, embeds each chunk via the server embedding model,
 * and writes the resulting ChunkDocs to the SG `chunks` collection before
 * the parent document is written.
 *
 * Chunk IDs follow the pattern: `chunk::<sourceDocId>::<index>`
 */
export class ChunkWriter {
  private sgConfig: SgConfig;
  private embedder: ServerEmbedder;
  private chunkSize: number;
  private chunkOverlap: number;
  private client: AxiosInstance;
  private sessions = new Map<string, CachedSession>();

  constructor(
    sgConfig: SgConfig,
    llmConfig: LlmConfig,
    embeddingModel: string,
    chunkSize = 512,
    chunkOverlap = 64
  ) {
    this.sgConfig = sgConfig;
    this.embedder = new ServerEmbedder(llmConfig, embeddingModel);
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.client = axios.create({
      baseURL: sgConfig.url.replace(/\/$/, ""),
      timeout: 15_000,
    });
  }

  /**
   * Chunk `text`, embed each chunk, and write ChunkDocs to SG.
   *
   * @param sourceDocId      ID of the parent document.
   * @param sourceCollection Collection the parent doc belongs to (e.g. "actions").
   * @param text             Plaintext content to chunk.
   * @param owner            Username — used for SG auth and `source_owner` field.
   * @returns                Number of chunk docs successfully written.
   */
  async writeChunks(
    sourceDocId: string,
    sourceCollection: string,
    text: string,
    owner: string
  ): Promise<number> {
    const chunks = chunkText(text, this.chunkSize, this.chunkOverlap);
    if (chunks.length === 0) return 0;

    // Embed all chunks in one batch call
    let embeddings: number[][];
    try {
      embeddings = await this.embedder.embedBatch(chunks);
    } catch (err) {
      console.error(`[chunk-writer] Embedding failed for '${sourceDocId}':`, err);
      throw err;
    }

    const token = await this.getSessionToken(owner);
    const now = new Date().toISOString();
    let written = 0;

    for (let i = 0; i < chunks.length; i++) {
      const doc: ChunkDoc = {
        id: `chunk::${sourceDocId}::${i}`,
        type: "chunk",
        source_id: sourceDocId,
        source_collection: sourceCollection,
        source_owner: owner,
        chunk_index: i,
        text: chunks[i],
        server_embedding: embeddings[i],
        created_at: now,
        updated_at: now,
      };

      const ok = await this.putChunkDoc(doc, token, owner);
      if (ok) written++;
    }

    console.log(`[chunk-writer] Wrote ${written}/${chunks.length} chunks for '${sourceDocId}'.`);
    return written;
  }

  private async putChunkDoc(doc: ChunkDoc, token: string, owner: string): Promise<boolean> {
    const url = `/${this.sgConfig.db}/_default.chunks/${doc.id}`;
    try {
      await this.client.put(url, doc, {
        headers: { "Content-Type": "application/json", Cookie: `SyncGatewaySession=${token}` },
      });
      return true;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.sessions.delete(owner);
        try {
          const fresh = await this.getSessionToken(owner);
          await this.client.put(url, doc, {
            headers: { "Content-Type": "application/json", Cookie: `SyncGatewaySession=${fresh}` },
          });
          return true;
        } catch (retryErr) {
          console.error(`[chunk-writer] Write failed after re-auth for '${owner}':`, retryErr);
          return false;
        }
      }
      console.error(`[chunk-writer] Write failed for chunk '${doc.id}':`, err);
      return false;
    }
  }

  private async getSessionToken(username: string): Promise<string> {
    const cached = this.sessions.get(username);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const password = this.resolvePassword(username);
    if (!password) throw new Error(`[chunk-writer] No password for user '${username}'`);

    const res = await this.client.post<{ session_id: string; expires: string }>(
      `/${this.sgConfig.db}/_session`,
      { name: username, password },
      { headers: { "Content-Type": "application/json" } }
    );
    const token = res.data.session_id;
    const expiresAt = res.data.expires
      ? new Date(res.data.expires).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.sessions.set(username, { token, expiresAt });
    return token;
  }

  private resolvePassword(username: string): string | undefined {
    if (this.sgConfig.serviceUsername && this.sgConfig.servicePassword) return this.sgConfig.servicePassword;
    return this.sgConfig.userPasswords[username.toLowerCase()];
  }
}
