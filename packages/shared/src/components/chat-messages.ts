import type { Conversation, ChatAttachment } from "../types.js";

/**
 * <cbl-chat-messages> — renders message bubbles for the active conversation.
 *
 * Usage:
 *   const el = document.getElementById("chat-messages") as CblChatMessages;
 *   el.getBlobData = getBlobData;   // inject adapter callback once at setup
 *   el.conversation = conv;         // re-render on state change
 *   // after render, scroll position is already at bottom
 */
export class CblChatMessages extends HTMLElement {
  /** Inject the adapter's getBlobData callback before first render. */
  getBlobData: (digest: string) => Promise<string> = () =>
    Promise.reject(new Error("getBlobData not injected"));

  set conversation(v: Conversation | null) {
    this._render(v);
  }

  private async _render(conv: Conversation | null): Promise<void> {
    this.innerHTML = "";
    if (!conv) return;

    for (const msg of conv.messages) {
      const bubble = document.createElement("div");
      bubble.className = `chat-bubble chat-bubble--${msg.role}`;

      if (msg.content) {
        const p = document.createElement("p");
        p.className = "chat-bubble-text";
        p.textContent = msg.content;
        bubble.appendChild(p);
      }

      const ts = document.createElement("span");
      ts.className = "chat-bubble-ts";
      ts.textContent = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      bubble.appendChild(ts);
      this.appendChild(bubble);

      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          await this._renderAttachment(att, bubble);
        }
      }
    }

    this.scrollTop = this.scrollHeight;
  }

  private async _renderAttachment(att: ChatAttachment, bubble: HTMLElement): Promise<void> {
    if (att.mime.startsWith("image/")) {
      try {
        const b64 = await this.getBlobData(att.digest);
        const img = document.createElement("img");
        img.src = `data:${att.mime};base64,${b64}`;
        img.className = "chat-attachment-img";
        img.alt = att.name;
        bubble.insertBefore(img, bubble.lastElementChild);
      } catch { /* skip on error */ }
    } else {
      const chip = document.createElement("div");
      chip.className = "chat-attachment-file";
      chip.title = att.name;
      chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>${att.name}</span>`;
      chip.addEventListener("click", async () => {
        try {
          const b64 = await this.getBlobData(att.digest);
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: att.mime }));
          window.open(url, "_blank");
        } catch { /* ignore */ }
      });
      bubble.insertBefore(chip, bubble.lastElementChild);
    }
  }
}

customElements.define("cbl-chat-messages", CblChatMessages);
