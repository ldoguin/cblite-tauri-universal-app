import type { ActionItem } from "../types.js";

// ── Event detail types ────────────────────────────────────────────────────────

export interface ActionSaveDetail {
  item: ActionItem;
  /** Updated title from the edit form. */
  title: string;
  /** Updated body from the edit form or AI re-prompt. */
  body: string;
  /** Free-text feedback note to send to the agent. */
  feedback: string;
}

export interface ActionCloseDetail { }

/**
 * <cbl-action-drawer> — slide-in drawer for editing an action item.
 *
 * Properties: item, getAIReply
 * Emits: cbl-action-save, cbl-action-close
 */
export class CblActionDrawer extends HTMLElement {
  private _item: ActionItem | null = null;
  private _titleInput: HTMLInputElement | null = null;
  private _bodyInput: HTMLTextAreaElement | null = null;
  private _feedbackInput: HTMLTextAreaElement | null = null;
  private _repromptInput: HTMLInputElement | null = null;
  private _repromptStatus: HTMLElement | null = null;

  /** Injected by app.ts — calls the AI endpoint with a prompt and returns the reply. */
  getAIReply: ((prompt: string) => Promise<string>) | null = null;

  set item(v: ActionItem | null) {
    this._item = v;
    if (v) {
      this._render();
      this._open();
    } else {
      this._close();
    }
  }

  connectedCallback() {
    this.className = "action-drawer";
    this.setAttribute("role", "dialog");
    this.setAttribute("aria-modal", "true");
    this.setAttribute("aria-label", "Edit action");
    this.hidden = true;
  }

