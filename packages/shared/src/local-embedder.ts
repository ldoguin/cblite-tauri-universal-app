/**
 * Main-thread wrapper around the embedding Web Worker.
 *
 * Manages the worker lifecycle, queues embed requests, and resolves them
 * as promises. The worker is started lazily on the first embed call.
 */

interface PendingRequest {
  resolve: (embedding: number[]) => void;
  reject: (err: Error) => void;
}

export class LocalEmbedder {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private idCounter = 0;
  private workerUrl: string;

  /**
   * @param workerUrl  URL of the compiled embedding worker script.
   *                   In Vite projects, use:
   *                   `new URL("./embedding-worker.ts", import.meta.url)`
   */
  constructor(workerUrl: string | URL) {
    this.workerUrl = typeof workerUrl === "string" ? workerUrl : workerUrl.toString();
  }

  /** Embed a single text string. Returns a float32 array. */
  async embed(text: string): Promise<number[]> {
    const worker = this.getWorker();
    const id = String(++this.idCounter);

    return new Promise<number[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, text });
    });
  }

  /** Terminate the worker. Call on app teardown. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error("[local-embedder] Worker terminated"));
    }
    this.pending.clear();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(this.workerUrl, { type: "module" });

    this.worker.onmessage = (event: MessageEvent<{ id: string; embedding?: number[]; error?: string }>) => {
      const { id, embedding, error } = event.data;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) {
        pending.reject(new Error(error));
      } else if (embedding) {
        pending.resolve(embedding);
      } else {
        pending.reject(new Error("[local-embedder] Empty response from worker"));
      }
    };

    this.worker.onerror = (err) => {
      console.error("[local-embedder] Worker error:", err);
      // Reject all pending requests
      for (const { reject } of this.pending.values()) {
        reject(new Error(`[local-embedder] Worker error: ${err.message}`));
      }
      this.pending.clear();
      this.worker = null;
    };

    return this.worker;
  }
}

// Singleton instance — shared across the app.
// Initialised lazily in app.ts after the worker URL is known.
let _instance: LocalEmbedder | null = null;

export function getLocalEmbedder(): LocalEmbedder | null {
  return _instance;
}

export function initLocalEmbedder(workerUrl: string | URL): LocalEmbedder {
  if (_instance) _instance.terminate();
  _instance = new LocalEmbedder(workerUrl);
  return _instance;
}
