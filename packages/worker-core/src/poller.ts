import type { BaseWorkerConfig, SourceEvent, UserConfig, UserKnowledgeBase } from "./types.js";
import { extractActions } from "./llm.js";
import { SgWriter } from "./sg-writer.js";
import { LocalWriter } from "./local-writer.js";
import { ChunkWriter } from "./chunk-writer.js";
import { DedupStore } from "./dedup-store.js";
import { KnowledgeBaseLoader } from "./knowledge-base.js";
import { retrieveContext } from "./rag.js";
import { extractFacts } from "./fact-extractor.js";
import { FactWriter } from "./fact-writer.js";

export interface SourceProvider {
  listEvents(user: UserConfig): Promise<SourceEvent[]>;
}

export class Poller {
  private config: BaseWorkerConfig;
  private provider: SourceProvider;
  private writer: SgWriter;
  private localWriter: LocalWriter;
  private chunkWriter: ChunkWriter;
  private factWriter: FactWriter;
  private dedup: DedupStore;
  private kb: KnowledgeBaseLoader;
  private users: UserConfig[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Name of this worker — used in fact proposals. Set via WORKER_NAME env var. */
  private workerName: string;

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
    this.kb = new KnowledgeBaseLoader(config.sg);
    this.localWriter = new LocalWriter(config.stateDbPath);
    this.chunkWriter = new ChunkWriter(
      config.sg,
      config.llm,
      config.embedding.model,
      config.embedding.chunkSize,
      config.embedding.chunkOverlap
    );
    this.factWriter = new FactWriter(config.sg);
    this.workerName = process.env["WORKER_NAME"] ?? "unknown";
  }

  async start(): Promise<void> {
    await this.localWriter.open();
    const ms = this.config.pollIntervalSeconds * 1000;
    console.log(`[poller] Starting — interval ${this.config.pollIntervalSeconds}s`);
    // Use recursive setTimeout so a slow cycle never overlaps the next one.
    const schedule = (): void => {
      this.timer = setTimeout(() => {
        this.runCycle()
          .catch((e) => console.error("[poller] Cycle error:", e))
          .finally(() => { if (this.timer !== null) schedule(); });
      }, ms);
    };
    this.runCycle()
      .catch((e) => console.error("[poller] Initial cycle error:", e))
      .finally(() => schedule());
  }

  async stop(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    await this.localWriter.close();
  }

  /** Process a single event immediately (called by webhook handlers). */
  async processEvent(event: SourceEvent, user: UserConfig): Promise<void> {
    const userKb = await this.kb.load(user.username).catch(() => undefined);
    await this.handleEvent(event, user, userKb);
  }


  /** Extract facts from an event and write a pending proposal to SG. */
  private async extractAndProposeFacts(
    event: SourceEvent,
    username: string,
    kb?: UserKnowledgeBase
  ): Promise<void> {
    const facts = await extractFacts(event, kb, this.config.llm, this.workerName);
    if (facts.length === 0) return;
    await this.factWriter.writeProposal(facts, event, username, this.workerName);
  }

  private async runCycle(): Promise<void> {
    for (const user of this.users) {
      // Load KB once per user per cycle — cached internally for 5 min
      const userKb = await this.kb.load(user.username).catch(() => undefined);

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
        if (!await this.dedup.claimEvent(event.id)) continue;
        await this.handleEvent(event, user, userKb);
      }
    }
  }

  private async handleEvent(event: SourceEvent, user: UserConfig, userKb?: UserKnowledgeBase): Promise<void> {
    console.log(`[poller] Processing '${event.title}' (${event.source}) for '${user.username}'`);

    // Retrieve relevant context from the user's vector store (non-fatal)
    const ragContext = await retrieveContext(
      `${event.title}\n${event.body}`.slice(0, 2000),
      user.username,
      this.config
    ).catch((err) => {
      console.warn("[poller] RAG retrieval failed (non-fatal):", err);
      return undefined;
    });

    let drafts;
    try {
      drafts = await extractActions(event, this.config.llm, this.config.llmMode, userKb, ragContext);
    } catch (err) {
      console.warn(`[poller] LLM failed for event ${event.id} — will retry:`, err);
      this.dedup.releaseClaim(event.id);
      return;
    }

    console.log(`[poller] ${drafts.length} action(s) produced for '${event.title}'`);

    if (drafts.length > 0) {
      const localDrafts = drafts.filter((d) => d.sync_mode === "local");
      const syncedDrafts = drafts.filter((d) => d.sync_mode !== "local");

      // Write local-only drafts directly to CBLite
      if (localDrafts.length > 0) {
        try {
          await this.localWriter.writeActions(localDrafts, event, user.username);
        } catch (err) {
          console.error(`[poller] Local write failed for event ${event.id}:`, err);
          this.dedup.releaseClaim(event.id);
          return;
        }
      }

      // Write synced drafts to SG — chunk+embed vectorize:true docs first
      if (syncedDrafts.length > 0) {
        // Build action docs so we have stable IDs before writing chunks
        const actionDocs = this.writer.buildActionDocs(syncedDrafts, event, user.username);

        // For each vectorize:true doc, chunk+embed and write chunks before the parent
        for (const doc of actionDocs) {
          if (doc.vectorize && doc.body) {
            try {
              await this.chunkWriter.writeChunks(doc.id, "actions", doc.body, user.username);
            } catch (err) {
              console.warn(`[poller] Chunk write failed for '${doc.id}' (non-fatal):`, err);
              // Non-fatal: continue writing the parent doc even if chunking fails
            }
          }
        }

        let written: number;
        try {
          written = await this.writer.writeActionDocs(actionDocs, user.username);
        } catch (err) {
          console.error(`[poller] SG write failed for event ${event.id} — will retry:`, err);
          this.dedup.releaseClaim(event.id);
          return;
        }
        if (written < syncedDrafts.length) {
          console.warn(`[poller] Partial SG write (${written}/${syncedDrafts.length}) — will retry event ${event.id}`);
          this.dedup.releaseClaim(event.id);
          return;
        }
      }
    }

    await this.dedup.markProcessed(event.id);

    // Background fact extraction — non-blocking, never throws into the event loop
    if (this.config.llmMode === "llm" && process.env["KB_FACTS_ENABLED"] !== "false") {
      this.extractAndProposeFacts(event, user.username, userKb).catch((err) =>
        console.warn(`[poller] Fact extraction failed for event '${event.id}' (non-fatal):`, err)
      );
    }
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
