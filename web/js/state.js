const SESSION_PATH_RE = /^\/([0-9a-f]{4,32})\/?$/;

export const parseSessionId = (path) =>
  (path.match(SESSION_PATH_RE) ?? [])[1] ?? "";

export let sessionId = parseSessionId(location.pathname);
export let eventsUrl = `/${sessionId}/events?tail=50`;
export let submitUrl = `/${sessionId}/submit`;

export const setSessionId = (id) => {
  sessionId = id;
  eventsUrl = `/${id}/events?tail=50`;
  submitUrl = `/${id}/submit`;
};

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

/** Agent identity state — used by sse.js and infinite-scroll.js */
export const agentInfo = { name: "", model: "" };
export const getAgentInfoState = () => ({ name: agentInfo.name, model: agentInfo.model });
export const setAgentInfoState = (s) => {
  agentInfo.name = s?.name ?? "";
  agentInfo.model = s?.model ?? "";
};

export const resetSessionState = () => {
  state.isProcessing = false;
  state.isSubmitting = false;
  state.currentTurn = -1;
  state.cwd = "";
  state.lastQuery = "";
  state.lastUsage = null;
  state.replaying = false;
};

const spinner = document.getElementById("spinner");
const cancelBtn = document.getElementById("cancel-turn");

export const setBusy = (b) => {
  state.isProcessing = b;
  if (spinner) spinner.hidden = !b;
  if (cancelBtn) cancelBtn.hidden = !b;
};
