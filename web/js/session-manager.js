import { signal, computed, effect } from "../vendor/signals-core.js";

export const sessions = new Map();
export const sessionKinds = new Map();
export const activeSessionId = signal("");

export const setSessionKind = (id, kind) => {
  if (!id || !kind) return;
  sessionKinds.set(id, kind);
};

export const activeSession = computed(() => {
  const id = activeSessionId.value;
  return id ? sessions.get(id) ?? null : null;
});

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
  // Agent sessions keep their backend (sidebar bookmark); terminals die with the tab.
  sessions.get(id)?.remove();
  const kind = sessionKinds.get(id);
  if (kind === "terminal" || kind === "ash-terminal") {
    sessionKinds.delete(id);
    fetch(`/${id}/`, { method: "DELETE" }).catch(() => {});
  }
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
  const kind = active ? sessionKinds.get(active) : null;
  document.querySelector(".app")?.classList.toggle("terminal-active", kind === "terminal" || kind === "ash-terminal");
  // Restore input focus after session switch (needed on Windows where
  // the textarea can lose its editable state during DOM toggling).
  if (active) {
    const input = document.getElementById("query");
    if (input && document.activeElement !== input) {
      setTimeout(() => input.focus(), 0);
    }
  }
});

export const globalConnState = signal(
  /** @type {"connecting"|"connected"|"reconnecting"|"nosession"} */ ("nosession"),
);

const subState = new Map();
let es = null;
let reopenScheduled = false;
let lastSeenId = 0;

const TAIL = { fresh: "all", ready: "0", resync: "100" };
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

export const pauseSSE = () => {
  es?.close();
  es = null;
  globalConnState.value = "reconnecting";
};

export const resumeSSE = () => {
  if (es) return; // already connected
  if (subState.size === 0) return;
  scheduleReopen();
};

export const preloadSession = (id, kind) => {
  if (!id) throw new Error("preloadSession: id required");
  if (sessions.has(id)) return sessions.get(id);
  const resolvedKind = kind ?? sessionKinds.get(id) ?? "agent";
  const terminal = document.querySelector(".terminal");
  const form = terminal?.querySelector(".live-input");
  const parent = terminal ?? document.body;
  const tag = (resolvedKind === "terminal" || resolvedKind === "ash-terminal") ? "terminal-view" : "session-view";
  const el = document.createElement(tag);
  el.setAttribute("session-id", id);
  el.hidden = true;
  parent.insertBefore(el, form ?? null);
  return el;
};

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

// Auto-tab the active session. peek() so removing a tab doesn't resurrect it.
effect(() => {
  const id = activeSessionId.value;
  if (id && !openTabs.peek().includes(id)) {
    openTabs.value = [...openTabs.peek(), id];
  }
});

const LS_OPEN_TABS = "ash.open-tabs";
const isValidId = (s) => typeof s === "string" && /^[0-9a-f]{4,32}$/i.test(s);

const fetchSessionKinds = fetch("/sessions")
  .then((r) => r.ok ? r.json() : [])
  .then((list) => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (s?.instanceId) sessionKinds.set(s.instanceId, s.kind ?? "agent");
    }
  })
  .catch(() => {});

Promise.all([
  customElements.whenDefined("session-view"),
  customElements.whenDefined("terminal-view"),
  fetchSessionKinds,
]).then(() => {
  const urlId = (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1];
  if (urlId && !sessions.has(urlId)) {
    preloadSession(urlId);
    activeSessionId.value = urlId;
  }
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
