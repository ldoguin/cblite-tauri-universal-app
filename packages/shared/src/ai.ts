// ── AI helpers ────────────────────────────────────────────────────────────────

import { aiChat } from "./server.js";
import type { ChatMessage, AuthSession, UserProfile } from "./types.js";
import type { OpenAIMessage, OpenAIContentPart } from "./server.js";
import type { DatabaseAdapter } from "@cblite-uni-app/cblite-adapter";
import { retrieveLocalContext } from "./rag.js";

export async function buildOpenAIMessages(
  history: ChatMessage[],
  getBlobData: (digest: string) => Promise<string>
): Promise<OpenAIMessage[]> {
  const result: OpenAIMessage[] = [];
  for (const msg of history) {
    if (!msg.attachments?.length) {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    const parts: OpenAIContentPart[] = [];
    if (msg.content) parts.push({ type: "text", text: msg.content });
    for (const att of msg.attachments) {
      if (att.mime.startsWith("image/")) {
        try {
          const b64 = await getBlobData(att.digest);
          parts.push({ type: "image_url", image_url: { url: `data:${att.mime};base64,${b64}` } });
        } catch { /* skip unresolvable blobs */ }
      } else {
        parts.push({ type: "text", text: `(Attached file: ${att.name})` });
      }
    }
    result.push({ role: msg.role, content: parts });
  }
  return result;
}

export async function getAIReply(
  history: ChatMessage[],
  user: UserProfile | null,
  authSession: AuthSession | null,
  getBlobData: (digest: string) => Promise<string>,
  adapter?: DatabaseAdapter
): Promise<string> {
  const apiKey = user?.openai_api_key?.trim() || undefined;
  const openaiBaseUrl = user?.openai_base_url?.trim() || "https://api.openai.com/v1";

  // Retrieve local RAG context from the last user message (non-fatal)
  let ragContext = "";
  if (adapter) {
    const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      ragContext = await retrieveLocalContext(lastUserMsg.content, adapter)
        .catch((e) => { console.warn("[ai] RAG retrieval failed:", e); return ""; });
    }
  }

  // Prepend a RAG system message when context is available
  const baseMessages = await buildOpenAIMessages(history, getBlobData);
  const messages: OpenAIMessage[] = ragContext
    ? [{ role: "system", content: ragContext }, ...baseMessages]
    : baseMessages;

  // Proxy through the auth server when connected — server may supply its own key.
  if (authSession?.server_url && authSession.token) {
    return aiChat(authSession.server_url, authSession.token, messages, apiKey, undefined, openaiBaseUrl);
  }

  // Direct fallback — requires a user-supplied key.
  if (!apiKey) return "(No OpenAI API key set — add one in Profile → AI settings.)";
  const res = await fetch(`${openaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages }),
  });
  if (!res.ok) throw new Error(`OpenAI error (${res.status}): ${await res.text()}`);
  const json: { choices: { message: { content: string } }[] } = await res.json();
  return json.choices[0]?.message?.content ?? "";
}
