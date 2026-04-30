/**
 * Web Worker for local text embedding using @xenova/transformers (ONNX runtime).
 *
 * Messages in:  { id: string; text: string; modelPath?: string }
 * Messages out: { id: string; embedding: number[] }
 *             | { id: string; error: string }
 *
 * The worker is lazy-initialised: the model is loaded on the first embed request.
 * If VITE_LOCAL_EMBEDDING_MODEL_PATH is set (injected at build time), that path
 * is used; otherwise the model is downloaded from HuggingFace on first use and
 * cached by the browser / Tauri webview.
 */

// @xenova/transformers uses dynamic imports internally; the worker context
// supports this in modern browsers and Tauri's webview.
import { pipeline, env } from "@xenova/transformers";

// Disable local model file checks — we always fetch from remote or a custom path.
env.allowLocalModels = false;
env.allowRemoteModels = true;

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

type EmbedPipeline = Awaited<ReturnType<typeof pipeline>>;
let embedder: EmbedPipeline | null = null;
let currentModelPath: string | null = null;

async function getEmbedder(modelPath: string): Promise<EmbedPipeline> {
  if (embedder && currentModelPath === modelPath) return embedder;
  console.log(`[embedding-worker] Loading model: ${modelPath}`);
  embedder = await pipeline("feature-extraction", modelPath, {
    quantized: true,
  });
  currentModelPath = modelPath;
  console.log("[embedding-worker] Model loaded.");
  return embedder;
}

self.onmessage = async (event: MessageEvent<{ id: string; text: string; modelPath?: string }>) => {
  const { id, text, modelPath } = event.data;
  const resolvedModel = modelPath
    // Injected at Vite build time from VITE_LOCAL_EMBEDDING_MODEL_PATH env var
    ?? (typeof import.meta !== "undefined" && (import.meta as Record<string, unknown>).env
        ? ((import.meta as Record<string, Record<string, string>>).env["VITE_LOCAL_EMBEDDING_MODEL_PATH"] ?? DEFAULT_MODEL)
        : DEFAULT_MODEL);

  try {
    const pipe = await getEmbedder(resolvedModel);
    // feature-extraction returns a Tensor; mean-pool over the token dimension
    const output = await pipe(text, { pooling: "mean", normalize: true });
    // Convert to plain number array
    const embedding: number[] = Array.from(output.data as Float32Array);
    self.postMessage({ id, embedding });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
