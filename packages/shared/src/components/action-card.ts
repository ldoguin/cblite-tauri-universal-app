import type { ActionItem } from "../types.js";

// ── Event detail types ────────────────────────────────────────────────────────

export interface ActionApproveDetail { item: ActionItem; }
export interface ActionRejectDetail  { item: ActionItem; }
export interface ActionEditDetail    { item: ActionItem; }

// ── Action type icon/label registry ──────────────────────────────────────────

const ACTION_TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
  email:              { icon: "✉",  label: "Email",         color: "#3b82f6" },
  email_reply:        { icon: "↩",  label: "Reply",         color: "#3b82f6" },
  calendar_event:     { icon: "📅", label: "Calendar",      color: "#8b5cf6" },
  schedule_meeting:   { icon: "📅", label: "Schedule",      color: "#8b5cf6" },
  webhook:            { icon: "⚡", label: "Webhook",       color: "#f59e0b" },
  sms:                { icon: "💬", label: "SMS",           color: "#10b981" },
  notification:       { icon: "🔔", label: "Notify",        color: "#ec4899" },
  follow_up:          { icon: "🔁", label: "Follow-up",     color: "#f97316" },
  review_document:    { icon: "📄", label: "Review",        color: "#6366f1" },
  review_code:        { icon: "🔍", label: "Code Review",   color: "#6366f1" },
  resolve_issue:      { icon: "🐛", label: "Resolve",       color: "#ef4444" },
  approve_request:    { icon: "✅", label: "Approve",       color: "#22c55e" },
  make_payment:       { icon: "💳", label: "Payment",       color: "#14b8a6" },
  meeting_booked:     { icon: "📅", label: "Meeting",       color: "#8b5cf6" },
  meeting_cancelled:  { icon: "❌", label: "Cancelled",     color: "#ef4444" },
  meeting_rescheduled:{ icon: "🔄", label: "Rescheduled",   color: "#f59e0b" },
  loom_response:      { icon: "🎥", label: "Record Loom",   color: "#625df5" },
};

