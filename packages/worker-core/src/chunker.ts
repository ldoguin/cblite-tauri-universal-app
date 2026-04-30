/**
 * Sentence-aware text chunker.
 *
 * Splits text into overlapping chunks of approximately `chunkSize` tokens,
 * respecting sentence boundaries where possible. Token count is approximated
 * as `Math.ceil(words / 0.75)` (1 token ≈ 0.75 words for English text).
 */

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function approxTokens(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words / 0.75);
}

/**
 * Split `text` into overlapping chunks.
 *
 * @param text       Input text to chunk.
 * @param chunkSize  Target chunk size in tokens (default 512).
 * @param overlap    Overlap between consecutive chunks in tokens (default 64).
 * @returns          Array of chunk strings. Returns `[]` for empty input.
 */
export function chunkText(
  text: string,
  chunkSize = 512,
  overlap = 64
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // If the whole text fits in one chunk, return it as-is.
  if (approxTokens(trimmed) <= chunkSize) return [trimmed];

  // Split into sentences first, then greedily pack into chunks.
  const sentences = trimmed.split(SENTENCE_BOUNDARY).map((s) => s.trim()).filter(Boolean);

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentTokens = approxTokens(sentence);

    // If a single sentence exceeds chunkSize, hard-split it by words.
    if (sentTokens > chunkSize) {
      // Flush current buffer first
      if (current.length > 0) {
        chunks.push(current.join(" "));
        current = [];
        currentTokens = 0;
      }
      const words = sentence.split(/\s+/);
      let wordBuf: string[] = [];
      let wordTokens = 0;
      for (const word of words) {
        const wt = approxTokens(word);
        if (wordTokens + wt > chunkSize && wordBuf.length > 0) {
          chunks.push(wordBuf.join(" "));
          // Keep overlap words
          const overlapWords = wordBuf.slice(-Math.ceil(overlap * 0.75));
          wordBuf = overlapWords;
          wordTokens = approxTokens(wordBuf.join(" "));
        }
        wordBuf.push(word);
        wordTokens += wt;
      }
      if (wordBuf.length > 0) {
        current = wordBuf;
        currentTokens = wordTokens;
      }
      continue;
    }

    if (currentTokens + sentTokens > chunkSize && current.length > 0) {
      chunks.push(current.join(" "));
      // Carry over overlap: take sentences from the end of current buffer
      // until we've accumulated ~overlap tokens.
      const overlapSentences: string[] = [];
      let overlapTokens = 0;
      for (let i = current.length - 1; i >= 0 && overlapTokens < overlap; i--) {
        const t = approxTokens(current[i]);
        overlapSentences.unshift(current[i]);
        overlapTokens += t;
      }
      current = overlapSentences;
      currentTokens = overlapTokens;
    }

    current.push(sentence);
    currentTokens += sentTokens;
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}
