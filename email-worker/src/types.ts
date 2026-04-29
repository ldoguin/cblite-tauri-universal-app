// Email-worker-specific types. Shared types (SourceEvent, ActionItemDraft, etc.)
// are imported from @cblite-uni-app/worker-core.

import type { BaseWorkerConfig } from "@cblite-uni-app/worker-core";

export interface EmailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export interface EmailProvider {
  listMessages(username: string): Promise<EmailMessage[]>;
}

export interface UserConfig {
  username: string;
  email?: string;
  gmail_refresh_token?: string;
}

export interface AppConfig extends BaseWorkerConfig {
  provider: "agentmail" | "gmail";
  users: UserConfig[];
  agentmail: { apiKey: string; domain: string };
  gmail: { clientId: string; clientSecret: string };
}