  private _emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true }));
  }

  private _open() {
    this.hidden = false;
    requestAnimationFrame(() => this.classList.add("open"));
    this._titleInput?.focus();
  }

  private _close() {
    this.classList.remove("open");
    setTimeout(() => { this.hidden = true; }, 250);
    this._emit<ActionCloseDetail>("cbl-action-close", {});
  }

  private _render() {
    const item = this._item!;
    this.innerHTML = "";

    // ── Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "action-drawer-backdrop";
    backdrop.addEventListener("click", () => this._close());

    // ── Panel
    const panel = document.createElement("div");
    panel.className = "action-drawer-panel";

    // Header
    const header = document.createElement("div");
    header.className = "action-drawer-header";

    const heading = document.createElement("h2");
    heading.className = "action-drawer-heading";
    heading.textContent = "Edit action";

    const closeBtn = document.createElement("button");
    closeBtn.className = "action-drawer-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    closeBtn.addEventListener("click", () => this._close());

    header.append(heading, closeBtn);

    // ── Edit form
    const form = document.createElement("div");
    form.className = "action-drawer-form";

    // Title field
    const titleGroup = this._mkField("Title");
    this._titleInput = document.createElement("input");
    this._titleInput.className = "action-drawer-input";
    this._titleInput.type = "text";
    this._titleInput.value = item.title;
    titleGroup.appendChild(this._titleInput);

    // Body field
    const bodyGroup = this._mkField("Body");
    this._bodyInput = document.createElement("textarea");
    this._bodyInput.className = "action-drawer-textarea";
    this._bodyInput.rows = 6;
    this._bodyInput.value = item.body;
    bodyGroup.appendChild(this._bodyInput);

    // Feedback field
    const feedbackGroup = this._mkField("Feedback note for agent");
    this._feedbackInput = document.createElement("textarea");
    this._feedbackInput.className = "action-drawer-textarea";
    this._feedbackInput.rows = 3;
    this._feedbackInput.placeholder = "Explain what you want changed…";
    this._feedbackInput.value = item.feedback ?? "";
    feedbackGroup.appendChild(this._feedbackInput);

    // Raw payload (read-only)
    const payloadGroup = this._mkField("Raw payload (read-only)");
    const payloadEl = document.createElement("pre");
    payloadEl.className = "action-drawer-payload";
    payloadEl.textContent = JSON.stringify(item.raw_payload, null, 2);
    payloadGroup.appendChild(payloadEl);

    form.append(titleGroup, bodyGroup, feedbackGroup, payloadGroup);

    // ── AI re-prompt section
    const repromptSection = document.createElement("div");
    repromptSection.className = "action-drawer-reprompt";

    const repromptLabel = document.createElement("div");
    repromptLabel.className = "action-drawer-section-label";
    repromptLabel.textContent = "AI re-prompt";

    const repromptDesc = document.createElement("p");
    repromptDesc.className = "action-drawer-reprompt-desc";
    repromptDesc.textContent = "Ask the AI to rewrite the body based on your instruction. The result replaces the body above.";

    const repromptRow = document.createElement("div");
    repromptRow.className = "action-drawer-reprompt-row";

    this._repromptInput = document.createElement("input");
    this._repromptInput.className = "action-drawer-input";
    this._repromptInput.type = "text";
    this._repromptInput.placeholder = "e.g. Make it more formal and shorter";

    const repromptBtn = document.createElement("button");
    repromptBtn.className = "btn-secondary action-drawer-reprompt-btn";
    repromptBtn.textContent = "Rewrite";

    this._repromptStatus = document.createElement("span");
    this._repromptStatus.className = "action-drawer-reprompt-status";

    repromptBtn.addEventListener("click", () => this._doReprompt(item));
    this._repromptInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._doReprompt(item); }
    });

    repromptRow.append(this._repromptInput, repromptBtn);
    repromptSection.append(repromptLabel, repromptDesc, repromptRow, this._repromptStatus);

    // ── Footer
    const footer = document.createElement("div");
    footer.className = "action-drawer-footer";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save & notify agent";
    saveBtn.addEventListener("click", () => this._doSave());

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this._close());

    footer.append(saveBtn, cancelBtn);

    panel.append(header, form, repromptSection, footer);
    this.append(backdrop, panel);

    // Keyboard: Escape closes
    this.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._close();
    });
  }

  private _mkField(labelText: string): HTMLElement {
    const group = document.createElement("div");
    group.className = "action-drawer-field";
    const label = document.createElement("label");
    label.className = "action-drawer-label";
    label.textContent = labelText;
    group.appendChild(label);
    return group;
  }

  private async _doReprompt(item: ActionItem) {
    if (!this.getAIReply || !this._repromptInput || !this._bodyInput) return;
    const instruction = this._repromptInput.value.trim();
    if (!instruction) return;

    const prompt = `You are editing an action item of type "${item.action_type}".\n\nCurrent body:\n${this._bodyInput.value}\n\nInstruction: ${instruction}\n\nRewrite the body following the instruction. Return only the rewritten body text, nothing else.`;

    if (this._repromptStatus) {
      this._repromptStatus.textContent = "Rewriting…";
      this._repromptStatus.className = "action-drawer-reprompt-status loading";
    }

    try {
      const result = await this.getAIReply(prompt);
      this._bodyInput.value = result.trim();
      if (this._repromptStatus) {
        this._repromptStatus.textContent = "Body updated.";
        this._repromptStatus.className = "action-drawer-reprompt-status success";
        setTimeout(() => { if (this._repromptStatus) this._repromptStatus.textContent = ""; }, 3000);
      }
      this._repromptInput.value = "";
    } catch (err) {
      if (this._repromptStatus) {
        this._repromptStatus.textContent = "AI request failed.";
        this._repromptStatus.className = "action-drawer-reprompt-status error";
      }
    }
  }

  private _doSave() {
    if (!this._item) return;
    this._emit<ActionSaveDetail>("cbl-action-save", {
      item: this._item,
      title: this._titleInput?.value.trim() || this._item.title,
      body: this._bodyInput?.value ?? this._item.body,
      feedback: this._feedbackInput?.value.trim() ?? "",
    });
    this._close();
  }
}

customElements.define("cbl-action-drawer", CblActionDrawer);
