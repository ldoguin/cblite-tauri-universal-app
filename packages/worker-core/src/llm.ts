import axios from "axios";
import { z } from "zod";
import type { ActionItemDraft, LlmConfig, LlmMode, SourceEvent, UserKnowledgeBase } from "./types.js";
import { renderKbForPrompt } from "./knowledge-base.js";

// ── Zod schema ────────────────────────────────────────────────────────────────

const ActionItemDraftSchema = z.object({
  action_type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  raw_payload: z.record(z.unknown()).default({}),
});

const LLMResponseSchema = z.array(ActionItemDraftSchema);

// ── System prompt ─────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are an action-extraction assistant. Given an event from any source (email, GitHub, Slack, Jira, etc.), decide whether it requires any follow-up actions from the recipient.

Return a JSON array of action items. Return an empty array [] if no action is needed.

Each action item must have:
- "action_type": a short snake_case string. Use one of these well-known types when appropriate:
    "email_reply"        — write and send a reply
    "follow_up"          — follow up on something pending
    "schedule_meeting"   — book or confirm a meeting
    "review_document"    — read and review a document, PR, or MR
    "review_code"        — review a code change
    "resolve_issue"      — fix or close an issue/ticket
    "make_payment"       — complete a financial action
    "approve_request"    — approve a pending request
    "loom_response"      — record a short Loom video response (use when a visual walkthrough or demo would be clearer than text)
    Or any other descriptive snake_case string for unlisted types.
- "title": a concise one-line summary of the action (max 80 chars)
- "body": 1-3 sentences describing what needs to be done and why
- "raw_payload": structured data extracted from the event useful for executing the action

Rules:
- Only create actions for events that genuinely require a response or follow-up
- Automated notifications, FYI messages, and read-only updates with no required action → return []
- Use "loom_response" when: the event involves a complex technical question, bug walkthrough, sales demo request, or anything where showing is clearer than telling
- One event can produce multiple actions if truly needed
- Respond with ONLY the JSON array, no markdown, no explanation`;

function buildSystemPrompt(kb?: UserKnowledgeBase, ragContext?: string): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  if (kb) {
    const kbSection = renderKbForPrompt(kb);
    if (kbSection) parts.push(`\n# Context about the recipient\n${kbSection}`);
  }

  if (ragContext?.trim()) {
    parts.push(`\n${ragContext.trim()}`);
  }

  return parts.join("");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract action item drafts from a source event.
 *
 * @param event       The normalised source event.
 * @param config      LLM connection config.
 * @param mode        "llm" = ask the model; "passthrough" = one draft directly from event fields.
 * @param kb          Optional user knowledge base — injected into the system prompt.
 * @param ragContext  Optional RAG context string — injected after the KB section.
 */
export async function extractActions(
  event: SourceEvent,
  config: LlmConfig,
  mode: LlmMode = "llm",
  kb?: UserKnowledgeBase,
  ragContext?: string
): Promise<ActionItemDraft[]> {
  if (mode === "passthrough") {
    return [
      {
        action_type: event.type,
        title: event.title,
        body: event.body.slice(0, 500),
        raw_payload: { source_event: event.raw, url: event.url },
      },
    ];
  }

  const systemPrompt = buildSystemPrompt(kb, ragContext);
  const userMessage = formatEventForLLM(event);
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  let rawContent: string;
  try {
    const res = await axios.post(
      url,
      {
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      }
    );
    rawContent = res.data?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    console.error("[llm] API request failed:", err);
    throw err;
  }

  return parseLLMResponse(rawContent, event.id);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEventForLLM(event: SourceEvent): string {
  return [
    `Source: ${event.source}`,
    `Type: ${event.type}`,
    `From: ${event.actor}`,
    `Title: ${event.title}`,
    `URL: ${event.url}`,
    `Received: ${event.receivedAt}`,
    ``,
    event.body.slice(0, 4000),
  ].join("\n");
}

function parseLLMResponse(raw: string, eventId: string): ActionItemDraft[] {
  if (!raw.trim()) {
    console.warn(`[llm] Empty response for event ${eventId}`);
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* fall through */ }
    }
    if (!parsed) {
      console.warn(`[llm] Could not parse JSON for event ${eventId}:`, raw.slice(0, 200));
      throw new Error("LLM returned non-JSON response");
    }
  }

  // Unwrap object wrapper e.g. {"actions": [...]}
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const firstArray = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
    if (firstArray) parsed = firstArray;
  }

  const result = LLMResponseSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[llm] Schema validation failed for event ${eventId}:`, result.error.flatten());
    throw new Error("LLM response failed schema validation");
  }

  return result.data;
}
