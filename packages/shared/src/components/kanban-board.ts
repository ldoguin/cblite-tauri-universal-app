import type { Board, Column, Task } from "../types.js";

// ── Event detail types ────────────────────────────────────────────────────────

export interface TaskMoveDetail {
  taskId: string;
  fromColumnId: string;
  toColumnId: string;
  newPosition: number;
}

export interface TaskCreateDetail { columnId: string; title?: string; }
export interface TaskUpdateDetail { task: Task; }
export interface TaskDeleteDetail { taskId: string; boardId: string; }
export interface ColumnCreateDetail { boardId: string; }
export interface ColumnUpdateDetail { column: Column; }
export interface ColumnDeleteDetail { columnId: string; boardId: string; }

// ── Label color palette ───────────────────────────────────────────────────────

const LABEL_COLORS = [
  { bg: "#dbeafe", text: "#1d4ed8" },
  { bg: "#dcfce7", text: "#15803d" },
  { bg: "#fef9c3", text: "#a16207" },
  { bg: "#fee2e2", text: "#b91c1c" },
  { bg: "#f3e8ff", text: "#7e22ce" },
  { bg: "#ffedd5", text: "#c2410c" },
  { bg: "#e0f2fe", text: "#0369a1" },
  { bg: "#fce7f3", text: "#be185d" },
];

function labelColor(label: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) & 0xffff;
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

