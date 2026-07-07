// @ts-check
import { signal, effect } from "../vendor/signals-core.js";
import { activeSessionId } from "./store.js";
import { activeSession } from "./session-manager.js";

export const sessionId = (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";

/** Active session id at call time; falls back to URL session before SessionView upgrades. */
export const currentSessionId = () => activeSessionId.peek() || sessionId;

export const homeDir = signal("");

export const headerTopic = signal("");
export const headerCwd = signal("");

export const STATE_DEFAULTS = Object.freeze({
  isProcessing: false,
  isSubmitting: false,
  currentTurn: -1,
  cwd: "",
  lastQuery: "",
  lastUsage: null,
  contextWindow: 0,
  replaying: false,
});

export const state = new Proxy(/** @type {any} */ ({}), {
  get(_, key) {
    return activeSession.peek()?.state?.[key];
  },
  set(_, key, value) {
    const s = activeSession.peek();
    if (s) s.state[key] = value;
    return true;
  },
});

const HIST_KEY = "ashub_history";
const MAX_HISTORY = 100;

const loadAll = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY) || "{}");
    // Migrate from old flat array format
    if (Array.isArray(raw)) return { _global: raw };
    return raw || {};
  } catch { return {}; }
};
const saveAll = (all) => {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(all));
  } catch {}
};
const sidKey = () => activeSessionId.peek() || "_global";

export const queryHistory = {
  _items: [],
  _index: -1,
  _savedInput: "",

  /** Switch to current session's history (call on session switch). */
  loadForSession() {
    const all = loadAll();
    this._items = (all[sidKey()] || []).slice(-MAX_HISTORY);
    this.reset();
  },

  push(query) {
    if (this._items.length && this._items[this._items.length - 1] === query) return;
    this._items.push(query);
    const all = loadAll();
    all[sidKey()] = this._items.slice(-MAX_HISTORY);
    saveAll(all);
    this.reset();
  },

  recallUp(currentInput) {
    if (!this._items.length) return null;
    if (this._index === -1) {
      this._savedInput = currentInput;
      this._index = this._items.length - 1;
    } else if (this._index > 0) {
      this._index--;
    }
    return this._items[this._index];
  },

  recallDown() {
    if (this._index === -1) return null;
    if (this._index < this._items.length - 1) {
      this._index++;
      return this._items[this._index];
    }
    this.reset();
    return this._savedInput;
  },

  reset() {
    this._index = -1;
    this._savedInput = "";
  },

  get hasItems() { return this._items.length > 0; },
};

// Load history for current session on switch
queryHistory.loadForSession();
effect(() => { activeSessionId.value; queryHistory.loadForSession(); });

export const agentInfo = new Proxy(/** @type {any} */ ({}), {
  get(_, key) {
    return activeSession.peek()?.agentInfo?.[key] ?? "";
  },
  set(_, key, value) {
    const s = activeSession.peek();
    if (s) s.agentInfo[key] = value;
    return true;
  },
});

const spinner = document.getElementById("spinner");
const cancelBtn = document.getElementById("cancel-turn");

// Background sessions update their own state; chrome reflects active only.
export const setBusy = (session, b) => {
  if (session) session.state.isProcessing = b;
  if (session === activeSession.peek()) {
    if (spinner) spinner.hidden = !b;
    if (cancelBtn) cancelBtn.hidden = !b;
  }
};
