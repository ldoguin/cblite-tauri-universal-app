import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import type { ChunkDoc } from "./types.js";
import { getLocalEmbedder } from "./local-embedder.js";

const DEFAULT_TOP_K = 5;

interface ChunkRow {
  id: string;
  text: string;
  source_id: string;
  chunk_index: number;
  local_embedding?: number[];
}

/**
 * Retrieve the most relevant local chunks for a query using CBLite vector search.
 *
 * Falls back to BM25 keyword search if:
 * - The local embedder is not initialised
 * - The vector index is unavailable
 * - The query embedding fails
 *
 * @param query    The user's query text.
 * @param adapter  The CBLite database adapter.
 * @param topK     Number of chunks to return (default 5).
 * @returns        Formatted context string for injection into the LLM prompt,
 *                 or empty string if no relevant chunks found.
 */
export async function retrieveLocalContext(
  query: string,
  adapter: DatabaseAdapter,
  topK = DEFAULT_TOP_K
): Promise<string> {
  if (!query.trim()) return "";

  const embedder = getLocalEmbedder();

  // Try vector search first
  if (embedder) {
    try {
      const embedding = await embedder.embed(query.slice(0, 1000));
      const hits = await vectorSearch(adapter, embedding, topK);
      if (hits.length > 0) return formatChunks(hits);
    } catch (err) {
      console.warn("[rag] Vector search failed, falling back to BM25:", err);
    }
  }

  // BM25 keyword fallback
  try {
    const hits = await bm25Search(adapter, query, topK);
    if (hits.length > 0) return formatChunks(hits);
  } catch (err) {
    console.warn("[rag] BM25 fallback failed:", err);
  }

  return "";
}

// ── Vector search ─────────────────────────────────────────────────────────────

async function vectorSearch(
  adapter: DatabaseAdapter,
  queryEmbedding: number[],
  topK: number
): Promise<ChunkRow[]> {
  // CBLite vector search via N1QL APPROX_VECTOR_DISTANCE function (EE feature).
  // Falls back gracefully if the index doesn't exist.
  const rows = (await adapter.executeQuery(
    "N1QL",
    `SELECT META().id AS id, text, source_id, chunk_index
     FROM chunks
     WHERE type = 'chunk'
       AND local_embedding IS NOT MISSING
     ORDER BY APPROX_VECTOR_DISTANCE(local_embedding, $embedding) ASC
     LIMIT $topK`,
    { embedding: queryEmbedding, topK }
  )) as ChunkRow[];
  return rows.filter((r) => r && r.id);
}

// ── BM25 keyword fallback ─────────────────────────────────────────────────────

async function bm25Search(
  adapter: DatabaseAdapter,
  query: string,
  topK: number
): Promise<ChunkRow[]> {
  const pattern = `%${query.toLowerCase().slice(0, 100)}%`;
  const rows = (await adapter.executeQuery(
    "N1QL",
    `SELECT META().id AS id, text, source_id, chunk_index
     FROM chunks
     WHERE type = 'chunk'
       AND LOWER(text) LIKE $pattern
     LIMIT $topK`,
    { pattern, topK }
  )) as ChunkRow[];
  return rows.filter((r) => r && r.id);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatChunks(chunks: ChunkRow[]): string {
  if (chunks.length === 0) return "";
  const lines: string[] = ["## Relevant context from your notes"];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    lines.push(`\n### Excerpt ${i + 1} (from ${c.source_id})`);
    lines.push(c.text.trim());
  }
  return lines.join("\n");
}