function avatarInitials(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

/**
 * <cbl-kanban-board> — Kanban board with columns and draggable task cards.
 *
 * Properties: board, columns, tasks, currentUser
 * Emits (all bubble):
 *   cbl-task-move, cbl-task-create, cbl-task-update, cbl-task-delete,
 *   cbl-column-create, cbl-column-update, cbl-column-delete
 */
export class CblKanbanBoard extends HTMLElement {
  private _board: Board | null = null;
  private _columns: Column[] = [];
  private _tasks: Task[] = [];
  private _currentUser = "";

  /** Optional callback for user search — set by app.ts after mount. */
  userSearch: ((query: string) => Promise<string[]>) | null = null;

  // drag state
  private _dragTaskId: string | null = null;
  private _dragFromColId: string | null = null;
  private _dropIndicator: HTMLElement | null = null;

  set board(v: Board | null) { this._board = v; this._render(); }
  set columns(v: Column[]) { this._columns = v; this._render(); }
  set tasks(v: Task[]) { this._tasks = v; this._render(); }
  set currentUser(v: string) { this._currentUser = v; }

  private _emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true }));
  }

  private _render(): void {
    if (!this._board) {
      this.innerHTML = `
        <div class="kanban-empty">
          <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="4" y="12" width="16" height="40" rx="3"/>
            <rect x="24" y="12" width="16" height="28" rx="3"/>
            <rect x="44" y="12" width="16" height="34" rx="3"/>
          </svg>
          <p>No board selected</p>
          <span>Create a new board or select one above</span>
        </div>`;
      return;
    }

    const orderMap = new Map(this._board.column_order.map((id, i) => [id, i]));
    const sorted = [...this._columns].sort((a, b) => {
      const ai = orderMap.has(a.id) ? orderMap.get(a.id)! : 9999 + a.position;
      const bi = orderMap.has(b.id) ? orderMap.get(b.id)! : 9999 + b.position;
      return ai - bi;
    });

    this.innerHTML = "";
    const strip = document.createElement("div");
    strip.className = "kanban-strip";

    for (const col of sorted) {
      strip.appendChild(this._renderColumn(col));
    }

    // Ghost "Add column" card — matches column width, dashed border
    const addColCard = document.createElement("div");
    addColCard.className = "kanban-add-col-card";
    addColCard.setAttribute("role", "button");
    addColCard.setAttribute("tabindex", "0");
    addColCard.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <span>Add column</span>`;
    addColCard.addEventListener("click", () =>
      this._emit<ColumnCreateDetail>("cbl-column-create", { boardId: this._board!.id })
    );
    addColCard.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addColCard.click(); }
    });
    strip.appendChild(addColCard);

    this.appendChild(strip);
  }

  private _renderColumn(col: Column): HTMLElement {
    const tasks = this._tasks
      .filter((t) => t.column_id === col.id)
      .sort((a, b) => a.position - b.position);

    const colEl = document.createElement("div");
    colEl.className = "kanban-col";
    colEl.dataset.colId = col.id;

    // ── Header
    const header = document.createElement("div");
    header.className = "kanban-col-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "kanban-col-title-wrap";

    const titleInput = document.createElement("input");
    titleInput.className = "kanban-col-title";
    titleInput.value = col.name;
    titleInput.setAttribute("aria-label", "Column name");
    const saveTitle = () => {
      const trimmed = titleInput.value.trim();
      if (trimmed && trimmed !== col.name) {
        this._emit<ColumnUpdateDetail>("cbl-column-update", { column: { ...col, name: trimmed } });
      } else {
        titleInput.value = col.name;
      }
    };
    titleInput.addEventListener("blur", saveTitle);
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      if (e.key === "Escape") { titleInput.value = col.name; titleInput.blur(); }
    });

    const count = document.createElement("span");
    count.className = "kanban-col-count";
    count.textContent = String(tasks.length);

    titleWrap.append(titleInput, count);

    const delColBtn = document.createElement("button");
    delColBtn.className = "kanban-col-del-btn";
    delColBtn.title = "Delete column";
    delColBtn.setAttribute("aria-label", "Delete column");
    delColBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delColBtn.addEventListener("click", () => this._confirmDeleteColumn(col));

    header.append(titleWrap, delColBtn);

    // ── Task list (drop zone)
    const list = document.createElement("div");
    list.className = "kanban-task-list";
    list.dataset.colId = col.id;

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      list.classList.add("drag-over");
      this._updateDropIndicator(e, list, tasks);
    });
    list.addEventListener("dragleave", (e) => {
      if (!list.contains(e.relatedTarget as Node)) {
        list.classList.remove("drag-over");
        this._removeDropIndicator();
      }
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      list.classList.remove("drag-over");
      this._removeDropIndicator();
      if (!this._dragTaskId || !this._dragFromColId) return;
      const newPosition = this._calcDropPosition(e, list, tasks);
      this._emit<TaskMoveDetail>("cbl-task-move", {
        taskId: this._dragTaskId,
        fromColumnId: this._dragFromColId,
        toColumnId: col.id,
        newPosition,
      });
      this._dragTaskId = null;
      this._dragFromColId = null;
    });

    for (const task of tasks) {
      list.appendChild(this._renderCard(task));
    }

    // ── Inline add card row
    const addRow = document.createElement("div");
    addRow.className = "kanban-add-card-row";
    const addBtn = document.createElement("button");
    addBtn.className = "kanban-add-card-btn";
    addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add card`;
    addBtn.addEventListener("click", () => this._showInlineAdd(col, list, addRow));
    addRow.appendChild(addBtn);

    colEl.append(header, list, addRow);
    return colEl;
  }

  // ── Inline add card ─────────────────────────────────────────────────────────

  private _showInlineAdd(col: Column, list: HTMLElement, addRow: HTMLElement): void {
    this.querySelectorAll(".kanban-inline-add").forEach((el) => el.remove());
    addRow.querySelector(".kanban-add-card-btn")!.setAttribute("hidden", "");

    const form = document.createElement("div");
    form.className = "kanban-inline-add";

    const input = document.createElement("textarea");
    input.className = "kanban-inline-input";
    input.placeholder = "Card title…";
    input.rows = 2;

    const btnRow = document.createElement("div");
    btnRow.className = "kanban-inline-btns";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-primary kanban-inline-confirm";
    confirmBtn.textContent = "Add card";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-inline-cancel";
    cancelBtn.setAttribute("aria-label", "Cancel");
    cancelBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    const cancel = () => {
      form.remove();
      addRow.querySelector(".kanban-add-card-btn")!.removeAttribute("hidden");
    };

    confirmBtn.addEventListener("click", () => {
      const title = input.value.trim();
      if (!title) { input.focus(); return; }
      this._emit<TaskCreateDetail>("cbl-task-create", { columnId: col.id, title } as TaskCreateDetail & { title: string });
      cancel();
    });
    cancelBtn.addEventListener("click", cancel);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmBtn.click(); }
      if (e.key === "Escape") cancel();
    });

    btnRow.append(confirmBtn, cancelBtn);
    form.append(input, btnRow);
    list.after(form);
    input.focus();
  }

  private _renderCard(task: Task): HTMLElement {
    const card = document.createElement("div");
    card.className = "kanban-card";
    card.draggable = true;
    card.dataset.taskId = task.id;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", task.title || "Untitled task");

    card.addEventListener("dragstart", (e) => {
      this._dragTaskId = task.id;
      this._dragFromColId = task.column_id;
      setTimeout(() => card.classList.add("dragging"), 0);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      this._removeDropIndicator();
    });

    // Click anywhere opens modal
    card.addEventListener("click", () => this._openCardModal(task));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._openCardModal(task); }
    });

    // Label color strips (Trello-style top bar per label)
    if (task.labels.length > 0) {
      const labelsEl = document.createElement("div");
      labelsEl.className = "kanban-card-labels";
      for (const label of task.labels) {
        const tag = document.createElement("span");
        tag.className = "kanban-label";
        const { bg, text } = labelColor(label);
        tag.style.setProperty("--label-bg", bg);
        tag.style.setProperty("--label-text", text);
        tag.textContent = label;
        labelsEl.appendChild(tag);
      }
      card.appendChild(labelsEl);
    }

    // Title
    const title = document.createElement("div");
    title.className = "kanban-card-title";
    title.textContent = task.title || "Untitled";
    card.appendChild(title);

    // Description preview (first line, truncated)
    if (task.description?.trim()) {
      const desc = document.createElement("div");
      desc.className = "kanban-card-desc";
      const preview = task.description.trim();
      desc.textContent = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
      card.appendChild(desc);
    }

    // Footer: due date + assignee avatar
    const hasFooter = task.due_date || task.assignee;
    if (hasFooter) {
      const footer = document.createElement("div");
      footer.className = "kanban-card-footer";

      if (task.due_date) {
        const d = new Date(task.due_date);
        const isOverdue = d < new Date();
        const dueEl = document.createElement("span");
        dueEl.className = "kanban-card-due" + (isOverdue ? " overdue" : "");
        dueEl.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" width="11" height="11"><rect x="1" y="2" width="14" height="13" rx="2"/><line x1="5" y1="1" x2="5" y2="4"/><line x1="11" y1="1" x2="11" y2="4"/><line x1="1" y1="7" x2="15" y2="7"/></svg> ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
        footer.appendChild(dueEl);
      }

      if (task.assignee) {
        const avatar = document.createElement("span");
        avatar.className = "kanban-card-avatar";
        avatar.title = task.assignee;
        avatar.setAttribute("aria-label", `Assigned to ${task.assignee}`);
        avatar.textContent = avatarInitials(task.assignee);
        footer.appendChild(avatar);
      }

      card.appendChild(footer);
    }

    return card;
  }

  // ── Drag helpers ─────────────────────────────────────────────────────────────

  private _calcDropPosition(e: DragEvent, list: HTMLElement, tasks: Task[]): number {
    const cards = Array.from(list.querySelectorAll<HTMLElement>(".kanban-card:not(.dragging)"));
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) return i;
    }
    return tasks.length;
  }

  private _updateDropIndicator(e: DragEvent, list: HTMLElement, tasks: Task[]): void {
    if (!this._dropIndicator) {
      this._dropIndicator = document.createElement("div");
      this._dropIndicator.className = "kanban-drop-indicator";
    }
    const pos = this._calcDropPosition(e, list, tasks);
    const cards = Array.from(list.querySelectorAll<HTMLElement>(".kanban-card:not(.dragging)"));
    if (pos < cards.length) {
      list.insertBefore(this._dropIndicator, cards[pos]);
    } else {
      list.appendChild(this._dropIndicator);
    }
  }

  private _removeDropIndicator(): void {
    this._dropIndicator?.remove();
  }

  // ── Delete column confirm (inline, no native dialog) ─────────────────────────

  private _confirmDeleteColumn(col: Column): void {
    const existing = this.querySelector<HTMLElement>(`[data-col-id="${col.id}"] .kanban-col-confirm`);
    if (existing) { existing.remove(); return; }
    const colEl = this.querySelector<HTMLElement>(`[data-col-id="${col.id}"]`);
    if (!colEl) return;

    const confirm = document.createElement("div");
    confirm.className = "kanban-col-confirm";

    const msg = document.createElement("span");
    msg.textContent = "Delete column and all its cards?";

    const yesBtn = document.createElement("button");
    yesBtn.className = "btn-danger";
    yesBtn.textContent = "Delete";
    yesBtn.addEventListener("click", () =>
      this._emit<ColumnDeleteDetail>("cbl-column-delete", { columnId: col.id, boardId: col.board_id })
    );

    const noBtn = document.createElement("button");
    noBtn.className = "btn-secondary";
    noBtn.textContent = "Cancel";
    noBtn.addEventListener("click", () => confirm.remove());

    confirm.append(msg, yesBtn, noBtn);
    colEl.appendChild(confirm);
  }

  // ── User autocomplete (assignee field in modal) ───────────────────────────

  private _attachUserAutocomplete(input: HTMLInputElement): void {
    if (!this.userSearch) return;
    const search = this.userSearch;

    const dropdown = document.createElement("div");
    dropdown.className = "invite-autocomplete kanban-assignee-ac";
    dropdown.hidden = true;
    // Insert right after the input inside its parent
    input.insertAdjacentElement("afterend", dropdown);

    let timer = 0;
    let activeIndex = -1;
    let results: string[] = [];

    const close = () => { dropdown.hidden = true; activeIndex = -1; results = []; };
    const pick  = (u: string) => { input.value = u; close(); input.focus(); };

    const highlight = (i: number) => {
      dropdown.querySelectorAll<HTMLElement>(".invite-autocomplete-item")
        .forEach((el, idx) => el.classList.toggle("active", idx === i));
    };

    const render = (usernames: string[]) => {
      results = usernames;
      activeIndex = -1;
      dropdown.innerHTML = "";
      if (!usernames.length) { close(); return; }
      for (const u of usernames) {
        const item = document.createElement("div");
        item.className = "invite-autocomplete-item";
        const av = document.createElement("span");
        av.className = "invite-autocomplete-avatar";
        av.textContent = u.slice(0, 2).toUpperCase();
        const nm = document.createElement("span");
        nm.textContent = u;
        item.append(av, nm);
        item.addEventListener("mousedown", (e) => { e.preventDefault(); pick(u); });
        dropdown.appendChild(item);
      }
      dropdown.hidden = false;
    };

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { close(); return; }
      timer = window.setTimeout(() => search(q).then(render), 200);
    });

    input.addEventListener("keydown", (e) => {
      if (dropdown.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, results.length - 1); highlight(activeIndex); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, -1); highlight(activeIndex); }
      else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); pick(results[activeIndex]); }
      else if (e.key === "Escape") close();
    });

    input.addEventListener("blur", () => setTimeout(close, 150));
  }

  private _openCardModal(task: Task): void {
    document.getElementById("kanban-card-modal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "kanban-card-modal";
    overlay.className = "kanban-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Edit task");

    const modal = document.createElement("div");
    modal.className = "kanban-modal";

    // ── Header: large title input + close button
    const modalHeader = document.createElement("div");
    modalHeader.className = "kanban-modal-header";

    const titleInput = document.createElement("input");
    titleInput.className = "kanban-modal-title-input";
    titleInput.type = "text";
    titleInput.value = task.title;
    titleInput.placeholder = "Task title";

    const closeBtn = document.createElement("button");
    closeBtn.className = "kanban-modal-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    closeBtn.addEventListener("click", () => overlay.remove());

    modalHeader.append(titleInput, closeBtn);

    // ── Body: two-column layout (description left, metadata right)
    const body = document.createElement("div");
    body.className = "kanban-modal-body";

    // Left: description
    const leftCol = document.createElement("div");
    leftCol.className = "kanban-modal-left";
    const descLabel = document.createElement("label");
    descLabel.className = "kanban-modal-label";
    descLabel.textContent = "Description";
    const descInput = document.createElement("textarea");
    descInput.className = "kanban-modal-textarea";
    descInput.rows = 7;
    descInput.value = task.description;
    descInput.placeholder = "Add a more detailed description…";
    leftCol.append(descLabel, descInput);

    // Right: metadata
    const rightCol = document.createElement("div");
    rightCol.className = "kanban-modal-right";

    const mkField = (labelText: string, input: HTMLElement) => {
      const g = document.createElement("div");
      g.className = "kanban-modal-field";
      const lbl = document.createElement("label");
      lbl.className = "kanban-modal-label";
      lbl.textContent = labelText;
      g.append(lbl, input);
      return g;
    };

    const assigneeInput = document.createElement("input");
    assigneeInput.className = "kanban-modal-input";
    assigneeInput.type = "text";
    assigneeInput.placeholder = "username";
    assigneeInput.value = task.assignee ?? "";
    assigneeInput.setAttribute("autocomplete", "off");

    const dueInput = document.createElement("input");
    dueInput.className = "kanban-modal-input";
    dueInput.type = "date";
    dueInput.value = task.due_date ? task.due_date.slice(0, 10) : "";

    const labelsInput = document.createElement("input");
    labelsInput.className = "kanban-modal-input";
    labelsInput.type = "text";
    labelsInput.placeholder = "bug, feature, urgent";
    labelsInput.value = task.labels.join(", ");

    const labelPreview = document.createElement("div");
    labelPreview.className = "kanban-modal-label-preview";
    const refreshPreview = () => {
      labelPreview.innerHTML = "";
      labelsInput.value.split(",").map((s) => s.trim()).filter(Boolean).forEach((l) => {
        const tag = document.createElement("span");
        tag.className = "kanban-label";
        const { bg, text } = labelColor(l);
        tag.style.setProperty("--label-bg", bg);
        tag.style.setProperty("--label-text", text);
        tag.textContent = l;
        labelPreview.appendChild(tag);
      });
    };
    refreshPreview();
    labelsInput.addEventListener("input", refreshPreview);

    const assigneeField = mkField("Assignee", assigneeInput);
    rightCol.append(
      assigneeField,
      mkField("Due date", dueInput),
      mkField("Labels", labelsInput),
      labelPreview,
    );
    // Wire autocomplete after the field is in the DOM tree
    this._attachUserAutocomplete(assigneeInput);

    body.append(leftCol, rightCol);

    // ── Footer: delete (left) + save (right)
    const footer = document.createElement("div");
    footer.className = "kanban-modal-footer";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "kanban-modal-delete-btn";
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete`;
    let deleteArmed = false;
    deleteBtn.addEventListener("click", () => {
      if (!deleteArmed) {
        deleteArmed = true;
        deleteBtn.textContent = "Confirm delete?";
        deleteBtn.classList.add("armed");
        setTimeout(() => {
          deleteArmed = false;
          deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> Delete`;
          deleteBtn.classList.remove("armed");
        }, 3000);
        return;
      }
      this._emit<TaskDeleteDetail>("cbl-task-delete", { taskId: task.id, boardId: task.board_id });
      overlay.remove();
    });

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save";
    const doSave = () => {
      const updated: Task = {
        ...task,
        title: titleInput.value.trim() || task.title,
        description: descInput.value,
        assignee: assigneeInput.value.trim() || null,
        due_date: dueInput.value ? new Date(dueInput.value).toISOString() : null,
        labels: labelsInput.value.split(",").map((s) => s.trim()).filter(Boolean),
      };
      this._emit<TaskUpdateDetail>("cbl-task-update", { task: updated });
      overlay.remove();
    };
    saveBtn.addEventListener("click", doSave);

    modal.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doSave(); }
      if (e.key === "Escape") overlay.remove();
    });

    footer.append(deleteBtn, saveBtn);
    modal.append(modalHeader, body, footer);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
    titleInput.focus();
    titleInput.select();
  }
}

customElements.define("cbl-kanban-board", CblKanbanBoard);
