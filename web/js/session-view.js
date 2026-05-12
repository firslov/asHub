import { bootSession } from "./sse.js";
import { registerSession, unregisterSession } from "./session-manager.js";
import { STATE_DEFAULTS } from "./state.js";

const parseId = () =>
  (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";

class SessionView extends HTMLElement {
  connectedCallback() {
    this.id = this.getAttribute("session-id") || parseId();
    this.controller = new AbortController();

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

    registerSession(this);
    bootSession(this.controller.signal);
  }

  disconnectedCallback() {
    this.controller?.abort();
    unregisterSession(this);
  }
}

customElements.define("session-view", SessionView);
