import { signal, computed, effect } from "../vendor/signals-core.js";

export const sessions = new Map();
export const activeSessionId = signal("");

export const activeSession = computed(() => {
  const id = activeSessionId.value;
  return id ? sessions.get(id) ?? null : null;
});

// Client-side working set, like browser tabs vs the sidebar's bookmarks.
export const openTabs = signal(/** @type {string[]} */ ([]));

export const openTab = (id) => {
  if (!id) return;
  if (!openTabs.value.includes(id)) openTabs.value = [...openTabs.value, id];
  switchTo(id);
};

export const closeTab = (id) => {
  if (!id) return;
  const list = openTabs.value;
  const idx = list.indexOf(id);
  if (idx < 0) return;
  const next = list.filter((x) => x !== id);
  openTabs.value = next;
  if (activeSessionId.peek() === id) {
    const neighbor = next[idx] ?? next[idx - 1] ?? next[0] ?? "";
    if (neighbor) switchTo(neighbor);
    else activeSessionId.value = "";
  }
  // .remove() triggers disconnectedCallback → unregister + unsubscribe.
  // Backend session is untouched; sidebar entry remains.
  sessions.get(id)?.remove();
};

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
  const terminal = document.querySelector(".terminal");
  const form = terminal?.querySelector(".live-input");
  const parent = terminal ?? document.body;
  const el = document.createElement("session-view");
  el.setAttribute("session-id", id);
  el.hidden = true;
  // Insert before the input form so the form stays at the bottom of the flex column.
  parent.insertBefore(el, form ?? null);
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

// Auto-tab any session that becomes active so URL/popstate navigation
// surfaces in the strip. peek() openTabs so removing a tab doesn't re-fire
// this and resurrect the closed entry.
effect(() => {
  const id = activeSessionId.value;
  if (id && !openTabs.peek().includes(id)) {
    openTabs.value = [...openTabs.peek(), id];
  }
});

const LS_OPEN_TABS = "ash.open-tabs";
const isValidId = (s) => typeof s === "string" && /^[0-9a-f]{4,32}$/i.test(s);

// whenDefined resolves once session-view.js calls customElements.define, and
// the initial <session-view> upgrades + registers synchronously as part of
// that call — so by the time .then runs, the URL session is already in
// `sessions`. The persist effect installs after restore to avoid clobbering
// the stored value with the empty pre-restore state.
customElements.whenDefined("session-view").then(() => {
  try {
    const raw = sessionStorage.getItem(LS_OPEN_TABS);
    if (raw) {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) {
        const restored = ids.filter(isValidId);
        for (const id of restored) {
          if (!sessions.has(id)) preloadSession(id);
        }
        const current = openTabs.peek();
        const merged = [...restored];
        for (const id of current) if (!merged.includes(id)) merged.push(id);
        openTabs.value = merged;
      }
    }
  } catch {}
  effect(() => {
    try { sessionStorage.setItem(LS_OPEN_TABS, JSON.stringify(openTabs.value)); } catch {}
  });
});

window.__ash = { preload: preloadSession, switchTo, sessions, activeSessionId, openTabs, openTab, closeTab };
