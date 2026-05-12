// @ts-check
import { signal } from "../vendor/signals-core.js";
import { activeSession } from "./session-manager.js";

export const sessionId = (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";
export const eventsUrl = `/${sessionId}/events?tail=50`;
export const submitUrl = `/${sessionId}/submit`;

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

const HIST_KEY = `ashub_history_${sessionId}`;
const MAX_HISTORY = 50;

const loadHistory = () => {
  try {
    return JSON.parse(sessionStorage.getItem(HIST_KEY)) || [];
  } catch { return []; }
};

const saveHistory = (arr) => {
  try {
    sessionStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(-MAX_HISTORY)));
  } catch {}
};

export const queryHistory = {
  _items: loadHistory(),
  _index: -1,
  _savedInput: "",

  push(query) {
    if (this._items.length && this._items[this._items.length - 1] === query) return;
    this._items.push(query);
    saveHistory(this._items);
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

export const getAgentInfoState = () => {
  const s = activeSession.peek();
  return { name: s?.agentInfo.name ?? "", model: s?.agentInfo.model ?? "", provider: s?.agentInfo.provider ?? "" };
};
export const setAgentInfoState = (s) => {
  const session = activeSession.peek();
  if (!session) return;
  session.agentInfo.name = s?.name ?? "";
  session.agentInfo.model = s?.model ?? "";
  session.agentInfo.provider = s?.provider ?? "";
};

const spinner = document.getElementById("spinner");
const cancelBtn = document.getElementById("cancel-turn");

export const setBusy = (b) => {
  const s = activeSession.peek();
  if (s) s.state.isProcessing = b;
  if (spinner) spinner.hidden = !b;
  if (cancelBtn) cancelBtn.hidden = !b;
};
