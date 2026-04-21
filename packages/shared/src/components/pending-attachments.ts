/**
 * <cbl-pending-attachments> — shows files queued before the chat send button.
 *
 * Usage:
 *   const el = document.getElementById("pending-attachments") as CblPendingAttachments;
 *   el.attachments = pendingAttachments;
 *   el.addEventListener("cbl-attachment-remove", (e) => {
 *     pendingAttachments.splice(e.detail.index, 1);
 *     el.attachments = pendingAttachments;
 *   });
 */
export class CblPendingAttachments extends HTMLElement {
  set attachments(v: Array<{ name: string; mime: string }>) {
    this.hidden = v.length === 0;
    this.innerHTML = "";
    for (let i = 0; i < v.length; i++) {
      const att = v[i];
      const chip = document.createElement("div");
      chip.className = "pending-chip";
      chip.innerHTML = `<span class="pending-chip-name">${att.name}</span>`;

      const rm = document.createElement("button");
      rm.className = "pending-chip-remove";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent<{ index: number }>("cbl-attachment-remove", {
            detail: { index: i },
            bubbles: true,
          })
        );
      });
      chip.appendChild(rm);
      this.appendChild(chip);
    }
  }
}

customElements.define("cbl-pending-attachments", CblPendingAttachments);
