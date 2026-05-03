import type { UserKnowledgeBase, KbContact, KbProject, KbFact } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sectionEl(title: string, icon: string, content: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.className = "kbb-section";

  const heading = document.createElement("h3");
  heading.className = "kbb-section-heading";
  heading.innerHTML = `<span class="kbb-section-icon" aria-hidden="true">${icon}</span>${esc(title)}`;
  section.append(heading, content);
  return section;
}

function emptyChip(text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "kbb-empty-hint";
  el.textContent = text;
  return el;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * <cbl-kb-browser> — read-only browser for the approved user knowledge base.
 *
 * Sections: Identity · Projects · Contacts · Preferences · Instructions · Facts
 *
 * Properties: kb (UserKnowledgeBase | null), loading (boolean)
 */
export class CblKbBrowser extends HTMLElement {
  private _kb: UserKnowledgeBase | null = null;
  private _loading = false;
  private _activeSection = "identity";

  set kb(v: UserKnowledgeBase | null) { this._kb = v; this._render(); }
  get kb(): UserKnowledgeBase | null { return this._kb; }

  set loading(v: boolean) { this._loading = v; this._render(); }
  get loading(): boolean { return this._loading; }

  connectedCallback() { this._render(); }

  private _render() {
    this.innerHTML = "";

    if (this._loading) {
      const s = document.createElement("div");
      s.className = "kbb-loading";
      s.textContent = "Loading knowledge base…";
      this.appendChild(s);
      return;
    }

    if (!this._kb) {
      const empty = document.createElement("div");
      empty.className = "kbb-empty";
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
        </svg>
        <p>No knowledge base yet. Approve some proposals to build it.</p>`;
      this.appendChild(empty);
      return;
    }

    const kb = this._kb;

    // ── Tab bar ──────────────────────────────────────────────────────────────
    const tabs = document.createElement("nav");
    tabs.className = "kbb-tabs";
    const TABS: Array<{ id: string; label: string; icon: string }> = [
      { id: "identity",     label: "Identity",      icon: "🪪" },
      { id: "projects",     label: "Projects",      icon: "📁" },
      { id: "contacts",     label: "Contacts",      icon: "👥" },
      { id: "preferences",  label: "Preferences",   icon: "⚙️" },
      { id: "instructions", label: "Instructions",  icon: "💡" },
      { id: "facts",        label: "Facts",         icon: "🔍" },
    ];
    for (const t of TABS) {
      const btn = document.createElement("button");
      btn.className = `kbb-tab${this._activeSection === t.id ? " active" : ""}`;
      btn.dataset.section = t.id;
      btn.innerHTML = `<span aria-hidden="true">${t.icon}</span><span>${esc(t.label)}</span>`;
      btn.addEventListener("click", () => {
        this._activeSection = t.id;
        this._render();
      });
      tabs.appendChild(btn);
    }
    this.appendChild(tabs);

    // ── Section content ──────────────────────────────────────────────────────
    const body = document.createElement("div");
    body.className = "kbb-body";

    switch (this._activeSection) {
      case "identity":    body.appendChild(this._renderIdentity(kb)); break;
      case "projects":    body.appendChild(this._renderProjects(kb.projects ?? [])); break;
      case "contacts":    body.appendChild(this._renderContacts(kb.contacts ?? [])); break;
      case "preferences": body.appendChild(this._renderPreferences(kb)); break;
      case "instructions":body.appendChild(this._renderInstructions(kb)); break;
      case "facts":       body.appendChild(this._renderFacts(kb.facts ?? [])); break;
    }

    this.appendChild(body);
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  private _renderIdentity(kb: UserKnowledgeBase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-identity";

    const fields: Array<{ label: string; value: string | undefined }> = [
      { label: "Display name", value: kb.displayName },
      { label: "Role",         value: kb.role },
      { label: "Timezone",     value: kb.timezone },
      { label: "Language",     value: kb.language },
    ];

    for (const { label, value } of fields) {
      const row = document.createElement("div");
      row.className = "kbb-field-row";
      const lbl = document.createElement("span");
      lbl.className = "kbb-field-label";
      lbl.textContent = label;
      const val = document.createElement("span");
      val.className = `kbb-field-value${value ? "" : " kbb-field-value--empty"}`;
      val.textContent = value ?? "—";
      row.append(lbl, val);
      wrap.appendChild(row);
    }

    if (kb.updated_at) {
      const ts = document.createElement("p");
      ts.className = "kbb-updated-at";
      ts.textContent = `Last updated ${new Date(kb.updated_at).toLocaleString()}`;
      wrap.appendChild(ts);
    }

    return wrap;
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  private _renderProjects(projects: KbProject[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-list";

    if (projects.length === 0) {
      wrap.appendChild(emptyChip("No projects yet"));
      return wrap;
    }

    for (const p of projects) {
      const card = document.createElement("div");
      card.className = "kbb-card";

      const name = document.createElement("div");
      name.className = "kbb-card-title";
      name.textContent = p.name;

      card.appendChild(name);

      if (p.description) {
        const desc = document.createElement("p");
        desc.className = "kbb-card-desc";
        desc.textContent = p.description;
        card.appendChild(desc);
      }

      if (p.keywords?.length) {
        const kw = document.createElement("div");
        kw.className = "kbb-chips";
        for (const k of p.keywords) {
          const chip = document.createElement("span");
          chip.className = "kbb-chip";
          chip.textContent = k;
          kw.appendChild(chip);
        }
        card.appendChild(kw);
      }

      wrap.appendChild(card);
    }

    return wrap;
  }

  // ── Contacts ────────────────────────────────────────────────────────────────

  private _renderContacts(contacts: KbContact[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-list";

    if (contacts.length === 0) {
      wrap.appendChild(emptyChip("No contacts yet"));
      return wrap;
    }

    // Group by relationship
    const groups = new Map<string, KbContact[]>();
    for (const c of contacts) {
      const rel = c.relationship ?? "other";
      if (!groups.has(rel)) groups.set(rel, []);
      groups.get(rel)!.push(c);
    }

    for (const [rel, members] of groups) {
      const group = document.createElement("div");
      group.className = "kbb-contact-group";

      const groupLabel = document.createElement("div");
      groupLabel.className = "kbb-contact-group-label";
      groupLabel.textContent = rel.replace(/_/g, " ");
      group.appendChild(groupLabel);

      for (const c of members) {
        const card = document.createElement("div");
        card.className = "kbb-card kbb-card--contact";

        const avatar = document.createElement("div");
        avatar.className = "kbb-contact-avatar";
        avatar.textContent = (c.name[0] ?? "?").toUpperCase();

        const info = document.createElement("div");
        info.className = "kbb-contact-info";

        const name = document.createElement("div");
        name.className = "kbb-card-title";
        name.textContent = c.name;
        info.appendChild(name);

        if (c.notes) {
          const notes = document.createElement("p");
          notes.className = "kbb-card-desc";
          notes.textContent = c.notes;
          info.appendChild(notes);
        }

        card.append(avatar, info);
        group.appendChild(card);
      }

      wrap.appendChild(group);
    }

    return wrap;
  }

  // ── Preferences ─────────────────────────────────────────────────────────────

  private _renderPreferences(kb: UserKnowledgeBase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-preferences";

    const ignoreSection = sectionEl("Ignore patterns", "🚫", this._renderPatternList(kb.ignorePatterns ?? [], "ignore"));
    const prioritySection = sectionEl("Priority patterns", "⭐", this._renderPatternList(kb.priorityPatterns ?? [], "priority"));

    wrap.append(ignoreSection, prioritySection);
    return wrap;
  }

  private _renderPatternList(patterns: string[], kind: "ignore" | "priority"): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-pattern-list";

    if (patterns.length === 0) {
      wrap.appendChild(emptyChip("None"));
      return wrap;
    }

    for (const p of patterns) {
      const chip = document.createElement("span");
      chip.className = `kbb-chip kbb-chip--${kind}`;
      chip.textContent = p;
      wrap.appendChild(chip);
    }

    return wrap;
  }

  // ── Instructions ────────────────────────────────────────────────────────────

  private _renderInstructions(kb: UserKnowledgeBase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-instructions";

    if (!kb.customInstructions) {
      wrap.appendChild(emptyChip("No custom instructions yet"));
      return wrap;
    }

    const pre = document.createElement("pre");
    pre.className = "kbb-instructions-text";
    pre.textContent = kb.customInstructions;
    wrap.appendChild(pre);

    return wrap;
  }

  // ── Facts ───────────────────────────────────────────────────────────────────

  private _renderFacts(facts: KbFact[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "kbb-facts";

    if (facts.length === 0) {
      wrap.appendChild(emptyChip("No extracted facts yet"));
      return wrap;
    }

    // Group by kind
    const byKind = new Map<string, KbFact[]>();
    for (const f of facts) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, []);
      byKind.get(f.kind)!.push(f);
    }

    const KIND_LABEL: Record<string, string> = {
      contact: "Contacts", project: "Projects",
      ignore_pattern: "Ignore patterns", priority_pattern: "Priority patterns",
      custom_instruction: "Instructions",
    };

    for (const [kind, kindFacts] of byKind) {
      const group = document.createElement("div");
      group.className = "kbb-facts-group";

      const label = document.createElement("div");
      label.className = "kbb-facts-group-label";
      label.textContent = KIND_LABEL[kind] ?? kind;
      group.appendChild(label);

      for (const f of kindFacts) {
        const row = document.createElement("div");
        row.className = "kbb-fact-row";

        const val = document.createElement("div");
        val.className = "kbb-fact-val";
        const formatted = typeof f.value === "string"
          ? f.value
          : JSON.stringify(f.value, null, 2);
        if (formatted.includes("\n")) {
          const pre = document.createElement("pre");
          pre.textContent = formatted;
          val.appendChild(pre);
        } else {
          val.textContent = formatted;
        }

        const rationale = document.createElement("span");
        rationale.className = "kbb-fact-rationale";
        rationale.title = f.rationale;
        rationale.textContent = f.rationale;

        row.append(val, rationale);
        group.appendChild(row);
      }

      wrap.appendChild(group);
    }

    return wrap;
  }
}

customElements.define("cbl-kb-browser", CblKbBrowser);
