import type { KbFactProposal, KbFact, KbFactKind, UserKnowledgeBase, KbContact, KbProject } from "../types.js";

// ── Event detail types ────────────────────────────────────────────────────────

export interface KbApplyDetail {
  proposalId: string;
  approvedFactIds: string[];
  rejectedFactIds: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<KbFactKind, string> = {
  contact:             "Contact",
  project:             "Project",
  ignore_pattern:      "Ignore pattern",
  priority_pattern:    "Priority pattern",
  custom_instruction:  "Instruction",
};

const KIND_ICON: Record<KbFactKind, string> = {
  contact:             "👤",
  project:             "📁",
  ignore_pattern:      "🚫",
  priority_pattern:    "⭐",
  custom_instruction:  "💡",
};

function formatValue(fact: KbFact): string {
  if (typeof fact.value === "string") return fact.value;
  try { return JSON.stringify(fact.value, null, 2); } catch { return String(fact.value); }
}

function confidenceClass(c: number): string {
  if (c >= 0.8) return "kb-confidence--high";
  if (c >= 0.5) return "kb-confidence--mid";
  return "kb-confidence--low";
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function factName(fact: KbFact): string | null {
  if (typeof fact.value === "string") return fact.value;
  if (fact.value && typeof fact.value === "object") {
    const v = fact.value as Record<string, unknown>;
    if (typeof v["name"] === "string") return v["name"];
  }
  return null;
}

// ── Connection analysis ───────────────────────────────────────────────────────

interface FactConnection {
  type: "existing" | "duplicate";
  label: string;
}

function computeConnections(
  proposals: KbFactProposal[],
  kb: UserKnowledgeBase | null
): Map<string, Map<string, FactConnection[]>> {
  const result = new Map<string, Map<string, FactConnection[]>>();

  const approvedContacts = new Map<string, KbContact>();
  const approvedProjects = new Map<string, KbProject>();
  if (kb) {
    for (const c of kb.contacts ?? []) approvedContacts.set(normName(c.name), c);
    for (const p of kb.projects ?? []) approvedProjects.set(normName(p.name), p);
  }

  type FactRef = { proposalId: string; factId: string; workerName: string };
  const pendingByKey = new Map<string, FactRef[]>();

  for (const proposal of proposals) {
    for (const fact of proposal.facts) {
      if (fact.status !== "pending") continue;
      const name = factName(fact);
      if (!name) continue;
      const key = `${fact.kind}::${normName(name)}`;
      if (!pendingByKey.has(key)) pendingByKey.set(key, []);
      pendingByKey.get(key)!.push({ proposalId: proposal.id, factId: fact.id, workerName: proposal.source_worker });
    }
  }

  for (const proposal of proposals) {
    const factMap = new Map<string, FactConnection[]>();
    result.set(proposal.id, factMap);

    for (const fact of proposal.facts) {
      if (fact.status !== "pending") continue;
      const connections: FactConnection[] = [];
      const name = factName(fact);

      if (name) {
        const nn = normName(name);
        if (fact.kind === "contact" && approvedContacts.has(nn)) {
          connections.push({ type: "existing", label: `Updates existing contact "${approvedContacts.get(nn)!.name}"` });
        } else if (fact.kind === "project" && approvedProjects.has(nn)) {
          connections.push({ type: "existing", label: `Updates existing project "${approvedProjects.get(nn)!.name}"` });
        }
        const others = (pendingByKey.get(`${fact.kind}::${nn}`) ?? []).filter((r) => r.proposalId !== proposal.id);
        for (const other of others) {
          connections.push({ type: "duplicate", label: `Also proposed by ${other.workerName}` });
        }
      }

      if (connections.length > 0) factMap.set(fact.id, connections);
    }
  }

  return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export class CblKbPanel extends HTMLElement {
  private _proposals: KbFactProposal[] = [];
  private _kb: UserKnowledgeBase | null = null;
  private _loading = false;
  private _decisions = new Map<string, Map<string, "approved" | "rejected">>();
  private _filter: string = "all";

  set proposals(v: KbFactProposal[]) {
    this._proposals = v;
    for (const p of v) {
      if (!this._decisions.has(p.id)) {
        const m = new Map<string, "approved" | "rejected">();
        for (const f of p.facts) {
          if (f.status === "approved" || f.status === "rejected") m.set(f.id, f.status);
        }
        this._decisions.set(p.id, m);
      }
    }
    this._render();
  }
  get proposals(): KbFactProposal[] { return this._proposals; }

  set kb(v: UserKnowledgeBase | null) { this._kb = v; this._render(); }
  get kb(): UserKnowledgeBase | null { return this._kb; }

  set loading(v: boolean) { this._loading = v; this._render(); }
  get loading(): boolean { return this._loading; }

  connectedCallback() { this._render(); }

  private _emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true }));
  }

  private _decide(proposalId: string, factId: string, decision: "approved" | "rejected") {
    let m = this._decisions.get(proposalId);
    if (!m) { m = new Map(); this._decisions.set(proposalId, m); }
    if (m.get(factId) === decision) { m.delete(factId); } else { m.set(factId, decision); }
    this._render();
  }

  private _submitProposal(proposalId: string, proposal: KbFactProposal) {
    const m = this._decisions.get(proposalId) ?? new Map<string, "approved" | "rejected">();
    const approvedFactIds: string[] = [];
    const rejectedFactIds: string[] = [];
    for (const f of proposal.facts) {
      const d = m.get(f.id);
      if (d === "approved") approvedFactIds.push(f.id);
      else if (d === "rejected") rejectedFactIds.push(f.id);
    }
    this._emit<KbApplyDetail>("cbl-kb-apply", { proposalId, approvedFactIds, rejectedFactIds });
  }

  private _approveAll(proposalId: string, proposal: KbFactProposal) {
    let m = this._decisions.get(proposalId);
    if (!m) { m = new Map(); this._decisions.set(proposalId, m); }
    for (const f of proposal.facts) { if (f.status === "pending") m.set(f.id, "approved"); }
    this._render();
  }

  private _render() {
    this.innerHTML = "";

    if (this._loading) {
      const s = document.createElement("div");
      s.className = "kb-loading";
      s.textContent = "Loading proposals…";
      this.appendChild(s);
      return;
    }

    const pending = this._proposals.filter((p) => p.facts.some((f) => f.status === "pending"));

    if (pending.length === 0) {
      const empty = document.createElement("div");
      empty.className = "kb-empty";
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p>No pending knowledge base proposals.</p>`;
      this.appendChild(empty);
      return;
    }

    const connections = computeConnections(pending, this._kb);

    // Summary bar
    const totalFacts = pending.reduce((n, p) => n + p.facts.filter((f) => f.status === "pending").length, 0);
    const dupCount = [...connections.values()].reduce((n, fm) =>
      n + [...fm.values()].filter((cs) => cs.some((c) => c.type === "duplicate")).length, 0);
    const linkCount = [...connections.values()].reduce((n, fm) =>
      n + [...fm.values()].filter((cs) => cs.some((c) => c.type === "existing")).length, 0);

    const summary = document.createElement("div");
    summary.className = "kb-summary-bar";
    summary.innerHTML = `
      <span class="kb-summary-count">${pending.length} proposal${pending.length !== 1 ? "s" : ""}</span>
      <span class="kb-summary-sep">·</span>
      <span class="kb-summary-count">${totalFacts} fact${totalFacts !== 1 ? "s" : ""}</span>
      ${dupCount > 0 ? `<span class="kb-summary-sep">·</span><span class="kb-badge kb-badge--dup" title="Facts proposed by multiple workers">${dupCount} duplicate${dupCount !== 1 ? "s" : ""}</span>` : ""}
      ${linkCount > 0 ? `<span class="kb-summary-sep">·</span><span class="kb-badge kb-badge--link" title="Facts that update existing KB entries">${linkCount} linked</span>` : ""}
    `;
    this.appendChild(summary);

    // Filter bar
    const workers = [...new Set(pending.map((p) => p.source_worker))].sort();
    const kinds = [...new Set(pending.flatMap((p) => p.facts.map((f) => f.kind)))].sort() as KbFactKind[];

    if (workers.length > 1 || kinds.length > 1) {
      const filterBar = document.createElement("div");
      filterBar.className = "kb-filter-bar";

      const allBtn = document.createElement("button");
      allBtn.className = `kb-filter-btn${this._filter === "all" ? " active" : ""}`;
      allBtn.textContent = "All";
      allBtn.addEventListener("click", () => { this._filter = "all"; this._render(); });
      filterBar.appendChild(allBtn);

      for (const w of workers) {
        const btn = document.createElement("button");
        btn.className = `kb-filter-btn kb-filter-btn--worker${this._filter === w ? " active" : ""}`;
        btn.textContent = w;
        btn.addEventListener("click", () => { this._filter = w; this._render(); });
        filterBar.appendChild(btn);
      }

      for (const k of kinds) {
        const btn = document.createElement("button");
        btn.className = `kb-filter-btn kb-filter-btn--kind${this._filter === k ? " active" : ""}`;
        btn.innerHTML = `${KIND_ICON[k] ?? "•"} ${KIND_LABEL[k] ?? k}`;
        btn.addEventListener("click", () => { this._filter = k; this._render(); });
        filterBar.appendChild(btn);
      }

      this.appendChild(filterBar);
    }

    // Proposal cards
    for (const proposal of pending) {
      const visibleFacts = proposal.facts.filter((f) => {
        if (f.status !== "pending") return false;
        if (this._filter === "all") return true;
        if (this._filter === proposal.source_worker) return true;
        if (this._filter === f.kind) return true;
        return false;
      });
      if (visibleFacts.length === 0) continue;
      this.appendChild(this._buildProposalCard(proposal, visibleFacts, connections.get(proposal.id) ?? new Map()));
    }
  }

  private _buildProposalCard(
    proposal: KbFactProposal,
    visibleFacts: KbFact[],
    factConnections: Map<string, FactConnection[]>
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = "kb-proposal-card";

    const header = document.createElement("div");
    header.className = "kb-proposal-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "kb-proposal-title-wrap";
    const title = document.createElement("div");
    title.className = "kb-proposal-title";
    title.textContent = proposal.source_event_title || "Untitled event";
    const meta = document.createElement("div");
    meta.className = "kb-proposal-meta";
    const date = new Date(proposal.created_at);
    meta.textContent = `${proposal.source_worker} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    titleWrap.append(title, meta);

    const headerActions = document.createElement("div");
    headerActions.className = "kb-proposal-header-actions";
    const approveAllBtn = document.createElement("button");
    approveAllBtn.className = "kb-btn kb-btn--approve-all";
    approveAllBtn.textContent = "Approve all";
    approveAllBtn.addEventListener("click", () => this._approveAll(proposal.id, proposal));
    headerActions.appendChild(approveAllBtn);
    header.append(titleWrap, headerActions);

    const factsList = document.createElement("div");
    factsList.className = "kb-facts-list";
    const decisions = this._decisions.get(proposal.id) ?? new Map<string, "approved" | "rejected">();
    for (const fact of visibleFacts) {
      factsList.appendChild(this._buildFactRow(proposal.id, fact, decisions.get(fact.id), factConnections.get(fact.id) ?? []));
    }

    const footer = document.createElement("div");
    footer.className = "kb-proposal-footer";
    const submitBtn = document.createElement("button");
    submitBtn.className = "kb-btn kb-btn--submit";
    const decidedCount = [...decisions.values()].filter(Boolean).length;
    const pendingCount = proposal.facts.filter((f) => f.status === "pending").length;
    submitBtn.textContent = `Apply (${decidedCount}/${pendingCount} decided)`;
    submitBtn.disabled = decidedCount === 0;
    submitBtn.addEventListener("click", () => this._submitProposal(proposal.id, proposal));
    footer.appendChild(submitBtn);

    card.append(header, factsList, footer);
    return card;
  }

  private _buildFactRow(
    proposalId: string,
    fact: KbFact,
    decision: "approved" | "rejected" | undefined,
    connections: FactConnection[]
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = `kb-fact-row${decision ? ` kb-fact-row--${decision}` : ""}`;

    const badge = document.createElement("span");
    badge.className = "kb-fact-kind";
    badge.title = KIND_LABEL[fact.kind] ?? fact.kind;
    badge.textContent = KIND_ICON[fact.kind] ?? "•";

    const valueWrap = document.createElement("div");
    valueWrap.className = "kb-fact-value-wrap";

    const valueEl = document.createElement("div");
    valueEl.className = "kb-fact-value";
    const formatted = formatValue(fact);
    if (formatted.includes("\n")) {
      const pre = document.createElement("pre");
      pre.textContent = formatted;
      valueEl.appendChild(pre);
    } else {
      valueEl.textContent = formatted;
    }
    valueWrap.appendChild(valueEl);

    if (connections.length > 0) {
      const connBadges = document.createElement("div");
      connBadges.className = "kb-fact-connections";
      for (const conn of connections) {
        const b = document.createElement("span");
        b.className = `kb-conn-badge kb-conn-badge--${conn.type}`;
        b.title = conn.label;
        b.textContent = conn.type === "existing" ? "↗ updates KB" : "⚠ duplicate";
        connBadges.appendChild(b);
      }
      valueWrap.appendChild(connBadges);
    }

    const conf = document.createElement("span");
    conf.className = `kb-confidence ${confidenceClass(fact.confidence)}`;
    conf.title = fact.rationale;
    conf.textContent = `${Math.round(fact.confidence * 100)}%`;

    const btns = document.createElement("div");
    btns.className = "kb-fact-btns";

    const approveBtn = document.createElement("button");
    approveBtn.className = `kb-fact-btn kb-fact-btn--approve${decision === "approved" ? " active" : ""}`;
    approveBtn.title = "Approve";
    approveBtn.setAttribute("aria-label", "Approve fact");
    approveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    approveBtn.addEventListener("click", () => this._decide(proposalId, fact.id, "approved"));

    const rejectBtn = document.createElement("button");
    rejectBtn.className = `kb-fact-btn kb-fact-btn--reject${decision === "rejected" ? " active" : ""}`;
    rejectBtn.title = "Reject";
    rejectBtn.setAttribute("aria-label", "Reject fact");
    rejectBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    rejectBtn.addEventListener("click", () => this._decide(proposalId, fact.id, "rejected"));

    btns.append(approveBtn, rejectBtn);
    row.append(badge, valueWrap, conf, btns);
    return row;
  }
}

customElements.define("cbl-kb-panel", CblKbPanel);
