import axios, { type AxiosInstance } from "axios";
import type { EmailMessage, EmailProvider } from "../types.js";

// ── AgentMail REST API types ──────────────────────────────────────────────────

interface AgentMailMessage {
  id: string;
  from: { address: string; name?: string };
  to: Array<{ address: string; name?: string }>;
  subject: string;
  text?: string;
  html?: string;
  date: string;
}

interface AgentMailListResponse {
  messages: AgentMailMessage[];
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class AgentMailProvider implements EmailProvider {
  private client: AxiosInstance;
  private domain: string;

  constructor(apiKey: string, domain: string) {
    this.domain = domain;
    this.client = axios.create({
      baseURL: "https://api.agentmail.to/v0",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });
  }

  async listMessages(username: string): Promise<EmailMessage[]> {
    // AgentMail inbox address: <username>@<domain>
    const inboxAddress = `${username}@${this.domain}`;

    let response: AgentMailListResponse;
    try {
      const res = await this.client.get<AgentMailListResponse>("/inboxes/messages", {
        params: { inbox: inboxAddress, limit: 50 },
      });
      response = res.data;
    } catch (err) {
      console.error(`[agentmail] Failed to list messages for ${username}:`, err);
      throw err;
    }

    return (response.messages ?? []).map((m) => this.toEmailMessage(m));
  }

  private toEmailMessage(m: AgentMailMessage): EmailMessage {
    // Prefer plain text; strip basic HTML tags as fallback
    const body = m.text ?? stripHtml(m.html ?? "");
    return {
      id: m.id,
      from: m.from.address,
      to: (m.to ?? []).map((t) => t.address).join(", "),
      subject: m.subject ?? "(no subject)",
      body: body.trim(),
      receivedAt: m.date,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
