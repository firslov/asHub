import { bootSession } from "./sse.js";
import { registerSession, unregisterSession } from "./session-manager.js";
import { STATE_DEFAULTS } from "./state.js";

const parseId = () =>
  (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";

const SCROLL_SLOP = 40;

class SessionView extends HTMLElement {
  connectedCallback() {
    this.id = this.getAttribute("session-id") || parseId();
    this.controller = new AbortController();

    const tpl = document.getElementById("session-view-tpl");
    this.appendChild(tpl.content.cloneNode(true));
    this.streamEl = this.querySelector(".session-stream");
    this.emptyStateEl = this.querySelector(".stream-empty");
    this.pillEl = this.querySelector(".scroll-pill");
    this.usageStripEl = this.querySelector(".usage-strip");
    this.usageEl = this.querySelector(".terminal-usage");

    this.state = { ...STATE_DEFAULTS };
    this.agentInfo = { name: "", model: "", provider: "" };
    this.reply = { current: null, text: "", pendingChunkRender: false, liveSegment: false };
    this.thinking = { el: null, block: null };
    this.toolGroup = { current: null };
    this.liveOutput = { lastRow: null, output: null, completed: new Set() };
    this.scroll = { stickToBottom: true, lastSeen: 0 };
    this.infiniteScroll = {
      firstContentId: null,
      totalFrames: 0,
      loading: false,
      exhausted: false,
      loadGeneration: 0,
    };
    this.files = { expandedDirs: new Map() };
    this.context = {
      selected: new Set(),
      currentMsgs: [],
      currentGroups: [],
      activeRoles: new Set(["all"]),
    };

    const signal = this.controller.signal;
    this.streamEl.addEventListener("scroll", () => {
      const stick = this.streamEl.scrollHeight - this.streamEl.scrollTop - this.streamEl.clientHeight <= SCROLL_SLOP;
      this.scroll.stickToBottom = stick;
      if (this.pillEl && stick) this.pillEl.hidden = true;
    }, { signal });
    this.pillEl?.addEventListener("click", () => {
      this.streamEl.scrollTo({ top: this.streamEl.scrollHeight, behavior: "smooth" });
      this.scroll.stickToBottom = true;
      if (this.pillEl) this.pillEl.hidden = true;
    }, { signal });
    this.querySelector(".stream-empty-prompt")?.addEventListener("click", () => {
      document.getElementById("query")?.focus();
    }, { signal });

    registerSession(this);
    bootSession(signal);
  }

  disconnectedCallback() {
    this.controller?.abort();
    unregisterSession(this);
  }
}

customElements.define("session-view", SessionView);
