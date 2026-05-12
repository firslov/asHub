import { handlers, onReplayDone, hidePageLoader, REPLAY_FLUSH_DELAY } from "./sse.js";
import { registerSession, unregisterSession } from "./session-manager.js";
import { STATE_DEFAULTS } from "./state.js";
import { signal } from "../vendor/signals-core.js";

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

    this.connState = signal(/** @type {"connecting"|"connected"|"reconnecting"|"nosession"} */ ("connecting"));
    this.replayFlushTimer = null;

    const ac = this.controller.signal;
    this.streamEl.addEventListener("scroll", () => {
      const stick = this.streamEl.scrollHeight - this.streamEl.scrollTop - this.streamEl.clientHeight <= SCROLL_SLOP;
      this.scroll.stickToBottom = stick;
      if (this.pillEl && stick) this.pillEl.hidden = true;
    }, { signal: ac });
    this.pillEl?.addEventListener("click", () => {
      this.streamEl.scrollTo({ top: this.streamEl.scrollHeight, behavior: "smooth" });
      this.scroll.stickToBottom = true;
      if (this.pillEl) this.pillEl.hidden = true;
    }, { signal: ac });
    this.querySelector(".stream-empty-prompt")?.addEventListener("click", () => {
      document.getElementById("query")?.focus();
    }, { signal: ac });

    registerSession(this);
    this.connect();
  }

  disconnectedCallback() {
    if (this.replayFlushTimer) clearTimeout(this.replayFlushTimer);
    this.controller?.abort();
    unregisterSession(this);
  }

  connect() {
    const ac = this.controller.signal;
    // If SSE never opens, drop the page loader after 8s anyway.
    const loaderFallback = setTimeout(hidePageLoader, 8000);
    ac.addEventListener("abort", () => clearTimeout(loaderFallback), { once: true });

    if (!this.id) {
      hidePageLoader();
      this.connState.value = "nosession";
      return;
    }

    const es = new EventSource(`/${this.id}/events?tail=50`);
    this.es = es;
    ac.addEventListener("abort", () => es.close(), { once: true });

    es.onopen = () => {
      this.connState.value = "connected";
      this.enterReplayMode();
    };
    es.onerror = () => {
      hidePageLoader();
      this.connState.value = "reconnecting";
      if (this.state.replaying) this.exitReplayMode();
    };
    es.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      const fn = handlers[frame?.meta?.name];
      if (fn) {
        try { fn.call(this, frame.payload); }
        catch (e) { console.error(frame.meta.name, e); }
      }
      this.scheduleReplayFlush();
    };
  }

  enterReplayMode() {
    this.state.replaying = true;
    if (this.replayFlushTimer) clearTimeout(this.replayFlushTimer);
    // Safety net for empty replays: exit after 500ms if no frames arrive.
    this.replayFlushTimer = setTimeout(() => this.exitReplayMode(), 500);
  }

  scheduleReplayFlush() {
    if (!this.state.replaying) return;
    if (this.replayFlushTimer) clearTimeout(this.replayFlushTimer);
    this.replayFlushTimer = setTimeout(() => this.exitReplayMode(), REPLAY_FLUSH_DELAY);
  }

  exitReplayMode() {
    this.state.replaying = false;
    if (this.replayFlushTimer) { clearTimeout(this.replayFlushTimer); this.replayFlushTimer = null; }
    hidePageLoader();
    onReplayDone(this);
  }
}

customElements.define("session-view", SessionView);
