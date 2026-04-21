import type { Board, Column, Task } from "../types.js";

// ── Event detail types ────────────────────────────────────────────────────────

export interface TaskMoveDetail {
  taskId: string;
  fromColumnId: string;
  toColumnId: string;
  newPosition: number;
}

export interface TaskCreateDetail { columnId: string; }
export interface TaskUpdateDetail { task: Task; }
export interface TaskDeleteDetail { taskId: string; boardId: string; }
export interface ColumnCreateDetail { boardId: string; }
export interface ColumnUpdateDetail { column: Column; }
export interface ColumnDeleteDetail { columnId: string; boardId: string; }

/**
 * <cbl-kanban-board> — renders a Kanban board with columns and draggable task cards.
 *
 * Properties:
 *   board, columns, tasks, currentUser
 *
 * Emits (all bubble):
 *   cbl-task-move, cbl-task-create, cbl-task-update, cbl-task-delete,
 *   cbl-column-create, cbl-column-update, cbl-column-delete
 */
export class CblKanbanBoard extends HTMLElement {
  private _board: Board | null = null;
  private _columns: Column[] = [];
  private _tasks: Task[] = [];
  private _currentUser = "";

  // drag state
  private _dragTaskId: string | null = null;
  private _dragFromColId: string | null = null;

  set board(v: Board | null) { this._board = v; this._render(); }
  set columns(v: Column[]) { this._columns = v; this._render(); }
  set tasks(v: Task[]) { this._tasks = v; this._render(); }
  set currentUser(v: string) { this._currentUser = v; }

