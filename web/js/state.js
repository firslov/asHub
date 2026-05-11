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
  return { name: s?.agentInfo.name ?? "", model: s?.agentInfo.model ?? "" };
};
export const setAgentInfoState = (s) => {
  const session = activeSession.peek();
  if (!session) return;
  session.agentInfo.name = s?.name ?? "";
  session.agentInfo.model = s?.model ?? "";
};

const spinner = document.getElementById("spinner");
const cancelBtn = document.getElementById("cancel-turn");

export const setBusy = (b) => {
  const s = activeSession.peek();
  if (s) s.state.isProcessing = b;
  if (spinner) spinner.hidden = !b;
  if (cancelBtn) cancelBtn.hidden = !b;
};
