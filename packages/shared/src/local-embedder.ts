/**
 * Main-thread wrapper around the embedding Web Worker.
 *
 * Manages the worker lifecycle, queues embed requests, and resolves them
 * as promises. The worker is started lazily on the first embed call.
 */

/** Per-request timeout — matches the worker-side EMBED_TIMEOUT_MS + model load headroom. */
const REQUEST_TIMEOUT_MS = 90_000;

interface PendingRequest {
  resolve: (embedding: number[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`[local-embedder] Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, text });
    });
  }

  /** Terminate the worker. Call on app teardown. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this._rejectAll(new Error("[local-embedder] Worker terminated"));
  }

  private _rejectAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(this.workerUrl, { type: "module" });

    this.worker.onmessage = (
      event: MessageEvent<
        | { type: "model_ready" }
        | { type: "model_error"; error: string }
        | { id: string; embedding?: number[]; error?: string }
      >
    ) => {
      const data = event.data;

      // Typed broadcast messages from the worker (no request id).
      if ("type" in data) {
        if (data.type === "model_error") {
          console.error("[local-embedder] Worker model load failed:", data.error);
          // Reject all pending requests — the worker is unusable.
          this._rejectAll(new Error(`[local-embedder] Model load failed: ${data.error}`));
          this.worker?.terminate();
          this.worker = null;
        }
        // model_ready is informational; no action needed.
        return;
      }

      const { id, embedding, error } = data;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
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
      this._rejectAll(new Error(`[local-embedder] Worker error: ${err.message}`));
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

/** Terminate the active embedding worker and release its memory. */
export function terminateLocalEmbedder(): void {
  if (_instance) {
    _instance.terminate();
    _instance = null;
  }
}

export function initLocalEmbedder(workerUrl: string | URL): LocalEmbedder {
  if (_instance) _instance.terminate();
  _instance = new LocalEmbedder(workerUrl);
  return _instance;
}
