import { handlers, onReplayDone, hidePageLoader, REPLAY_FLUSH_DELAY } from "./sse.js";
import { registerSession, unregisterSession, subscribeSession, unsubscribeSession, resyncSession } from "./session-manager.js";
import { STATE_DEFAULTS } from "./state.js";

const parseId = () =>
  (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";

const SCROLL_SLOP = 40;

class SessionView extends HTMLElement {
  connectedCallback() {
    this.id = this.getAttribute("session-id") || parseId();
    this.agentInfo = { name: "", model: "", provider: "", thinkingLevel: "", thinkingSupported: false };
    this.files = { expandedDirs: new Map() };
    this.context = {
      selected: new Set(),
      currentMsgs: [],
      currentGroups: [],
      activeRoles: new Set(["all"]),
    };
    this.initStreamShell();

    registerSession(this);
    if (this.id) {
      this.enterReplayMode();
      subscribeSession(this.id);
    } else {
      hidePageLoader();
    }
  }

  initStreamShell() {
    this.controller = new AbortController();

    const tpl = document.getElementById("session-view-tpl");
    this.appendChild(tpl.content.cloneNode(true));
    this.streamEl = this.querySelector(".session-stream");
    this.emptyStateEl = this.querySelector(".stream-empty");
    this.pillEl = this.querySelector(".scroll-pill");
    this.usageStripEl = this.querySelector(".usage-strip");
    this.usageEl = this.querySelector(".terminal-usage");

    this.state = { ...STATE_DEFAULTS };
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

    // Quick-start suggestion cards: click to fill the input
    this.querySelectorAll(".sugg-card").forEach((card) => {
      card.addEventListener("click", () => {
        const text = card.dataset.suggest;
        if (!text) return;
        const queryEl = document.getElementById("query");
        if (queryEl) {
          // Open the new-session form if no session exists yet
          const form = document.getElementById("new-session-form");
          if (form && form.hidden) {
            document.getElementById("new-session")?.click();
          }
          queryEl.value = text;
          queryEl.focus();
          // Trigger input to update autocomplete / resize
          queryEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, { signal: ac });
    });
  }

  resync() {
    if (!this.id) return;
    if (this.replayFlushTimer) { clearTimeout(this.replayFlushTimer); this.replayFlushTimer = null; }
    this.controller?.abort();
    this.innerHTML = "";
    this.initStreamShell();
    this.enterReplayMode();
    resyncSession(this.id);
  }

  resetForBranchSwitch() {
    if (this.streamEl) this.streamEl.innerHTML = "";
    this.state = { ...STATE_DEFAULTS };
    this.reply = { current: null, text: "", pendingChunkRender: false, liveSegment: false };
    this.thinking = { el: null, block: null };
    this.toolGroup = { current: null };
    this.liveOutput = { lastRow: null, output: null, completed: new Set() };
  }

  disconnectedCallback() {
    if (this.replayFlushTimer) clearTimeout(this.replayFlushTimer);
    this.controller?.abort();
    if (this.id) unsubscribeSession(this.id);
    unregisterSession(this);
  }

  receiveFrame(frame) {
    const fn = handlers[frame?.meta?.name];
    if (fn) {
      try { fn.call(this, frame.payload, frame.meta); }
      catch (e) { console.error(frame.meta.name, e); }
    }
    this.scheduleReplayFlush();
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
