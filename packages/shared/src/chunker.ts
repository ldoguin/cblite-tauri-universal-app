/**
 * Sentence-aware text chunker (browser-compatible).
 * Mirrors the logic in packages/worker-core/src/chunker.ts.
 */

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function approxTokens(text: string): number {
  return Math.ceil(text.trim().split(/\s+/).length / 0.75);
}

export function chunkText(text: string, chunkSize = 512, overlap = 64): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (approxTokens(trimmed) <= chunkSize) return [trimmed];

  const sentences = trimmed.split(SENTENCE_BOUNDARY).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentTokens = approxTokens(sentence);

    if (sentTokens > chunkSize) {
      if (current.length > 0) { chunks.push(current.join(" ")); current = []; currentTokens = 0; }
      const words = sentence.split(/\s+/);
      let wordBuf: string[] = [];
      let wordTokens = 0;
      for (const word of words) {
        const wt = approxTokens(word);
        if (wordTokens + wt > chunkSize && wordBuf.length > 0) {
          chunks.push(wordBuf.join(" "));
          const overlapWords = wordBuf.slice(-Math.ceil(overlap * 0.75));
          wordBuf = overlapWords;
          wordTokens = approxTokens(wordBuf.join(" "));
        }
        wordBuf.push(word);
        wordTokens += wt;
      }
      if (wordBuf.length > 0) { current = wordBuf; currentTokens = wordTokens; }
      continue;
    }

    if (currentTokens + sentTokens > chunkSize && current.length > 0) {
      chunks.push(current.join(" "));
      const overlapSentences: string[] = [];
      let overlapTokens = 0;
      for (let i = current.length - 1; i >= 0 && overlapTokens < overlap; i--) {
        overlapSentences.unshift(current[i]);
        overlapTokens += approxTokens(current[i]);
      }
      current = overlapSentences;
      currentTokens = overlapTokens;
    }

    current.push(sentence);
    currentTokens += sentTokens;
  }

  if (current.length > 0) chunks.push(current.join(" "));
  return chunks;
}