  private _emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true }));
  }

  private _render(): void {
    if (!this._board) {
      this.innerHTML = `<div class="kanban-empty">Select or create a board.</div>`;
      return;
    }

    // Order columns by board.column_order, then by position for any not in the list
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

    // Add column button
    const addColBtn = document.createElement("button");
    addColBtn.className = "kanban-add-col-btn";
    addColBtn.title = "Add column";
    addColBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add column`;
    addColBtn.addEventListener("click", () => {
      this._emit<ColumnCreateDetail>("cbl-column-create", { boardId: this._board!.id });
    });
    strip.appendChild(addColBtn);

    this.appendChild(strip);
  }

  private _renderColumn(col: Column): HTMLElement {
    const tasks = this._tasks
      .filter((t) => t.column_id === col.id)
      .sort((a, b) => a.position - b.position);

    const colEl = document.createElement("div");
    colEl.className = "kanban-col";
    colEl.dataset.colId = col.id;

    // Column header
    const header = document.createElement("div");
    header.className = "kanban-col-header";

    const titleInput = document.createElement("input");
    titleInput.className = "kanban-col-title";
    titleInput.value = col.name;
    titleInput.addEventListener("change", () => {
      this._emit<ColumnUpdateDetail>("cbl-column-update", {
        column: { ...col, name: titleInput.value.trim() || col.name },
      });
    });

    const count = document.createElement("span");
    count.className = "kanban-col-count";
    count.textContent = String(tasks.length);

    const delColBtn = document.createElement("button");
    delColBtn.className = "kanban-col-del-btn";
    delColBtn.title = "Delete column";
    delColBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    delColBtn.addEventListener("click", () => {
      if (!confirm(`Delete column "${col.name}" and all its tasks?`)) return;
      this._emit<ColumnDeleteDetail>("cbl-column-delete", { columnId: col.id, boardId: col.board_id });
    });

    header.append(titleInput, count, delColBtn);

    // Task list
    const list = document.createElement("div");
    list.className = "kanban-task-list";
    list.dataset.colId = col.id;

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.add("drag-over");
    });
    list.addEventListener("dragleave", (e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
        (e.currentTarget as HTMLElement).classList.remove("drag-over");
      }
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove("drag-over");
      if (!this._dragTaskId || !this._dragFromColId) return;

      // Determine drop position from pointer Y
      const cards = Array.from(list.querySelectorAll<HTMLElement>(".kanban-card"));
      let newPosition = tasks.length;
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          newPosition = i;
          break;
        }
      }

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

    // Add card button
    const addBtn = document.createElement("button");
    addBtn.className = "kanban-add-card-btn";
    addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add card`;
    addBtn.addEventListener("click", () => {
      this._emit<TaskCreateDetail>("cbl-task-create", { columnId: col.id });
    });

    colEl.append(header, list, addBtn);
    return colEl;
  }

  private _renderCard(task: Task): HTMLElement {
    const card = document.createElement("div");
    card.className = "kanban-card";
    card.draggable = true;
    card.dataset.taskId = task.id;

    card.addEventListener("dragstart", () => {
      this._dragTaskId = task.id;
      this._dragFromColId = task.column_id;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
    });

    // Labels
    if (task.labels.length > 0) {
      const labelsEl = document.createElement("div");
      labelsEl.className = "kanban-card-labels";
      for (const label of task.labels) {
        const tag = document.createElement("span");
        tag.className = "kanban-label";
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

    // Meta row: assignee + due date
    const meta = document.createElement("div");
    meta.className = "kanban-card-meta";
    if (task.assignee) {
      const assigneeEl = document.createElement("span");
      assigneeEl.className = "kanban-card-assignee";
      assigneeEl.textContent = task.assignee;
      meta.appendChild(assigneeEl);
    }
    if (task.due_date) {
      const dueEl = document.createElement("span");
      dueEl.className = "kanban-card-due";
      const d = new Date(task.due_date);
      const now = new Date();
      if (d < now) dueEl.classList.add("overdue");
      dueEl.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      meta.appendChild(dueEl);
    }
    if (meta.children.length > 0) card.appendChild(meta);

    // Expand button
    const expandBtn = document.createElement("button");
    expandBtn.className = "kanban-card-expand-btn";
    expandBtn.title = "Edit card";
    expandBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._openCardModal(task);
    });
    card.appendChild(expandBtn);

    return card;
  }

  private _openCardModal(task: Task): void {
    // Remove any existing modal
    document.getElementById("kanban-card-modal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "kanban-card-modal";
    overlay.className = "kanban-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "kanban-modal";

    // Title
    const titleGroup = document.createElement("div");
    titleGroup.className = "kanban-modal-group";
    const titleLabel = document.createElement("label");
    titleLabel.className = "kanban-modal-label";
    titleLabel.textContent = "Title";
    const titleInput = document.createElement("input");
    titleInput.className = "kanban-modal-input";
    titleInput.type = "text";
    titleInput.value = task.title;
    titleGroup.append(titleLabel, titleInput);

    // Description
    const descGroup = document.createElement("div");
    descGroup.className = "kanban-modal-group";
    const descLabel = document.createElement("label");
    descLabel.className = "kanban-modal-label";
    descLabel.textContent = "Description";
    const descInput = document.createElement("textarea");
    descInput.className = "kanban-modal-textarea";
    descInput.rows = 4;
    descInput.value = task.description;
    descGroup.append(descLabel, descInput);

    // Assignee
    const assigneeGroup = document.createElement("div");
    assigneeGroup.className = "kanban-modal-group";
    const assigneeLabel = document.createElement("label");
    assigneeLabel.className = "kanban-modal-label";
    assigneeLabel.textContent = "Assignee";
    const assigneeInput = document.createElement("input");
    assigneeInput.className = "kanban-modal-input";
    assigneeInput.type = "text";
    assigneeInput.placeholder = "username";
    assigneeInput.value = task.assignee ?? "";
    assigneeGroup.append(assigneeLabel, assigneeInput);

    // Due date
    const dueGroup = document.createElement("div");
    dueGroup.className = "kanban-modal-group";
    const dueLabel = document.createElement("label");
    dueLabel.className = "kanban-modal-label";
    dueLabel.textContent = "Due date";
    const dueInput = document.createElement("input");
    dueInput.className = "kanban-modal-input";
    dueInput.type = "date";
    dueInput.value = task.due_date ? task.due_date.slice(0, 10) : "";
    dueGroup.append(dueLabel, dueInput);

    // Labels
    const labelsGroup = document.createElement("div");
    labelsGroup.className = "kanban-modal-group";
    const labelsLabel = document.createElement("label");
    labelsLabel.className = "kanban-modal-label";
    labelsLabel.textContent = "Labels (comma-separated)";
    const labelsInput = document.createElement("input");
    labelsInput.className = "kanban-modal-input";
    labelsInput.type = "text";
    labelsInput.placeholder = "bug, feature, urgent";
    labelsInput.value = task.labels.join(", ");
    labelsGroup.append(labelsLabel, labelsInput);

    // Actions
    const actions = document.createElement("div");
    actions.className = "kanban-modal-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
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
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      if (!confirm(`Delete task "${task.title}"?`)) return;
      this._emit<TaskDeleteDetail>("cbl-task-delete", { taskId: task.id, boardId: task.board_id });
      overlay.remove();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => overlay.remove());

    actions.append(saveBtn, deleteBtn, cancelBtn);
    modal.append(titleGroup, descGroup, assigneeGroup, dueGroup, labelsGroup, actions);
    overlay.appendChild(modal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
    titleInput.focus();
  }
}

customElements.define("cbl-kanban-board", CblKanbanBoard);
