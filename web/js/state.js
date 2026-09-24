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

// TypeScript doesn't know the vendored computed signal has .peek(); cast at call site.
const activeSessionView = /** @type {any} */ (activeSession);

export const state = new Proxy(/** @type {any} */ ({}), {
  get(_, key) {
    return activeSessionView.peek()?.state?.[key];
  },
  set(_, key, value) {
    const s = activeSessionView.peek();
    if (s) s.state[key] = value;
    return true;
  },
});

const HIST_KEY = "ashub_history";
const MAX_HISTORY = 100;
// Bound the session dimension: histories of deleted sessions are never
// pushed again, so evicting everything beyond the N most-recently-used
// session keys ages them out on their own.  (The sidebar's delete path
// dispatches no event we could hook for targeted cleanup.)
const MAX_SESSION_HISTORIES = 30;

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
    const next = JSON.stringify(all);
    // Skip the write when the stored history is already identical — a
    // synchronous localStorage write serializes the whole object.
    if (localStorage.getItem(HIST_KEY) === next) return;
    localStorage.setItem(HIST_KEY, next);
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
    const all = loadAll();
    const key = sidKey();
    // Merge on top of the freshest stored array, not this window's in-memory
    // copy: other windows share this localStorage and may have pushed entries
    // since this window last loaded.  Dedupe the query (it moves to the end)
    // and keep the 100-entry cap and LRU key-order semantics.
    const items = (all[key] || []).filter((q) => q !== query);
    items.push(query);
    const merged = items.slice(-MAX_HISTORY);
    // Re-insert at the end so object key order tracks recency of use.
    delete all[key];
    all[key] = merged;
    const keys = Object.keys(all);
    if (keys.length > MAX_SESSION_HISTORIES) {
      for (const k of keys.slice(0, keys.length - MAX_SESSION_HISTORIES)) delete all[k];
    }
    saveAll(all);
    this._items = merged;
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
    return activeSessionView.peek()?.agentInfo?.[key] ?? "";
  },
  set(_, key, value) {
    const s = activeSessionView.peek();
    if (s) s.agentInfo[key] = value;
    return true;
  },
});

const spinner = document.getElementById("spinner");

// Background sessions update their own state; chrome reflects active only.
export const setBusy = (session, b) => {
  if (session) session.state.isProcessing = b;
  if (session === activeSessionView.peek()) {
    if (spinner) spinner.hidden = !b;
  }
  // isProcessing is a plain property, not a signal — notify listeners (e.g.
  // composer's send button) explicitly instead of relying on effects.
  document.dispatchEvent(new CustomEvent("ash:busy-change"));
};
