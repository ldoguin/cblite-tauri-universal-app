import axios from "axios";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { KbContact, KbFact, LlmConfig, SourceEvent, UserKnowledgeBase } from "./types.js";

// ── Zod schema ────────────────────────────────────────────────────────────────

const KbContactSchema = z.object({
  name: z.string(),
  relationship: z.string().optional(),
  notes: z.string().optional(),
});

const KbProjectSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

const RawFactSchema = z.object({
  kind: z.enum(["contact", "project", "ignore_pattern", "priority_pattern", "custom_instruction"]),
  value: z.union([KbContactSchema, KbProjectSchema, z.string()]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const RawFactsSchema = z.array(RawFactSchema);

// ── System prompt ─────────────────────────────────────────────────────────────

const FACTS_SYSTEM_PROMPT = `You are a knowledge extraction assistant. Given an event from any source (email, GitHub, Slack, Jira, etc.), extract structured facts about the recipient's professional context.

Return a JSON array of facts. Return an empty array [] if nothing worth storing is found.

Each fact must have:
- "kind": one of:
    "contact"             — a person mentioned who is relevant to the recipient
    "project"             — a project, repo, or initiative mentioned
    "ignore_pattern"      — a topic, sender, or keyword the recipient should deprioritise
    "priority_pattern"    — a topic or sender that seems high-priority for this recipient
    "custom_instruction"  — any other notable fact about the recipient's context or preferences
- "value":
    For "contact":   { "name": string, "relationship"?: string, "notes"?: string }
    For "project":   { "name": string, "description"?: string, "keywords"?: string[] }
    For others:      a plain string
- "confidence": float 0–1 (how confident you are this fact is accurate and useful)
- "rationale": one sentence explaining why you extracted this fact

Rules:
- Only extract facts that are genuinely informative about the recipient's world
- Do not extract facts already obvious from the event type (e.g. don't extract "uses email")
- For contacts: only people who seem professionally relevant, not mass-mailing senders
- For ignore_pattern: automated bots, CI systems, mass notifications are good candidates
- Confidence below 0.5 should generally not be included
- Respond with ONLY the JSON array, no markdown, no explanation`;

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Extract structured facts from a source event using a dedicated LLM call.
 *
 * Runs independently of action extraction — failures are non-fatal.
 * Returns `[]` on any error or when the LLM finds nothing worth storing.
 *
 * @param event   The normalised source event.
 * @param kb      Current user KB — used to give the LLM context about what's already known.
 * @param config  LLM connection config.
 * @param workerName  Name of the calling worker (e.g. "email", "github").
 */
export async function extractFacts(
  event: SourceEvent,
  kb: UserKnowledgeBase | undefined,
  config: LlmConfig,
  workerName: string
): Promise<KbFact[]> {
  const userMessage = buildUserMessage(event, kb);
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  let rawContent: string;
  try {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model: config.model,
        messages: [
          { role: "system", content: FACTS_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 1024,
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
    console.warn(`[fact-extractor] LLM call failed for event '${event.id}' (non-fatal):`, err);
    return [];
  }

  return parseFacts(rawContent, workerName);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUserMessage(event: SourceEvent, kb?: UserKnowledgeBase): string {
  const lines: string[] = [
    `Source: ${event.source}`,
    `Type: ${event.type}`,
    `Title: ${event.title}`,
    `Body: ${event.body.slice(0, 1500)}`,
  ];
  if (event.actor) lines.push(`Actor: ${event.actor}`);
  if (event.url) lines.push(`URL: ${event.url}`);

  // Give the LLM context about what's already in the KB to avoid redundant extractions
  if (kb) {
    const known: string[] = [];
    if (kb.contacts?.length) {
      known.push(`Known contacts: ${kb.contacts.map((c) => c.name).join(", ")}`);
    }
    if (kb.projects?.length) {
      known.push(`Known projects: ${kb.projects.map((p) => p.name).join(", ")}`);
    }
    if (known.length) {
      lines.push("", "Already in knowledge base (avoid duplicating):", ...known);
    }
  }

  return lines.join("\n");
}

function parseFacts(raw: string, workerName: string): KbFact[] {
  let parsed: unknown;
  try {
    // Handle both bare array and wrapped object responses
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      parsed = JSON.parse(trimmed);
    } else {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      // Find the first array value in the object
      parsed = Object.values(obj).find(Array.isArray) ?? [];
    }
  } catch {
    console.warn(`[fact-extractor][${workerName}] Failed to parse LLM response as JSON`);
    return [];
  }

  const result = RawFactsSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[fact-extractor][${workerName}] Schema validation failed:`, result.error.issues.slice(0, 3));
    return [];
  }

  return result.data.map((raw) => ({
    id: randomUUID(),
    kind: raw.kind,
    value: raw.value,
    confidence: raw.confidence,
    rationale: raw.rationale,
    status: "pending" as const,
  }));
}
