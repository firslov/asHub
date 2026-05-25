import { registerSession, unregisterSession, subscribeSession, unsubscribeSession } from "./session-manager.js";
import { hidePageLoader } from "./sse.js";

const parseId = () =>
  (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";

class TerminalView extends HTMLElement {
  connectedCallback() {
    this.id = this.getAttribute("session-id") || parseId();
    this.term = null;
    this.fitTimer = null;
    this.lastSize = { cols: 0, rows: 0 };

    const Terminal = window.Terminal;
    if (!Terminal) {
      this.textContent = "xterm.js failed to load";
      hidePageLoader();
      return;
    }

    this.classList.add("terminal-pane");
    this.hostEl = document.createElement("div");
    this.hostEl.className = "xterm-host";
    this.appendChild(this.hostEl);

    this.term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, "Symbols Nerd Font Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: themeFromCss(),
    });
    this.term.open(this.hostEl);

    this.term.onData((data) => {
      if (!this.id) return;
      fetch(`/${this.id}/pty-input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => {});
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this);
    requestAnimationFrame(() => this.fit());

    registerSession(this);
    if (this.id) subscribeSession(this.id);
    hidePageLoader();
  }

  disconnectedCallback() {
    this.resizeObserver?.disconnect();
    if (this.fitTimer) { clearTimeout(this.fitTimer); this.fitTimer = null; }
    if (this.id) unsubscribeSession(this.id);
    unregisterSession(this);
    try { this.term?.dispose(); } catch {}
    this.term = null;
  }

  receiveFrame(frame) {
    const name = frame?.meta?.name;
    if (!this.term) return;
    if (name === "shell:pty-data") {
      const raw = frame.payload?.raw;
      if (typeof raw === "string") this.term.write(raw);
    } else if (name === "shell:exit") {
      const code = frame.payload?.exitCode;
      this.term.write(`\r\n\x1b[2m[process exited${typeof code === "number" ? ` with code ${code}` : ""}]\x1b[0m\r\n`);
    } else if (name === "hub:replay-done") {
      this.fit();
    }
  }

  scheduleFit() {
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => this.fit(), 60);
  }

  fit() {
    if (!this.term) return;
    const rect = this.hostEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const core = this.term._core;
    const dims = core?._renderService?.dimensions?.css?.cell;
    if (!dims || !dims.width || !dims.height) return;
    const cols = Math.max(2, Math.floor(rect.width / dims.width));
    const rows = Math.max(2, Math.floor(rect.height / dims.height));
    if (cols === this.lastSize.cols && rows === this.lastSize.rows) return;
    this.lastSize = { cols, rows };
    try { this.term.resize(cols, rows); } catch {}
    if (this.id) {
      fetch(`/${this.id}/pty-resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    }
  }
}

function themeFromCss() {
  const styles = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (styles.getPropertyValue(name).trim() || fallback);
  return {
    background: v("--bg", "#0b0e14"),
    foreground: v("--fg", "#cdd6f4"),
    cursor: v("--accent", "#89b4fa"),
  };
}

customElements.define("terminal-view", TerminalView);
