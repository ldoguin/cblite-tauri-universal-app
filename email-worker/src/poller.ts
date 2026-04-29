import type { SourceEvent, UserConfig as CoreUserConfig } from "@cblite-uni-app/worker-core";
import { Poller as CorePoller, SgWriter, DedupStore, extractActions } from "@cblite-uni-app/worker-core";
import type { AppConfig, EmailMessage, EmailProvider, UserConfig } from "./types.js";

// Adapts the email-specific EmailProvider into the worker-core SourceProvider interface.
class EmailSourceAdapter {
  constructor(private provider: EmailProvider) {}

  async listEvents(user: CoreUserConfig): Promise<SourceEvent[]> {
    const msgs = await this.provider.listMessages(user.username);
    return msgs.map((m) => emailToSourceEvent(m));
  }
}

export function buildPoller(
  config: AppConfig,
  provider: EmailProvider,
  writer: SgWriter,
  dedup: DedupStore
): CorePoller {
  const adapter = new EmailSourceAdapter(provider);
  return new CorePoller(config, config.users as CoreUserConfig[], adapter, writer, dedup);
}

function emailToSourceEvent(m: EmailMessage): SourceEvent {
  return {
    id: m.id,
    source: "email",
    type: "email",
    actor: m.from,
    title: m.subject || "(no subject)",
    body: m.body,
    url: "",
    receivedAt: m.receivedAt,
    raw: { from: m.from, to: m.to, subject: m.subject, received_at: m.receivedAt },
  };
}
