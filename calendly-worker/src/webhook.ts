import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import type { BaseWorkerConfig, DedupStore, SgWriter, SourceEvent, UserConfig } from "@cblite-uni-app/worker-core";
import { extractActions } from "@cblite-uni-app/worker-core";

type Provider = "calendly" | "calcom";

interface UserWithScheduling extends UserConfig {
  calendly_uri?: string;
  calcom_user_id?: number;
}

export function startCalendlyWebhookServer(
  port: number,
  provider: Provider,
  webhookSecret: string,
  users: UserWithScheduling[],
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): void {
  const server = createServer((req, res) => {
    handle(req, res, provider, webhookSecret, users, config, writer, dedup).catch((err) => {
      console.error("[calendly-webhook] Error:", err);
      res.writeHead(500).end();
    });
  });
  server.listen(port, () => console.log(`[calendly-webhook] Listening on port ${port} (${provider})`));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  provider: Provider,
  secret: string,
  users: UserWithScheduling[],
  config: BaseWorkerConfig,
  writer: SgWriter,
  dedup: DedupStore
): Promise<void> {
  if (req.method !== "POST" || req.url !== "/webhook") { res.writeHead(404).end(); return; }

  const body = await readBody(req);

  if (!verifySignature(req, body, secret, provider)) {
    res.writeHead(401).end("Invalid signature");
    return;
  }

  res.writeHead(200).end("OK");

  const payload = JSON.parse(body) as Record<string, unknown>;
  const result = provider === "calendly"
    ? parseCalendlyEvent(payload, users)
    : parseCalcomEvent(payload, users);

  if (!result) return;
  const { event, user } = result;

  if (await dedup.isProcessed(event.id)) return;

  let drafts;
  try {
    drafts = await extractActions(event, config.llm, config.llmMode);
  } catch (err) {
    console.warn(`[calendly] LLM failed for event ${event.id}:`, err);
    return;
  }

  if (drafts.length > 0) {
    const written = await writer.writeActions(drafts, event, user.username);
    if (written < drafts.length) return;
  }

  await dedup.markProcessed(event.id);
}

// ── Calendly parser ───────────────────────────────────────────────────────────

function parseCalendlyEvent(
  payload: Record<string, unknown>,
  users: UserWithScheduling[]
): { event: SourceEvent; user: UserWithScheduling } | null {
  const eventType = payload["event"] as string | undefined;
  if (!["invitee.created", "invitee.canceled", "invitee.rescheduled"].includes(eventType ?? "")) return null;

  const data = payload["payload"] as Record<string, unknown>;
  const invitee = data["invitee"] as Record<string, unknown>;
  const eventData = data["event"] as Record<string, unknown>;
  const organiserUri = (eventData?.["event_memberships"] as Array<Record<string, string>> | undefined)?.[0]?.["user"];

  const user = users.find((u) => u.calendly_uri === organiserUri) ?? users[0];
  if (!user) return null;

  const actionTypeMap: Record<string, string> = {
    "invitee.created": "meeting_booked",
    "invitee.canceled": "meeting_cancelled",
    "invitee.rescheduled": "meeting_rescheduled",
  };

  const eventId = `calendly::${invitee["uri"] as string}::${eventType}`;
  const startTime = (eventData?.["start_time"] as string | undefined) ?? "";
  const inviteeName = invitee["name"] as string ?? "Someone";
  const eventName = eventData?.["name"] as string ?? "Meeting";

  return {
    event: {
      id: eventId,
      source: "calendly",
      type: actionTypeMap[eventType!] ?? eventType!,
      actor: invitee["email"] as string ?? "",
      title: `${actionTypeMap[eventType!]?.replace(/_/g, " ")}: ${eventName} with ${inviteeName}`,
      body: [
        `Event: ${eventName}`,
        `Invitee: ${inviteeName} (${invitee["email"]})`,
        startTime ? `Start: ${startTime}` : "",
        invitee["cancel_url"] ? `Cancel URL: ${invitee["cancel_url"]}` : "",
        invitee["reschedule_url"] ? `Reschedule URL: ${invitee["reschedule_url"]}` : "",
      ].filter(Boolean).join("\n"),
      url: eventData?.["location"]?.toString() ?? "",
      receivedAt: new Date().toISOString(),
      raw: payload,
    },
    user,
  };
}

// ── Cal.com parser ────────────────────────────────────────────────────────────

function parseCalcomEvent(
  payload: Record<string, unknown>,
  users: UserWithScheduling[]
): { event: SourceEvent; user: UserWithScheduling } | null {
  const triggerEvent = payload["triggerEvent"] as string | undefined;
  if (!["BOOKING_CREATED", "BOOKING_CANCELLED", "BOOKING_RESCHEDULED"].includes(triggerEvent ?? "")) return null;

  const booking = payload["payload"] as Record<string, unknown>;
  const organiserUserId = (booking["organizer"] as Record<string, unknown> | undefined)?.["id"];
  const user = users.find((u) => u.calcom_user_id === organiserUserId) ?? users[0];
  if (!user) return null;

  const actionTypeMap: Record<string, string> = {
    BOOKING_CREATED: "meeting_booked",
    BOOKING_CANCELLED: "meeting_cancelled",
    BOOKING_RESCHEDULED: "meeting_rescheduled",
  };

  const attendees = (booking["attendees"] as Array<Record<string, string>> | undefined) ?? [];
  const attendeeNames = attendees.map((a) => a["name"]).join(", ");
  const startTime = booking["startTime"] as string ?? "";

  return {
    event: {
      id: `calcom::${booking["uid"]}::${triggerEvent}`,
      source: "calcom",
      type: actionTypeMap[triggerEvent!] ?? triggerEvent!,
      actor: attendees[0]?.["email"] ?? "",
      title: `${actionTypeMap[triggerEvent!]?.replace(/_/g, " ")}: ${booking["title"]} with ${attendeeNames}`,
      body: [
        `Event: ${booking["title"]}`,
        `Attendees: ${attendeeNames}`,
        startTime ? `Start: ${startTime}` : "",
        booking["description"] ? `Notes: ${booking["description"]}` : "",
      ].filter(Boolean).join("\n"),
      url: booking["metadata"]?.toString() ?? "",
      receivedAt: new Date().toISOString(),
      raw: payload,
    },
    user,
  };
}

// ── Signature verification ────────────────────────────────────────────────────

function verifySignature(req: IncomingMessage, body: string, secret: string, provider: Provider): boolean {
  if (provider === "calendly") {
    // Calendly: Calendly-Webhook-Signature header = t=<ts>,v1=<hmac>
    const header = req.headers["calendly-webhook-signature"] as string | undefined;
    if (!header) return false;
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
    const ts = parts["t"]; const v1 = parts["v1"];
    if (!ts || !v1) return false;
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    try { return timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(expected, "hex")); } catch { return false; }
  } else {
    // Cal.com: X-Cal-Signature-256 header
    const sig = req.headers["x-cal-signature-256"] as string | undefined;
    if (!sig) return false;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
