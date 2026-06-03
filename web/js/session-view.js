import { handlers, onReplayDone, hidePageLoader, seedSessionInfo, REPLAY_FLUSH_DELAY } from "./sse.js";
import { registerSession, unregisterSession, subscribeSession, unsubscribeSession, resyncSession } from "./session-manager.js";

const MAX_CACHED_DOMS = 3;
const _cachedDOMs = new Set();  // session view elements with live DOM

const evictDOMCache = () => {
  // Release oldest cached DOM if over limit.
  if (_cachedDOMs.size <= MAX_CACHED_DOMS) return;
  const oldest = [..._cachedDOMs][0];
  _cachedDOMs.delete(oldest);
  // Revoke Blob URLs before clearing DOM to free Oilpan memory.
  oldest.querySelectorAll?.(".agent-box-img").forEach((img) => {
    if (img.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
  });
  oldest.innerHTML = "";
  oldest._replayFrag = null;
}
import { STATE_DEFAULTS } from "./state.js";
import { t, scanI18n } from "./i18n.js";

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
    // Show usage strip immediately to avoid layout flash when async
    // data (model, balance, branch) arrives later via SSE events.
    if (this.usageStripEl) this.usageStripEl.hidden = false;
    if (this.id) {
      this.enterReplayMode();
      subscribeSession(this.id);
      this.seedStaticInfo();
    } else {
      hidePageLoader();
    }
  }

  async seedStaticInfo() {
    try {
      const r = await fetch("/sessions");
      if (!r.ok) return;
      const list = await r.json();
      const info = Array.isArray(list) ? list.find((s) => s.instanceId === this.id) : null;
      if (info) seedSessionInfo(this, info);
    } catch {}
  }

  initStreamShell() {
    this.controller = new AbortController();

    const tpl = document.getElementById("session-view-tpl");
    this.appendChild(tpl.content.cloneNode(true));
    // Template content isn't scanned by initial scanI18n — rescan now
    scanI18n(this);
    this.streamEl = this.querySelector(".session-stream");
    this.emptyStateEl = this.querySelector(".stream-empty");
    this.loadingEl = this.querySelector(".stream-loading");
    this.pillEl = this.querySelector(".scroll-pill");
    this.usageStripEl = this.querySelector(".usage-strip");
    this.usageEl = this.querySelector(".terminal-usage");
    this.branchEl = this.querySelector(".usage-branch");
    this.modelEl = this.querySelector(".usage-model");
    this.balanceEl = this.querySelector(".usage-balance");
    this.modelPickerEl = this.querySelector(".model-picker");
    this.modelDropdownEl = this.querySelector(".model-dropdown");
    this.cwdEl = this.querySelector(".usage-cwd");

    this.state = { ...STATE_DEFAULTS };
    this.reply = { current: null, text: "", pendingChunkRender: false, liveSegment: false };
    this.thinking = { el: null, block: null };
    this.toolGroup = { current: null };
    this.liveOutput = { lastRow: null, output: null, completed: new Set() };
    this.shellBlock = { current: null };
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
    const populateSuggestions = () => {
      this.querySelectorAll(".sugg-card").forEach((card) => {
        const key = card.dataset.suggestKey;
        if (!key) return;
        const label = card.querySelector(".sugg-label");
        if (label) label.textContent = t(key);
      });
    };
    populateSuggestions();

    this.querySelectorAll(".sugg-card").forEach((card) => {
      card.addEventListener("click", () => {
        const key = card.dataset.suggestKey;
        if (!key) return;
        const text = t(key);
        if (!text) return;
        const queryEl = document.getElementById("query");
        if (queryEl) {
          document.getElementById("new-session")?.click();
          queryEl.value = text;
          queryEl.focus();
          queryEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, { signal: ac });
    });

    // Re-populate on language change
    const onLangChange = () => populateSuggestions();
    document.addEventListener("langchange", onLangChange, { signal: ac });
  }

  resync({ force = false } = {}) {
    if (!this.id) return;
    if (this.replayFlushTimer) { clearTimeout(this.replayFlushTimer); this.replayFlushTimer = null; }
    this.controller?.abort();
    // SPA cache: preserve DOM across session switches.  Only rebuild when
    // forced (rewind / branch-switch) or when there is no content yet.
    if (!force && this.streamEl && this.streamEl.children.length > 0) {
      this.exitReplayMode();
      _cachedDOMs.add(this);
      evictDOMCache();
      subscribeSession(this.id);
      return;
    }
    this.innerHTML = "";
    _cachedDOMs.delete(this);
    this.initStreamShell();
    this.enterReplayMode();
    resyncSession(this.id);
  }

  resetForBranchSwitch() {
    if (this.streamEl) this.streamEl.innerHTML = "";
    this._replayFrag = null;
    this.state = { ...STATE_DEFAULTS };
    this.reply = { current: null, text: "", pendingChunkRender: false, liveSegment: false };
    this.thinking = { el: null, block: null };
    this.toolGroup = { current: null };
    this.liveOutput = { lastRow: null, output: null, completed: new Set() };
    this.shellBlock = { current: null };
  }

  disconnectedCallback() {
    if (this.replayFlushTimer) clearTimeout(this.replayFlushTimer);
    this.controller?.abort();
    if (this.id) unsubscribeSession(this.id);
    unregisterSession(this);
    _cachedDOMs.delete(this);
    // Free Blob URLs created by createUserBox for this session's images.
    this.querySelectorAll?.(".agent-box-img").forEach((img) => {
      if (img.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
    });
  }

  receiveFrame(frame) {
    // Hide loading skeleton on first content frame to prevent layout shift.
    if (this.state.replaying && this.loadingEl && !this.loadingEl.hidden) {
      this.loadingEl.hidden = true;
    }
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
    // Hide empty state immediately to prevent flash on SPA session switch.
    // If replay yields no content, exitReplayMode will restore it.
    if (this.emptyStateEl) this.emptyStateEl.hidden = true;
    // Show loading skeleton while replay frames stream in.
    if (this.loadingEl) this.loadingEl.hidden = false;
    // Batch DOM updates into a fragment during replay to avoid 1000+ reflows.
    this._replayFrag = document.createDocumentFragment();
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
    // Flush batched replay fragment to the real DOM in a single operation.
    if (this._replayFrag && this._replayFrag.childNodes.length > 0 && this.streamEl) {
      this.streamEl.appendChild(this._replayFrag);
    }
    this._replayFrag = null;
    // Hide loading skeleton now that content is rendered.
    if (this.loadingEl) this.loadingEl.hidden = true;
    hidePageLoader();
    onReplayDone(this);
    // If replay produced no content, restore the empty state.
    if (this.emptyStateEl?.hidden && !this.streamEl?.querySelector('.turn-sep, .agent-box, .tool-row, .thinking-block, .shell-block')) {
      this.emptyStateEl.hidden = false;
    }
  }
}

customElements.define("session-view", SessionView);
