import type { Note } from "../types.js";

/**
 * <cbl-note-list> — renders the list of notes in the sidebar.
 *
 * Usage:
 *   const el = document.getElementById("note-list") as CblNoteList;
 *   el.notes = notes;
 *   el.selectedId = selectedId;
 *   el.addEventListener("cbl-note-select", (e) => selectNote(e.detail.id));
 *   el.addEventListener("cbl-note-delete", (e) => deleteNote(e.detail.id));
 */
export class CblNoteList extends HTMLElement {
  private _notes: Note[] = [];
  private _selectedId: string | null = null;

  set notes(v: Note[]) {
    this._notes = v;
    this._render();
  }

  set selectedId(v: string | null) {
    if (this._selectedId === v) return;
    this._selectedId = v;
    // Update active class without a full re-render
    this.querySelectorAll<HTMLLIElement>(".note-item").forEach((li) => {
      li.classList.toggle("selected", li.dataset.id === v);
    });
  }

  private _render(): void {
    this.innerHTML = "";
    for (const note of this._notes) {
      const li = document.createElement("li");
      li.className = "note-item" + (note.id === this._selectedId ? " selected" : "");
      li.dataset.id = note.id;

      const title = document.createElement("div");
      title.className = "note-item-title";
      title.textContent = note.title || "Untitled";

      const preview = document.createElement("div");
      preview.className = "note-item-preview";
      preview.textContent = (note.content_text ?? "").trim().slice(0, 72) || "No additional text";

      const date = document.createElement("div");
      date.className = "note-item-date";
      date.textContent = new Date(note.updated_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      li.append(title, preview, date);
      li.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent<{ id: string }>("cbl-note-select", {
            detail: { id: note.id },
            bubbles: true,
          })
        );
      });
      this.appendChild(li);
    }
  }
}

customElements.define("cbl-note-list", CblNoteList);
