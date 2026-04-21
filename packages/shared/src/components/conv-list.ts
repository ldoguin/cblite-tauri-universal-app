import type { Conversation } from "../types.js";

/**
 * <cbl-conv-list> — renders the conversation list in the sidebar.
 *
 * Usage:
 *   const el = document.getElementById("conv-list") as CblConvList;
 *   el.conversations = conversations;
 *   el.selectedId = selectedConvId;
 *   el.addEventListener("cbl-conv-select", (e) => selectConversation(e.detail.id));
 *   el.addEventListener("cbl-conv-delete", (e) => deleteConversation(e.detail.id));
 */
export class CblConvList extends HTMLElement {
  private _conversations: Conversation[] = [];
  private _selectedId: string | null = null;

  set conversations(v: Conversation[]) {
    this._conversations = v;
    this._render();
  }

  set selectedId(v: string | null) {
    if (this._selectedId === v) return;
    this._selectedId = v;
    this.querySelectorAll<HTMLLIElement>(".note-item").forEach((li) => {
      li.classList.toggle("selected", li.dataset.id === v);
    });
  }

  private _render(): void {
    this.innerHTML = "";
    for (const conv of this._conversations) {
      const li = document.createElement("li");
      li.className = "note-item" + (conv.id === this._selectedId ? " selected" : "");
      li.dataset.id = conv.id;

      const title = document.createElement("div");
      title.className = "note-item-title";
      title.textContent = conv.title || "Untitled";

      const preview = document.createElement("div");
      preview.className = "note-item-preview";
      const last = conv.messages[conv.messages.length - 1];
      preview.textContent = last ? last.content.slice(0, 72) : "No messages yet";

      const date = document.createElement("div");
      date.className = "note-item-date";
      date.textContent = new Date(conv.updated_at).toLocaleDateString();

      li.append(title, preview, date);
      li.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent<{ id: string }>("cbl-conv-select", {
            detail: { id: conv.id },
            bubbles: true,
          })
        );
      });
      this.appendChild(li);
    }
  }
}

customElements.define("cbl-conv-list", CblConvList);
