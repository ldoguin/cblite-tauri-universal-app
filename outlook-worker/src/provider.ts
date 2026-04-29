import axios from "axios";
import type { SourceEvent, SourceProvider, UserConfig } from "@cblite-uni-app/worker-core";

interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: Array<{ emailAddress: { address: string } }>;
  receivedDateTime: string;
  webLink: string;
}

interface GraphResponse { value: GraphMessage[] }

export class OutlookProvider implements SourceProvider {
  private clientId: string;
  private clientSecret: string;
  private tenantId: string;
  private refreshTokens: Map<string, string>;
  /** Cache: username → { accessToken, expiresAt } */
  private accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(clientId: string, clientSecret: string, tenantId: string, refreshTokens: Map<string, string>) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tenantId = tenantId;
    this.refreshTokens = refreshTokens;
  }

  async listEvents(user: UserConfig): Promise<SourceEvent[]> {
    const accessToken = await this.getAccessToken(user.username);
    if (!accessToken) return [];

    let messages: GraphMessage[];
    try {
      const res = await axios.get<GraphResponse>(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { "$filter": "isRead eq false", "$top": 50, "$select": "id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,webLink" },
          timeout: 15_000,
        }
      );
      messages = res.data.value;
    } catch (err) {
      console.error(`[outlook] Failed to fetch messages for '${user.username}':`, err);
      throw err;
    }

    // Mark all fetched messages as read
    await Promise.allSettled(messages.map((m) =>
      axios.patch(
        `https://graph.microsoft.com/v1.0/me/messages/${m.id}`,
        { isRead: true },
        { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, timeout: 10_000 }
      )
    ));

    return messages.map((m) => ({
      id: `outlook::${m.id}`,
      source: "outlook",
      type: "email",
      actor: m.from.emailAddress.address,
      title: m.subject || "(no subject)",
      body: m.bodyPreview || stripHtml(m.body.content),
      url: m.webLink,
      receivedAt: m.receivedDateTime,
      raw: m as unknown as Record<string, unknown>,
    }));
  }

  private async getAccessToken(username: string): Promise<string | null> {
    const cached = this.accessTokens.get(username);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const refreshToken = this.refreshTokens.get(username);
    if (!refreshToken) { console.warn(`[outlook] No refresh token for '${username}'.`); return null; }

    try {
      const res = await axios.post<{ access_token: string; expires_in: number }>(
        `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: "https://graph.microsoft.com/Mail.ReadWrite",
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000 }
      );
      const token = res.data.access_token;
      this.accessTokens.set(username, { token, expiresAt: Date.now() + res.data.expires_in * 1000 });
      return token;
    } catch (err) {
      console.error(`[outlook] Token refresh failed for '${username}':`, err);
      return null;
    }
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}
