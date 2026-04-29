import type { BaseWorkerConfig, SourceEvent, UserConfig } from "./types.js";
import { extractActions } from "./llm.js";
import { SgWriter } from "./sg-writer.js";
import { DedupStore } from "./dedup-store.js";

export interface SourceProvider {
  listEvents(user: UserConfig): Promise<SourceEvent[]>;
}

export class Poller {
  private config: BaseWorkerConfig;
  private provider: SourceProvider;
  private writer: SgWriter;
  private dedup: DedupStore;
  private users: UserConfig[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: BaseWorkerConfig,
    users: UserConfig[],
    provider: SourceProvider,
    writer: SgWriter,
    dedup: DedupStore
  ) {
    this.config = config;
    this.users = users;
    this.provider = provider;
    this.writer = writer;
    this.dedup = dedup;
  }

  start(): void {
    const ms = this.config.pollIntervalSeconds * 1000;
    console.log(`[poller] Starting — interval ${this.config.pollIntervalSeconds}s`);
    this.runCycle().catch((e) => console.error("[poller] Initial cycle error:", e));
    this.timer = setInterval(() => {
      this.runCycle().catch((e) => console.error("[poller] Cycle error:", e));
    }, ms);
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  /** Process a single event immediately (called by webhook handlers). */
  async processEvent(event: SourceEvent, user: UserConfig): Promise<void> {
    await this.handleEvent(event, user);
  }

  private async runCycle(): Promise<void> {
    for (const user of this.users) {
      let events: SourceEvent[];
      try {
        events = await withRetry(() => this.provider.listEvents(user), 3);
      } catch (err) {
        console.error(`[poller] Failed to fetch events for '${user.username}':`, err);
        continue;
      }
      if (events.length > 0)
        console.log(`[poller] ${events.length} event(s) for '${user.username}'`);
      for (const event of events) {
        if (await this.dedup.isProcessed(event.id)) continue;
        await this.handleEvent(event, user);
      }
    }
  }

  private async handleEvent(event: SourceEvent, user: UserConfig): Promise<void> {
    console.log(`[poller] Processing '${event.title}' (${event.source}) for '${user.username}'`);

    let drafts;
    try {
      drafts = await extractActions(event, this.config.llm, this.config.llmMode);
    } catch (err) {
      console.warn(`[poller] LLM failed for event ${event.id} — will retry:`, err);
      return;
    }

    console.log(`[poller] ${drafts.length} action(s) produced for '${event.title}'`);

    if (drafts.length > 0) {
      let written: number;
      try {
        written = await this.writer.writeActions(drafts, event, user.username);
      } catch (err) {
        console.error(`[poller] SG write failed for event ${event.id} — will retry:`, err);
        return;
      }
      if (written < drafts.length) {
        console.warn(`[poller] Partial write (${written}/${drafts.length}) — will retry event ${event.id}`);
        return;
      }
    }

    await this.dedup.markProcessed(event.id);
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
