import { registerSession, unregisterSession, subscribeSession, unsubscribeSession } from "./session-manager.js";
import { hidePageLoader } from "./sse.js";

const parseId = () =>
  (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";

class TerminalView extends HTMLElement {
  connectedCallback() {
    this.id = this.getAttribute("session-id") || parseId();
    this.term = null;
    this.ended = false;
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
      fontFamily: '"Geist Mono", "JetBrains Mono", "Cascadia Code", "Consolas", "SF Mono", "Symbols Nerd Font Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: themeFromCss(),
    });
    this.term.open(this.hostEl);
    this.themeObserver = new MutationObserver(() => {
      if (this.term) this.term.options.theme = themeFromCss();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });

    this.term.onData((data) => {
      if (!this.id || this.ended) return;
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
    this.themeObserver?.disconnect();
    if (this.fitTimer) { clearTimeout(this.fitTimer); this.fitTimer = null; }
    if (this.id) unsubscribeSession(this.id);
    unregisterSession(this);
    try { this.term?.dispose(); } catch {}
    this.term = null;
  }

  receiveFrame(frame) {
    const name = frame?.meta?.name;
    if (!this.term) return;
    if (name === "hub:replay-starting") {
      this.term.reset();
      this.ended = false;
      this.term.options.disableStdin = false;
      this.term.options.cursorBlink = true;
    } else if (name === "shell:pty-data") {
      const raw = frame.payload?.raw;
      if (typeof raw === "string") this.term.write(raw);
    } else if (name === "ui:error") {
      const message = String(frame.payload?.message ?? "Terminal error");
      this.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
    } else if (name === "shell:exit") {
      this.ended = true;
      this.term.options.disableStdin = true;
      this.term.options.cursorBlink = false;
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
    background: v("--bg", "#2d2a26"),
    foreground: v("--fg", "#ded2bc"),
    cursor: v("--accent", "#c89d6e"),
    cursorAccent: v("--bg", "#2d2a26"),
    selectionBackground: v("--accent-soft", "rgba(200, 157, 110, 0.12)"),
    // Both ANSI families follow the softened palette when the theme changes.
    black: v("--bg", "#2d2a26"),
    red: v("--red", "#d59c8f"),
    green: v("--green", "#a5b080"),
    yellow: v("--amber", "#c5b17d"),
    blue: v("--cyan", "#94b0b2"),
    magenta: v("--purple", "#bba1b3"),
    cyan: v("--aqua", "#91ae97"),
    white: v("--text-dim", "#c3b59e"),
    brightBlack: v("--text-muted", "#b5a48f"),
    brightRed: v("--red-light", "#dfa99c"),
    brightGreen: v("--green-light", "#b0bc8d"),
    brightYellow: v("--amber", "#c5b17d"),
    brightBlue: v("--cyan-light", "#a1babe"),
    brightMagenta: v("--purple", "#bba1b3"),
    brightCyan: v("--aqua", "#91ae97"),
    brightWhite: v("--text", "#ded2bc"),
  };
}

customElements.define("terminal-view", TerminalView);
