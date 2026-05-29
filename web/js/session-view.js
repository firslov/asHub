import { handlers, onReplayDone, hidePageLoader, seedSessionInfo, REPLAY_FLUSH_DELAY } from "./sse.js";
import { registerSession, unregisterSession, subscribeSession, unsubscribeSession, resyncSession } from "./session-manager.js";
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
    if (this.host) void this.checkRemoteReadiness();
  }

  // On opening a remote session, verify the host has credentials + a provider
  // so the agent can actually run; if not, surface a guided auth banner.
  async checkRemoteReadiness() {
    if (!this.host) return;
    try {
      const r = await fetch(`/api/hosts/${encodeURIComponent(this.host)}/status`);
      if (!r.ok) return;
      const ready = (await r.json()).readiness;
      if (!ready) return;
      if (ready.keys && ready.providers) { this.authBannerEl.hidden = true; return; }
      const missing = [];
      if (!ready.keys) missing.push("keys.json");
      if (!ready.providers) missing.push("a provider");
      this.renderAuthBanner(missing);
    } catch { /* probe failure is non-fatal */ }
  }

  renderAuthBanner(missing) {
    const el = this.authBannerEl;
    if (!el) return;
    el.hidden = false;
    el.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = `${this.host} is missing ${missing.join(" and ")} — the agent can't run here yet.`;
    el.appendChild(msg);
    const btn = document.createElement("button");
    btn.className = "auth-banner-btn";
    btn.textContent = "Push local config";
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Pushing…";
      try {
        const pr = await fetch(`/api/hosts/${encodeURIComponent(this.host)}/bootstrap`, { method: "POST" });
        if (!pr.ok) { msg.textContent = `Push failed: ${await pr.text()}`; btn.disabled = false; btn.textContent = "Retry"; return; }
        const r2 = (await pr.json()).readiness;
        if (r2?.keys && r2?.providers) this.renderAuthReady();
        else {
          const still = [!r2?.keys && "keys.json", !r2?.providers && "a provider"].filter(Boolean);
          msg.textContent = `Pushed; still missing ${still.join(" and ")}.`;
          btn.disabled = false; btn.textContent = "Retry";
        }
      } catch (e) {
        msg.textContent = `Push failed: ${e?.message ?? e}`;
        btn.disabled = false; btn.textContent = "Retry";
      }
    });
    el.appendChild(btn);
  }

  // Config is on the host now, but a live session can't re-register its
  // backend — recovery is a fresh session, which picks up the new config.
  renderAuthReady() {
    const el = this.authBannerEl;
    el.innerHTML = "";
    el.classList.add("ready");
    const msg = document.createElement("span");
    msg.textContent = `${this.host} is configured. Start a new session to use it.`;
    el.appendChild(msg);
    const btn = document.createElement("button");
    btn.className = "auth-banner-btn";
    btn.textContent = `New session on ${this.host}`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: this.host, cwd: this.state?.cwd || "~" }),
        });
        if (!res.ok) { btn.disabled = false; return; }
        const sess = await res.json();
        if (sess.instanceId) window.location.href = `/${sess.instanceId}/`;
      } catch { btn.disabled = false; }
    });
    el.appendChild(btn);
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

    // Sticky remote-connection banner (reconnecting / offline). Lives at the
    // top of the session view, above the stream; hidden until a remote:status
    // event (or attach) flips it.
    this.remoteBannerEl = document.createElement("div");
    this.remoteBannerEl.className = "remote-banner";
    this.remoteBannerEl.hidden = true;
    this.insertBefore(this.remoteBannerEl, this.firstChild);

    // Auth banner: shown when a remote host is missing credentials/providers
    // so the agent can't run.  Carries an action (push local config) since a
    // live session can't re-register its backend after the fact.
    this.authBannerEl = document.createElement("div");
    this.authBannerEl.className = "auth-banner";
    this.authBannerEl.hidden = true;
    this.insertBefore(this.authBannerEl, this.remoteBannerEl);

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

  // Render the sticky remote-connection banner.  phase: "reconnecting" |
  // "offline" | "connecting" show it; "connected"/null hide it.  host is the
  // label to name (defaults to the session's host id).
  setRemoteStatus(phase, host) {
    this.remoteStatus = phase || null;
    const el = this.remoteBannerEl;
    if (!el) return;
    const label = host || this.host || "remote";
    el.classList.remove("reconnecting", "offline", "connecting");
    if (phase === "reconnecting") {
      el.classList.add("reconnecting");
      el.textContent = `Reconnecting to ${label}…`;
      el.hidden = false;
    } else if (phase === "offline") {
      el.classList.add("offline");
      el.textContent = `${label} is offline — reopen the session to reconnect.`;
      el.hidden = false;
    } else if (phase === "connecting") {
      el.classList.add("connecting");
      el.textContent = `Connecting to ${label}…`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  resync({ force = false } = {}) {
    if (!this.id) return;
    if (this.replayFlushTimer) { clearTimeout(this.replayFlushTimer); this.replayFlushTimer = null; }
    this.controller?.abort();
    // SPA cache: preserve DOM across session switches.  Only rebuild when
    // forced (rewind / branch-switch) or when there is no content yet.
    if (!force && this.streamEl && this.streamEl.children.length > 0) {
      this.exitReplayMode();
      subscribeSession(this.id);
      return;
    }
    this.innerHTML = "";
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
