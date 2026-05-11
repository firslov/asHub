export const sessionId = (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";
export const eventsUrl = `/${sessionId}/events?tail=50`;
export const submitUrl = `/${sessionId}/submit`;

export const state = {
  isProcessing: false,
  isSubmitting: false,
  currentTurn: -1,
  cwd: "",
  homeDir: "",
  lastQuery: "",
  lastUsage: null,
  contextWindow: 0,
  /** True while SSE replay frames are being batched. */
  replaying: false,
};

// ── Query history (persisted per-session via sessionStorage) ───────
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
  _index: -1,        // -1 = not navigating; 0..N-1 = position in history
  _savedInput: "",   // what was in the input before navigating

  push(query) {
    // Deduplicate consecutive identical queries
    if (this._items.length && this._items[this._items.length - 1] === query) return;
    this._items.push(query);
    saveHistory(this._items);
    this.reset();
  },

  /** Start navigating history from current input. Returns the first recall (most recent). */
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

  /** Navigate forward in history. Returns null when back at saved input. */
  recallDown() {
    if (this._index === -1) return null;
    if (this._index < this._items.length - 1) {
      this._index++;
      return this._items[this._index];
    }
    // Past the newest entry: restore saved input
    this.reset();
    return this._savedInput;
  },

  reset() {
    this._index = -1;
    this._savedInput = "";
  },

  get hasItems() { return this._items.length > 0; },
};

/** Agent identity state — used by sse.js and infinite-scroll.js */
export const agentInfo = { name: "", model: "" };
export const getAgentInfoState = () => ({ name: agentInfo.name, model: agentInfo.model });
export const setAgentInfoState = (s) => {
  agentInfo.name = s?.name ?? "";
  agentInfo.model = s?.model ?? "";
};

const spinner = document.getElementById("spinner");
const cancelBtn = document.getElementById("cancel-turn");

export const setBusy = (b) => {
  state.isProcessing = b;
  if (spinner) spinner.hidden = !b;
  if (cancelBtn) cancelBtn.hidden = !b;
};
