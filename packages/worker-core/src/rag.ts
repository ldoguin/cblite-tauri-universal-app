import axios from "axios";
import type { BaseWorkerConfig } from "./types.js";
import { ServerEmbedder } from "./embedder.js";

interface CbSearchHit {
  id: string;
  score: number;
  fields?: { text?: string; source_id?: string; chunk_index?: number };
}

interface CbSearchResponse {
  hits?: CbSearchHit[];
  total_hits?: number;
}

/**
 * Retrieve the most relevant chunks for a query text using Couchbase vector search.
 *
 * Embeds the query with the server embedding model, then runs a kNN vector
 * search against the `server_embedding` field in the user's private chunks
 * collection. Returns a formatted string ready for injection into an LLM prompt.
 *
 * @param queryText  Text to embed and search for (e.g. a source event body).
 * @param username   Used to scope the search to the user's private data.
 * @param config     Worker config — provides LLM/embedding settings and CB search URL.
 * @returns          Formatted context string, or empty string if no results.
 */
export async function retrieveContext(
  queryText: string,
  username: string,
  config: BaseWorkerConfig
): Promise<string> {
  if (!queryText.trim()) return "";

  const cbSearchUrl = process.env["CB_SEARCH_URL"] ?? "http://localhost:8094";
  const cbCredentials = process.env["CB_CREDENTIALS"] ?? "";
  const privateBucket = process.env["PRIVATE_BUCKET"] ?? "private";
  const topK = config.embedding.ragTopK;

  // Embed the query
  const embedder = new ServerEmbedder(config.llm, config.embedding.model);
  let queryVector: number[];
  try {
    queryVector = await embedder.embed(queryText.slice(0, 2000));
  } catch (err) {
    console.warn("[rag] Query embedding failed (skipping RAG):", err);
    return "";
  }

  // Build the Couchbase FTS vector search request
  const indexName = `idx_chunks_server_embedding_${username.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const searchUrl = `${cbSearchUrl}/api/bucket/${privateBucket}/scope/${username}/index/${indexName}/query`;

  const body = {
    query: { match_none: {} },
    knn: [
      {
        field: "server_embedding",
        vector: queryVector,
        k: topK,
      },
    ],
    fields: ["text", "source_id", "chunk_index"],
    size: topK,
  };

  let hits: CbSearchHit[] = [];
  try {
    const res = await axios.post<CbSearchResponse>(searchUrl, body, {
      headers: {
        "Content-Type": "application/json",
        ...(cbCredentials
          ? { Authorization: `Basic ${Buffer.from(cbCredentials).toString("base64")}` }
          : {}),
      },
      timeout: 10_000,
    });
    hits = res.data?.hits ?? [];
  } catch (err) {
    console.warn("[rag] Vector search failed (skipping RAG):", err);
    return "";
  }

  if (hits.length === 0) return "";

  // Format hits into a readable context block
  const lines: string[] = ["## Relevant context from your knowledge base"];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const text = hit.fields?.text ?? "(no text)";
    const source = hit.fields?.source_id ?? hit.id;
    lines.push(`\n### Excerpt ${i + 1} (source: ${source})`);
    lines.push(text.trim());
  }

  return lines.join("\n");
}