function getTypeMeta(actionType: string) {
  return ACTION_TYPE_META[actionType] ?? { icon: "⚙", label: actionType, color: "#6b7280" };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS_LABEL: Record<string, string> = {
  pending:  "Pending",
  approved: "Approved",
  rejected: "Rejected",
  modified: "Modified",
};

/**
 * <cbl-action-card> — displays a single action item with swipe/keyboard controls.
 *
 * Properties: item, focused
 * Emits: cbl-action-approve, cbl-action-reject, cbl-action-edit
 */
export class CblActionCard extends HTMLElement {
  private _item: ActionItem | null = null;
  private _touchStartX = 0;
  private _touchStartY = 0;
  private _swiping = false;

  set item(v: ActionItem) { this._item = v; this._render(); }
  get item(): ActionItem | null { return this._item; }

  set focused(v: boolean) {
    this.classList.toggle("focused", v);
    if (v) this.setAttribute("tabindex", "0");
  }

  connectedCallback() {
    this.setAttribute("role", "article");
    this.setAttribute("tabindex", "0");
    this._bindEvents();
  }

  private _emit<T>(name: string, detail: T) {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true }));
  }

  private _bindEvents() {
    // Touch swipe
    this.addEventListener("touchstart", (e) => {
      this._touchStartX = e.touches[0].clientX;
      this._touchStartY = e.touches[0].clientY;
      this._swiping = false;
    }, { passive: true });

    this.addEventListener("touchmove", (e) => {
      const dx = e.touches[0].clientX - this._touchStartX;
      const dy = e.touches[0].clientY - this._touchStartY;
      if (!this._swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
        this._swiping = true;
      }
      if (this._swiping) {
        (this as HTMLElement).style.transform = `translateX(${dx}px)`;
        (this as HTMLElement).style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 200));
      }
    }, { passive: true });

    this.addEventListener("touchend", (e) => {
      const dx = e.changedTouches[0].clientX - this._touchStartX;
      (this as HTMLElement).style.transform = "";
      (this as HTMLElement).style.opacity = "";
      if (!this._swiping || !this._item) return;
      if (dx > 80)       this._emit<ActionApproveDetail>("cbl-action-approve", { item: this._item });
      else if (dx < -80) this._emit<ActionEditDetail>("cbl-action-edit", { item: this._item });
    });

    // Keyboard
    this.addEventListener("keydown", (e) => {
      if (!this._item) return;
      if (e.key === "ArrowRight" || e.key === "a" || e.key === "A") {
        e.preventDefault();
        this._animateOut("right");
        this._emit<ActionApproveDetail>("cbl-action-approve", { item: this._item });
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        this._animateOut("left");
        this._emit<ActionRejectDetail>("cbl-action-reject", { item: this._item });
      } else if (e.key === "ArrowLeft" || e.key === "e" || e.key === "E") {
        e.preventDefault();
        this._emit<ActionEditDetail>("cbl-action-edit", { item: this._item });
      }
    });
  }

  private _buildLoomUrl(item: ActionItem): string {
    // Use suggested_title from raw_payload if the LLM provided one, otherwise
    // derive from the action title. Loom's /new page accepts a `name` query param.
    const payload = item.raw_payload as Record<string, unknown> | undefined;
    const suggestedTitle =
      (payload?.["suggested_title"] as string | undefined) ??
      item.title.replace(/^Record a Loom for:\s*/i, "").slice(0, 100);
    const params = new URLSearchParams({ name: suggestedTitle });
    return `https://www.loom.com/new?${params.toString()}`;
  }

  _animateOut(direction: "left" | "right") {
    const tx = direction === "right" ? "120%" : "-120%";
    this.style.transition = "transform 0.25s ease, opacity 0.25s ease";
    this.style.transform = `translateX(${tx})`;
    this.style.opacity = "0";
  }

  private _render() {
    const item = this._item;
    if (!item) { this.innerHTML = ""; return; }

    const meta = getTypeMeta(item.action_type);
    const isSettled = item.status !== "pending";
    const bodyPreview = item.body.length > 200 ? item.body.slice(0, 200) + "…" : item.body;

    this.className = `action-card action-card--${item.status}`;
    this.innerHTML = "";

    // ── Swipe hint strip (left = edit, right = approve)
    const hintLeft = document.createElement("div");
    hintLeft.className = "action-card-hint action-card-hint--left";
    hintLeft.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>Edit</span>`;

    const hintRight = document.createElement("div");
    hintRight.className = "action-card-hint action-card-hint--right";
    hintRight.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg><span>Approve</span>`;

    // ── Card inner
    const inner = document.createElement("div");
    inner.className = "action-card-inner";

    // Header row: type badge + date + status
    const header = document.createElement("div");
    header.className = "action-card-header";

    const badge = document.createElement("span");
    badge.className = "action-type-badge";
    badge.style.setProperty("--badge-color", meta.color);
    badge.innerHTML = `<span class="action-type-icon" aria-hidden="true">${meta.icon}</span><span>${meta.label}</span>`;

    const right = document.createElement("div");
    right.className = "action-card-header-right";

    if (item.scheduled_date) {
      const dateEl = document.createElement("span");
      dateEl.className = "action-card-date" + (item.scheduled_date < todayISO() ? " overdue" : "");
      dateEl.textContent = formatDate(item.scheduled_date);
      right.appendChild(dateEl);
    }

    const statusBadge = document.createElement("span");
    statusBadge.className = `action-status-badge action-status-badge--${item.status}`;
    statusBadge.textContent = STATUS_LABEL[item.status] ?? item.status;
    right.appendChild(statusBadge);

    header.append(badge, right);

    // Title
    const title = document.createElement("div");
    title.className = "action-card-title";
    title.textContent = item.title;

    // Body preview
    const body = document.createElement("div");
    body.className = "action-card-body";
    body.textContent = bodyPreview;

    // Feedback note (if modified)
    let feedbackEl: HTMLElement | null = null;
    if (item.feedback) {
      feedbackEl = document.createElement("div");
      feedbackEl.className = "action-card-feedback";
      feedbackEl.innerHTML = `<span class="action-card-feedback-label">Your note:</span> ${item.feedback}`;
    }

    // Action buttons (always visible on desktop)
    const actions = document.createElement("div");
    actions.className = "action-card-actions";

    // ── Loom CTA (shown for loom_response regardless of settled state)
    if (item.action_type === "loom_response") {
      const loomUrl = this._buildLoomUrl(item);
      const loomBtn = document.createElement("a");
      loomBtn.className = "action-btn action-btn--loom";
      loomBtn.href = loomUrl;
      loomBtn.target = "_blank";
      loomBtn.rel = "noopener noreferrer";
      loomBtn.setAttribute("aria-label", "Record a Loom video");
      loomBtn.title = "Open Loom to record a response";
      loomBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg><span>Record Loom</span>`;
      loomBtn.addEventListener("click", (e) => e.stopPropagation());
      actions.appendChild(loomBtn);
    }

    if (!isSettled) {
      const approveBtn = document.createElement("button");
      approveBtn.className = "action-btn action-btn--approve";
      approveBtn.title = "Approve (→ or A)";
      approveBtn.setAttribute("aria-label", "Approve");
      approveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
      approveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._animateOut("right");
        this._emit<ActionApproveDetail>("cbl-action-approve", { item: item! });
      });

      const editBtn = document.createElement("button");
      editBtn.className = "action-btn action-btn--edit";
      editBtn.title = "Edit (← or E)";
      editBtn.setAttribute("aria-label", "Edit");
      editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._emit<ActionEditDetail>("cbl-action-edit", { item: item! });
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.className = "action-btn action-btn--reject";
      rejectBtn.title = "Reject (R)";
      rejectBtn.setAttribute("aria-label", "Reject");
      rejectBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      rejectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._animateOut("left");
        this._emit<ActionRejectDetail>("cbl-action-reject", { item: item! });
      });

      actions.append(approveBtn, editBtn, rejectBtn);
    }

    inner.append(header, title, body);
    if (feedbackEl) inner.appendChild(feedbackEl);
    if (actions.children.length) inner.appendChild(actions);

    this.append(hintLeft, inner, hintRight);
  }
}

customElements.define("cbl-action-card", CblActionCard);
