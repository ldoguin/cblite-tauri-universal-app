import { google, type gmail_v1 } from "googleapis";
import type { EmailMessage, EmailProvider } from "../types.js";

// ── Provider ──────────────────────────────────────────────────────────────────

export class GmailProvider implements EmailProvider {
  private clientId: string;
  private clientSecret: string;
  /** Map from username → refresh token */
  private refreshTokens: Map<string, string>;

  constructor(
    clientId: string,
    clientSecret: string,
    refreshTokens: Map<string, string>
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshTokens = refreshTokens;
  }

  async listMessages(username: string): Promise<EmailMessage[]> {
    const refreshToken = this.refreshTokens.get(username);
    if (!refreshToken) {
      console.warn(`[gmail] No refresh token configured for user '${username}'. Skipping.`);
      return [];
    }

    const auth = new google.auth.OAuth2(this.clientId, this.clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: "v1", auth });

    // List up to 50 inbox messages (unread only to reduce noise)
    let listRes: gmail_v1.Schema$ListMessagesResponse;
    try {
      const res = await gmail.users.messages.list({
        userId: "me",
        q: "in:inbox is:unread",
        maxResults: 50,
      });
      listRes = res.data;
    } catch (err) {
      console.error(`[gmail] Failed to list messages for ${username}:`, err);
      throw err;
    }

    const messageRefs = listRes.messages ?? [];
    if (messageRefs.length === 0) return [];

    // Fetch full message details in parallel (capped to avoid rate limits)
    const fetched = await Promise.allSettled(
      messageRefs.map((ref) =>
        gmail.users.messages.get({
          userId: "me",
          id: ref.id!,
          format: "full",
        })
      )
    );

    const messages: EmailMessage[] = [];
    for (const result of fetched) {
      if (result.status === "rejected") {
        console.warn("[gmail] Failed to fetch message:", result.reason);
        continue;
      }
      const msg = result.value.data;
      const parsed = parseGmailMessage(msg);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGmailMessage(msg: gmail_v1.Schema$Message): EmailMessage | null {
  if (!msg.id) return null;

  const headers = msg.payload?.headers ?? [];
  const get = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  const from = get("From");
  const to = get("To");
  const subject = get("Subject") || "(no subject)";
  const date = get("Date");
  const receivedAt = date ? new Date(date).toISOString() : new Date().toISOString();

  const body = extractBody(msg.payload);

  return { id: msg.id, from, to, subject, body, receivedAt };
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Prefer text/plain part
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Recurse into multipart
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fall back to text/html
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
    // Recurse deeper
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  return "";
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
