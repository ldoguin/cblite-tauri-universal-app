import type { SavedServer } from "../types.js";

/**
 * <cbl-server-list> — renders saved servers in the profile panel.
 *
 * Usage:
 *   const el = document.getElementById("server-list") as CblServerList;
 *   el.update(savedServers, activeServerUrl, datalistEl);
 *   el.addEventListener("cbl-server-connect", (e) => connectToServer(e.detail.url));
 *   el.addEventListener("cbl-server-remove",  (e) => removeServer(e.detail.index));
 */
export class CblServerList extends HTMLElement {
  /**
   * Re-render the list.
   * @param servers    All saved servers.
   * @param activeUrl  URL of the currently connected server (highlighted).
   * @param datalist   Optional <datalist> element to update for the URL autocomplete input.
   */
  update(servers: SavedServer[], activeUrl: string, datalist?: HTMLDataListElement | null): void {
    this.innerHTML = "";

    if (servers.length === 0) {
      const li = document.createElement("li");
      li.style.cssText = "font-size:0.78rem;color:var(--panel-muted);padding:4px 2px;";
      li.textContent = "No servers saved";
      this.appendChild(li);
    } else {
      for (let i = 0; i < servers.length; i++) {
        const s = servers[i];
        const isActive = s.url === activeUrl;

        const li = document.createElement("li");
        li.className = "server-item" + (isActive ? " active" : "");

        const urlSpan = document.createElement("span");
        urlSpan.className = "server-item-url";
        urlSpan.textContent = s.url;
        urlSpan.title = s.url;

        const actions = document.createElement("div");
        actions.className = "server-item-actions";

        const connectBtn = document.createElement("button");
        connectBtn.className = "btn-xs btn-secondary";
        connectBtn.textContent = isActive ? "Active" : "Connect";
        connectBtn.disabled = isActive;
        connectBtn.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent<{ url: string }>("cbl-server-connect", {
              detail: { url: s.url },
              bubbles: true,
            })
          );
        });

        const removeBtn = document.createElement("button");
        removeBtn.className = "btn-xs btn-ghost-danger";
        removeBtn.textContent = "×";
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent<{ index: number }>("cbl-server-remove", {
              detail: { index: i },
              bubbles: true,
            })
          );
        });

        actions.append(connectBtn, removeBtn);
        li.append(urlSpan, actions);
        this.appendChild(li);
      }
    }

    // Refresh the datalist for the URL autocomplete input
    if (datalist) {
      datalist.innerHTML = "";
      for (const s of servers) {
        const opt = document.createElement("option");
        opt.value = s.url;
        datalist.appendChild(opt);
      }
    }
  }
}

customElements.define("cbl-server-list", CblServerList);
