// ── Rich-text editor helpers (Tiptap JSON) ────────────────────────────────────

/** Parse stored content string into Tiptap JSON. Wraps legacy plain text in a paragraph. */
export function parseContent(raw: string): object {
  if (raw && raw.trimStart().startsWith("{")) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  if (!raw) return { type: "doc", content: [{ type: "paragraph" }] };
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: raw }] }],
  };
}

/** Recursively extract plain text from a Tiptap JSON doc node. */
export function extractPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n["type"] === "text" && typeof n["text"] === "string") return n["text"];
  if (Array.isArray(n["content"])) {
    return (n["content"] as unknown[]).map(extractPlainText).join(" ");
  }
  return "";
}

/** Walk Tiptap JSON and replace "cbl-blob:sha1-..." image src with data URIs for display. */
export async function resolveBlobRefs(
  doc: unknown,
  getBlobData: (digest: string) => Promise<string>
): Promise<unknown> {
  if (!doc || typeof doc !== "object") return doc;
  const n = doc as Record<string, unknown>;
  if (n["type"] === "image" && typeof n["attrs"] === "object" && n["attrs"]) {
    const attrs = { ...(n["attrs"] as Record<string, unknown>) };
    const src = attrs["src"];
    if (typeof src === "string" && src.startsWith("cbl-blob:")) {
      const digest = src.slice("cbl-blob:".length);
      try {
        const b64 = await getBlobData(digest);
        attrs["src"] = `data:image/png;base64,${b64}`;
        attrs["data-blob-digest"] = digest;
      } catch { /* leave src as-is on error */ }
    }
    return { ...n, attrs };
  }
  if (Array.isArray(n["content"])) {
    const resolved = await Promise.all(
      (n["content"] as unknown[]).map((child) => resolveBlobRefs(child, getBlobData))
    );
    return { ...n, content: resolved };
  }
  return n;
}

/** Walk Tiptap JSON and replace data URI image srcs with "cbl-blob:" refs before persisting. */
export function stripDataUris(doc: unknown): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const n = doc as Record<string, unknown>;
  if (n["type"] === "image" && typeof n["attrs"] === "object" && n["attrs"]) {
    const attrs = { ...(n["attrs"] as Record<string, unknown>) };
    const digest = attrs["data-blob-digest"];
    if (typeof digest === "string" && digest) {
      attrs["src"] = `cbl-blob:${digest}`;
      delete attrs["data-blob-digest"];
    }
    return { ...n, attrs };
  }
  if (Array.isArray(n["content"])) {
    return { ...n, content: (n["content"] as unknown[]).map(stripDataUris) };
  }
  return n;
}
