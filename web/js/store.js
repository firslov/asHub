import { signal, computed } from "../vendor/signals-core.js";

// ── Single source of truth ─────────────────────────────────────────────
// All session metadata lives here. Modules read from store instead of
// maintaining local copies or polling /sessions.

export const activeSessionId = signal("");
export const sidebarView = signal("sessions");
export const openTabs = signal([]);
export const pinnedIds = signal(new Set());

const _sessions = signal(new Map());

// Reactive list — recomputes when _sessions or activeSessionId changes.
export const activeSessionMeta = computed(() =>
  activeSessionId.value ? (_sessions.value.get(activeSessionId.value) ?? null) : null
);

// All agent sessions (non-terminal), sorted by server order.
export const agents = computed(() =>
  [..._sessions.value.values()].filter(s => (s.kind ?? "agent") === "agent")
);

// All sessions including terminals.
export const allSessions = computed(() =>
  [..._sessions.value.values()]
);

// ── Mutations ──────────────────────────────────────────────────────────

export const setSessions = (list) => {
  const next = new Map();
  for (const s of list) next.set(s.instanceId, s);
  _sessions.value = next;
};

export const updateSession = (id, patch) => {
  const cur = _sessions.value;
  if (!cur.has(id)) return;
  const next = new Map(cur);
  next.set(id, { ...cur.get(id), ...patch });
  _sessions.value = next;
};

export const getSession = (id) => _sessions.value.get(id) ?? null;

// Force signal tick (re-renders subscribers). Only needed for mutations
// that don't replace the Map (e.g. changing a nested property in-place).
// Prefer setSessions/updateSession which replace the Map reference.
export const bump = () => {
  _sessions.value = new Map(_sessions.value);
};

// Poll /sessions and update the store. Returns the parsed list.
export const refreshSessions = async () => {
  try {
    const res = await fetch("/sessions");
    if (!res.ok) return;
    const list = await res.json();
    setSessions(list);
    // Also refresh pinned ids
    try {
      const pinnedRes = await fetch("/api/sessions/pinned");
      if (pinnedRes.ok) {
        const data = await pinnedRes.json();
        if (Array.isArray(data.pinned)) pinnedIds.value = new Set(data.pinned);
      }
    } catch {}
    return list;
  } catch {}
};
