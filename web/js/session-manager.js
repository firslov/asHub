import { signal, computed, effect } from "../vendor/signals-core.js";

export const sessions = new Map();
export const activeSessionId = signal("");

export const activeSession = computed(() => {
  const id = activeSessionId.value;
  return id ? sessions.get(id) ?? null : null;
});

export const registerSession = (view) => {
  sessions.set(view.id, view);
  if (!activeSessionId.value) activeSessionId.value = view.id;
};

export const unregisterSession = (view) => {
  sessions.delete(view.id);
  if (activeSessionId.value === view.id) activeSessionId.value = "";
};

/** SPA-switching is on by default; opt out with localStorage.ash_spa = "0". */
export const spaEnabled = () => {
  try { return localStorage.getItem("ash_spa") !== "0"; }
  catch { return true; }
};

effect(() => {
  const active = activeSessionId.value;
  for (const [id, el] of sessions) el.hidden = id !== active;
});

export const globalConnState = signal(
  /** @type {"connecting"|"connected"|"reconnecting"|"nosession"} */ ("nosession"),
);

const subState = new Map();
let es = null;
let reopenScheduled = false;
let lastSeenId = 0;

const TAIL = { fresh: "all", ready: "0", resync: "all" };
const buildSubsParam = () => {
  const parts = [];
  for (const [id, status] of subState) parts.push(`${id}:${TAIL[status]}`);
  return parts.join(",");
};

const reopen = () => {
  reopenScheduled = false;
  es?.close();
  es = null;
  if (subState.size === 0) {
    globalConnState.value = "nosession";
    return;
  }
  globalConnState.value = "connecting";
  // since= recovers frames emitted in the close/reattach gap.
  const params = new URLSearchParams({ subs: buildSubsParam() });
  if (lastSeenId > 0) params.set("since", String(lastSeenId));
  const next = new EventSource(`/events?${params}`);
  es = next;
  next.onopen = () => {
    globalConnState.value = "connected";
    for (const id of subState.keys()) subState.set(id, "ready");
  };
  next.onerror = () => { globalConnState.value = "reconnecting"; };
  next.onmessage = (ev) => {
    const id = Number(ev.lastEventId);
    if (id > lastSeenId) lastSeenId = id;
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    sessions.get(frame?.meta?.source)?.receiveFrame?.(frame);
  };
};

// Coalesce rapid subscribe/unsubscribe calls into one reopen per tick.
const scheduleReopen = () => {
  if (reopenScheduled) return;
  reopenScheduled = true;
  queueMicrotask(reopen);
};

export const subscribeSession = (id) => {
  if (!id || subState.has(id)) return;
  subState.set(id, "fresh");
  scheduleReopen();
};

export const unsubscribeSession = (id) => {
  if (subState.delete(id)) scheduleReopen();
};

export const resyncSession = (id) => {
  if (!id || !subState.has(id)) return;
  subState.set(id, "resync");
  scheduleReopen();
};

export const preloadSession = (id) => {
  if (!id) throw new Error("preloadSession: id required");
  if (sessions.has(id)) return sessions.get(id);
  const existing = document.querySelector("session-view");
  const parent = existing?.parentElement ?? document.body;
  const el = document.createElement("session-view");
  el.setAttribute("session-id", id);
  el.hidden = true;
  // Insert after the first session-view so the trailing <form> stays at the
  // bottom of the flex column.
  parent.insertBefore(el, existing ? existing.nextSibling : null);
  return el;
};

/**
 * Switch the active session to `id`, lazily constructing a SessionView if
 * none exists. Pushes to history unless `push: false` (used by popstate).
 */
export const switchTo = (id, { push = true } = {}) => {
  if (!id || activeSessionId.peek() === id) return;
  if (!sessions.has(id)) preloadSession(id);
  if (push) history.pushState({ sessionId: id }, "", `/${id}/`);
  activeSessionId.value = id;
};

window.addEventListener("popstate", (ev) => {
  const id = ev.state?.sessionId
    ?? (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1];
  if (id) switchTo(id, { push: false });
});

window.__ash = { preload: preloadSession, switchTo, sessions, activeSessionId };
