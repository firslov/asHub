import { signal, computed } from "../vendor/signals-core.js";

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

// Construct a hidden <session-view> next to the active one. The element's
// connectedCallback opens its own EventSource and registers itself.
export const preloadSession = (id) => {
  if (!id) throw new Error("preloadSession: id required");
  if (sessions.has(id)) return sessions.get(id);
  const host = document.querySelector("session-view")?.parentElement ?? document.body;
  const el = document.createElement("session-view");
  el.setAttribute("session-id", id);
  el.hidden = true;
  host.appendChild(el);
  return el;
};

window.__ash = { preload: preloadSession, sessions, activeSessionId };
