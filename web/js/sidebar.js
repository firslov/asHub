import { escape } from "./utils.js";
import { state, homeDir, headerTopic, headerCwd } from "./state.js";
import { signal, effect } from "../vendor/signals-core.js";
import { activeSessionId, switchTo, spaEnabled, sessions, openTabs, closeTab, setSessionKind } from "./session-manager.js";
import { t } from "./i18n.js";

const sessionList = document.getElementById("sessions");
const workspaceList = document.getElementById("workspaces");
const terminalList = document.getElementById("terminals");
const viewButtons = document.querySelectorAll(".sidebar-view-btn");
const VIEWS = new Set(["sessions", "workspaces", "terminals", "archive"]);
const sessionTopic = document.getElementById("session-topic");
const sessionCwdMeta = document.getElementById("session-cwd-meta");
const newBtn = document.getElementById("new-session");
const newTerminalBtn = document.getElementById("new-terminal");

export const setSessionTopic = (title) => { headerTopic.value = title ?? ""; };
export const setSessionCwd = (cwd) => { headerCwd.value = cwd ?? ""; };

const homeRelativeCwd = (cwd) => {
  if (!cwd) return "";
  const home = homeDir.value;
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
};

if (sessionTopic) {
  effect(() => {
    sessionTopic.textContent = headerTopic.value;
    sessionTopic.dataset.empty = t("untitled");
  });
}

if (sessionCwdMeta) {
  effect(() => {
    const cwd = headerCwd.value;
    sessionCwdMeta.textContent = homeRelativeCwd(cwd);
    if (cwd) sessionCwdMeta.title = cwd;
  });
}

const LS_SIDEBAR_VIEW = "ash.sidebar-view";
const LS_WORKSPACE_COLLAPSED = "ash.workspace-collapsed";

let fullSessionsHash = "";
let sessionsHash = "";
let workspacesHash = "";
let terminalsHash = "";

export const sessionInfo = new Map();
export const sessionsTick = signal(0);

effect(() => {
  const id = activeSessionId.value;
  sessionsTick.value;
  const s = id ? sessionInfo.get(id) : null;
  if (!s) return;
  const hasTitle = s.title && s.title !== s.instanceId;
  setSessionTopic(hasTitle ? s.title : "");
  setSessionCwd(s.cwd);
});

const initialView = (() => {
  try {
    const v = localStorage.getItem(LS_SIDEBAR_VIEW);
    return VIEWS.has(v) ? v : "sessions";
  } catch { return "sessions"; }
})();
export const sidebarView = signal(initialView);

const collapsedWorkspaces = (() => {
  try {
    const raw = localStorage.getItem(LS_WORKSPACE_COLLAPSED);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
})();

const persistCollapsed = () => {
  try { localStorage.setItem(LS_WORKSPACE_COLLAPSED, JSON.stringify([...collapsedWorkspaces])); } catch {}
};

const shortenCwd = (cwd) => {
  if (!cwd) return "";
  let path = cwd;
  const home = homeDir.value;
  if (home && path.startsWith(home)) path = "~" + path.slice(home.length);
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return (path.startsWith("~") ? "~/…/" : "…/") + parts.slice(-2).join("/");
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const bucketKey = (ts) => {
  if (!ts) return "older";
  const today = startOfDay(new Date());
  const day = startOfDay(new Date(ts));
  const diff = Math.floor((today - day) / 86400000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return "thisweek";
  if (diff < 30) return "thismonth";
  return "older";
};

const BUCKET_ORDER = ["today", "yesterday", "thisweek", "thismonth", "older"];

const relativeTime = (ts) => {
  if (!ts) return "";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
};

/**
 * Update the status indicator on a specific session's tab.
 * Called from sse.js on processing-start / processing-done for the
 * session that emitted the frame (which may be a background session).
 */
export const setSessionStatus = (sid, status) => {
  if (!sid) return;
  for (const li of sessionList.querySelectorAll("li")) {
    const href = li.querySelector("a")?.getAttribute("href") ?? "";
    if (href === `/${sid}/`) {
      li.classList.remove("session-streaming", "session-unread");
      if (status) li.classList.add(status);
      return;
    }
  }
};

const startTitleEdit = (li, instanceId, currentTitle) => {
  sessionList.querySelectorAll(".session-title-edit").forEach((el) => el.remove());
  sessionList.querySelectorAll(".session-title").forEach((el) => el.style.display = "");

  const titleSpan = li.querySelector(".session-title");
  if (!titleSpan) return;
  titleSpan.style.display = "none";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-title-edit";
  input.value = currentTitle;
  input.maxLength = 100;
  titleSpan.insertAdjacentElement("afterend", input);
  input.focus();
  input.select();

  const commit = async () => {
    const val = input.value.trim();
    input.remove();
    titleSpan.style.display = "";
    if (val && val !== currentTitle) {
      titleSpan.textContent = val;
      try {
        await fetch(`/${instanceId}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: val }),
        });
      } catch {}
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { input.value = currentTitle; input.blur(); }
  });
};

const renderSessionItem = (s, isPinned = false) => {
  const li = document.createElement("li");
  li.dataset.sessionId = s.instanceId;
  const isCurrent = s.instanceId === activeSessionId.peek();
  const hasTitle = s.title && s.title !== s.instanceId;
  if (isCurrent) li.className = "current";
  if (s.isProcessing) li.classList.add("session-streaming");
  else if (s.hasUnread) li.classList.add("session-unread");

  const a = document.createElement("a");
  a.href = `/${s.instanceId}/`;
  a.addEventListener("click", (ev) => {
    // Cmd/Ctrl/Shift-click → browser default (new tab/window).
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    if (spaEnabled()) {
      ev.preventDefault();
      switchTo(s.instanceId);
    } else if (s.instanceId !== activeSessionId.peek()) {
      document.body.classList.add("exiting");
    } else {
      ev.preventDefault();
    }
  });
  const title = escape(hasTitle ? s.title : t("untitled"));
  const cwdText = s.cwd ? `<span class="session-cwd" title="${escape(s.cwd)}">${escape(shortenCwd(s.cwd))}</span>` : "";
  const timeText = s.startedAt ? `<span class="session-time" title="${escape(new Date(s.startedAt).toLocaleString())}">${escape(relativeTime(s.startedAt))}</span>` : "";
  a.innerHTML = `<span class="session-title" title="${title}">${title}</span><span class="session-meta">${cwdText}${timeText}</span>`;
  li.appendChild(a);

  const statusDot = document.createElement("span");
  statusDot.className = "session-status";
  li.appendChild(statusDot);

  const editBtn = document.createElement("button");
  editBtn.className = "session-edit";
  editBtn.title = t("edit.title");
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    startTitleEdit(li, s.instanceId, s.title || "");
  });
  li.appendChild(editBtn);

  const close = document.createElement("button");
  close.className = "session-close";
  close.title = t("close.session");
  close.textContent = "×";
  close.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!confirm(t("close.session.confirm", { title: escape(s.title || t("untitled")) }))) return;
    try {
      await fetch(`/${s.instanceId}/`, { method: "DELETE" });
    } catch {}
    if (openTabs.peek().includes(s.instanceId)) closeTab(s.instanceId);
    const closingActive = s.instanceId === activeSessionId.peek();
    if (closingActive && spaEnabled()) {
      // Pick another session to land on. Prefer one we've already preloaded,
      // otherwise the first item in the sidebar that isn't being deleted.
      let nextId = null;
      for (const id of sessions.keys()) {
        if (id && id !== s.instanceId) { nextId = id; break; }
      }
      if (!nextId) {
        for (const li of sessionList.querySelectorAll("li[data-session-id]")) {
          const id = li.dataset.sessionId;
          if (id && id !== s.instanceId) { nextId = id; break; }
        }
      }
      if (nextId) {
        switchTo(nextId);
        sessions.get(s.instanceId)?.remove();
        renderSessions();
      } else {
        window.location.href = "/";
      }
    } else if (closingActive) {
      window.location.href = "/";
    } else {
      sessions.get(s.instanceId)?.remove();
      renderSessions();
    }
  });
  li.appendChild(close);

  // Archive button — moves a session to the archive list.
  const archiveBtn = document.createElement("button");
  archiveBtn.className = "session-archive-btn";
  archiveBtn.title = t("archive");
  archiveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
  archiveBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!confirm(t("archive.confirm", { title: escape(s.title || t("untitled")) }))) return;
    try {
      await fetch("/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.instanceId }),
      });
    } catch {}
    if (openTabs.peek().includes(s.instanceId)) closeTab(s.instanceId);
    sessions.get(s.instanceId)?.remove();
    renderSessions();
  });
  li.appendChild(archiveBtn);

  // Pin button — keeps session at top of list.
  const pinBtn = document.createElement("button");
  pinBtn.className = "session-pin-btn";
  pinBtn.title = t("pin");
  pinBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
  pinBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      const res = await fetch(`/${s.instanceId}/pin`);
      if (res.ok) renderSessions(true);
    } catch {}
  });
  
  // Set initial pinned state
  if (isPinned) {
    pinBtn.classList.add("pinned");
    pinBtn.title = t("unpin");
  }
  li.appendChild(pinBtn);

  sessionList.appendChild(li);
  return li;
};

const renderSessions = async (force = false) => {
  try {
    const res = await fetch("/sessions");
    const list = await res.json();
    const fullHash = JSON.stringify(list.map((s) => [
      s.instanceId, s.title, s.cwd, s.startedAt, s.isProcessing, s.hasUnread, s.kind ?? "agent",
    ]));
    if (!force && fullHash === fullSessionsHash) return;
    fullSessionsHash = fullHash;
    sessionInfo.clear();
    for (const s of list) {
      sessionInfo.set(s.instanceId, s);
      setSessionKind(s.instanceId, s.kind ?? "agent");
    }
    sessionsTick.value = sessionsTick.peek() + 1;
    const agents = list.filter((s) => (s.kind ?? "agent") === "agent");

    // Fetch pinned IDs for sorting and hash calculation
    let pinnedIds = new Set();
    try {
      const pinnedRes = await fetch("/api/sessions/pinned");
      if (pinnedRes.ok) {
        const data = await pinnedRes.json();
        if (Array.isArray(data.pinned)) pinnedIds = new Set(data.pinned);
      }
    } catch {}

    const hash = JSON.stringify(agents.map((s) => [
      s.instanceId, s.title, s.cwd, s.startedAt, s.isProcessing, s.hasUnread,
      pinnedIds.has(s.instanceId),
    ]));
    if (hash === sessionsHash) return;
    const isFirstRender = sessionsHash === "";
    sessionsHash = hash;
    if (!homeDir.value && agents[0]?.cwd) {
      const m = agents[0].cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
      if (m) homeDir.value = m[1];
    }
    sessionList.innerHTML = "";

    // Build session items grouped by pin-first then by time bucket
    const pinnedItems = [];
    const restByBucket = new Map();
    for (const s of agents) {
      if (pinnedIds.has(s.instanceId)) {
        pinnedItems.push(s);
      } else {
        const k = bucketKey(s.startedAt);
        if (!restByBucket.has(k)) restByBucket.set(k, []);
        restByBucket.get(k).push(s);
      }
    }

    // Render pinned section
    if (pinnedItems.length > 0) {
      const pinHead = document.createElement("li");
      pinHead.className = "session-group-head";
      pinHead.textContent = t("pinned");
      sessionList.appendChild(pinHead);
      for (const s of pinnedItems) {
        renderSessionItem(s, true);
      }
    }
    for (const k of BUCKET_ORDER) {
      const items = restByBucket.get(k);
      if (!items?.length) continue;
      const head = document.createElement("li");
      head.className = "session-group-head";
      head.textContent = t(`bucket.${k}`);
      sessionList.appendChild(head);
      let staggerIdx = 0;
      for (const s of items) {
        const li = renderSessionItem(s);
        if (isFirstRender) {
          li.style.animationDelay = `${staggerIdx * 0.04}s`;
        } else {
          li.style.animation = "none";
        }
        staggerIdx++;
      }
    }
  } catch {}
};

const renderWorkspaces = () => {
  if (!workspaceList) return;
  const agents = [...sessionInfo.values()].filter((s) => (s.kind ?? "agent") === "agent");
  const buckets = new Map();
  for (const s of agents) {
    const key = s.cwd || "(no cwd)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  const groups = [...buckets.entries()].map(([cwd, items]) => {
    items.sort((a, b) => (b.lastModified ?? b.startedAt ?? 0) - (a.lastModified ?? a.startedAt ?? 0));
    const lastModified = Math.max(...items.map((s) => s.lastModified ?? s.startedAt ?? 0));
    return { cwd, items, lastModified };
  });
  groups.sort((a, b) => b.lastModified - a.lastModified);

  const hash = JSON.stringify(groups.map((g) => [
    g.cwd, g.items.map((s) => [s.instanceId, s.title, s.isProcessing, s.hasUnread]),
  ]));
  if (hash === workspacesHash) return;
  workspacesHash = hash;

  workspaceList.innerHTML = "";
  for (const g of groups) {
    const li = document.createElement("li");
    li.className = "workspace-group";
    li.dataset.cwd = g.cwd;
    if (collapsedWorkspaces.has(g.cwd)) li.classList.add("collapsed");

    const head = document.createElement("div");
    head.className = "workspace-head";

    const caret = document.createElement("span");
    caret.className = "workspace-caret";
    caret.textContent = "▾";
    head.appendChild(caret);

    const pathSpan = document.createElement("span");
    pathSpan.className = "workspace-path";
    const display = shortenCwd(g.cwd);
    pathSpan.textContent = display;
    pathSpan.title = g.cwd;
    head.appendChild(pathSpan);

    const count = document.createElement("span");
    count.className = "workspace-count";
    count.textContent = String(g.items.length);
    head.appendChild(count);

    const actions = document.createElement("span");
    actions.className = "workspace-actions";
    const newBtn = document.createElement("button");
    newBtn.className = "workspace-action";
    newBtn.title = "New agent here";
    newBtn.textContent = "+";
    newBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: g.cwd, kind: "agent" }),
      });
      if (!res.ok) return;
      const sess = await res.json();
      if (sess.instanceId) {
        setSessionKind(sess.instanceId, "agent");
        window.location.href = `/${sess.instanceId}/`;
      }
    });
    actions.appendChild(newBtn);
    head.appendChild(actions);

    head.addEventListener("click", () => {
      const isCollapsed = li.classList.toggle("collapsed");
      if (isCollapsed) collapsedWorkspaces.add(g.cwd);
      else collapsedWorkspaces.delete(g.cwd);
      persistCollapsed();
    });

    li.appendChild(head);

    const children = document.createElement("ul");
    children.className = "workspace-children";
    for (const s of g.items) {
      const child = document.createElement("li");
      child.dataset.sessionId = s.instanceId;
      if (s.instanceId === activeSessionId.peek()) child.classList.add("current");
      if (s.isProcessing) child.classList.add("session-streaming");
      else if (s.hasUnread) child.classList.add("session-unread");

      const a = document.createElement("a");
      a.href = `/${s.instanceId}/`;
      a.addEventListener("click", (ev) => {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
        if (spaEnabled()) {
          ev.preventDefault();
          switchTo(s.instanceId);
        }
      });
      const hasTitle = s.title && s.title !== s.instanceId;
      const titleText = hasTitle ? s.title : t("untitled");
      a.innerHTML =
        `<span class="workspace-child-kind">◆</span>` +
        `<span class="workspace-child-title" title="${escape(titleText)}">${escape(titleText)}</span>`;
      child.appendChild(a);
      children.appendChild(child);
    }
    li.appendChild(children);

    workspaceList.appendChild(li);
  }
};

const renderTerminals = () => {
  if (!terminalList) return;
  const items = [...sessionInfo.values()]
    .filter((s) => (s.kind ?? "agent") === "terminal")
    .sort((a, b) => (b.lastModified ?? b.startedAt ?? 0) - (a.lastModified ?? a.startedAt ?? 0));

  const hash = JSON.stringify(items.map((s) => [
    s.instanceId, s.title, s.cwd, s.isProcessing,
  ]));
  if (hash === terminalsHash) return;
  terminalsHash = hash;

  terminalList.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "terminal-empty";
    empty.textContent = t("no.terminals");
    terminalList.appendChild(empty);
    return;
  }
  for (const s of items) {
    const li = document.createElement("li");
    li.dataset.sessionId = s.instanceId;
    if (s.instanceId === activeSessionId.peek()) li.classList.add("current");

    const a = document.createElement("a");
    a.href = `/${s.instanceId}/`;
    a.addEventListener("click", (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      if (spaEnabled()) { ev.preventDefault(); switchTo(s.instanceId); }
    });
    const hasTitle = s.title && s.title !== s.instanceId;
    const titleText = hasTitle ? s.title : t("untitled");
    const cwdText = s.cwd ? shortenCwd(s.cwd) : "";
    a.innerHTML =
      `<span class="terminal-kind">❯</span>` +
      `<span class="terminal-meta">` +
        `<span class="terminal-title" title="${escape(titleText)}">${escape(titleText)}</span>` +
        (cwdText ? `<span class="terminal-cwd" title="${escape(s.cwd)}">${escape(cwdText)}</span>` : "") +
      `</span>`;
    li.appendChild(a);

    const close = document.createElement("button");
    close.className = "terminal-close";
    close.title = t("close.session");
    close.textContent = "×";
    close.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!confirm(t("close.session.confirm", { title: escape(titleText) }))) return;
      try { await fetch(`/${s.instanceId}/`, { method: "DELETE" }); } catch {}
      if (openTabs.peek().includes(s.instanceId)) closeTab(s.instanceId);
      renderTerminals();
    });
    li.appendChild(close);

    terminalList.appendChild(li);
  }
};

for (const btn of viewButtons) {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    if (!VIEWS.has(v)) return;
    sidebarView.value = v;
    try { localStorage.setItem(LS_SIDEBAR_VIEW, v); } catch {}
  });
}

// ── Archive view ──────────────────────────────────────────────────────

const archiveList = document.getElementById("archive");

const renderArchive = async () => {
  if (!archiveList) return;
  try {
    const res = await fetch("/api/sessions/archived");
    if (!res.ok) return;
    const items = await res.json();
    archiveList.hidden = false;
    archiveList.innerHTML = "";
    if (!Array.isArray(items) || items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "archive-empty";
      empty.textContent = t("archive.empty");
      archiveList.appendChild(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      li.dataset.sessionId = item.id;
      li.style.cssText = "position:relative;display:flex;align-items:center;padding:0.42rem 0.7rem 0.42rem 1.5rem;cursor:pointer;border-radius:var(--radius-xs);transition:background 0.1s;min-height:36px;";

      const info = document.createElement("a");
      info.className = "session-item-link";
      info.href = `/${item.id}`;
      info.style.cssText = "flex:1;min-width:0;display:flex;align-items:center;gap:0.5rem;text-decoration:none;color:var(--text-dim);font-size:0.82rem;";
      const title = escape(item.title || t("untitled"));
      const timeText = item.startedAt
        ? `<span class="session-time">${escape(relativeTime(item.startedAt))}</span>`
        : "";
      info.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-mid);font-weight:440;font-size:0.82rem;line-height:1.3;">${title}</span>${timeText}`;
      li.appendChild(info);

      const restoreBtn = document.createElement("button");
      restoreBtn.className = "session-btn";
      restoreBtn.title = t("restore");
      restoreBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
      restoreBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          const r = await fetch("/api/sessions/unarchive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: item.id }),
          });
          if (r.ok) {
            renderArchive();
            renderSessions();
          }
        } catch {}
      });
      li.appendChild(restoreBtn);

      archiveList.appendChild(li);
    }
  } catch {}
};

effect(() => {
  const view = sidebarView.value;
  if (sessionList) sessionList.hidden = view !== "sessions";
  if (workspaceList) workspaceList.hidden = view !== "workspaces";
  if (terminalList) terminalList.hidden = view !== "terminals";
  if (archiveList) archiveList.hidden = view !== "archive";
  for (const btn of viewButtons) {
    btn.classList.toggle("current", btn.dataset.view === view);
  }
});

effect(() => {
  sessionsTick.value;
  const v = sidebarView.value;
  if (v === "workspaces") renderWorkspaces();
  else if (v === "terminals") renderTerminals();
  else if (v === "archive") renderArchive();
});

effect(() => {
  const active = activeSessionId.value;
  for (const root of [workspaceList, terminalList]) {
    if (!root) continue;
    for (const li of root.querySelectorAll("li[data-session-id]")) {
      li.classList.toggle("current", li.dataset.sessionId === active);
    }
  }
});

renderSessions();
setInterval(renderSessions, 5000);

// Toggle the .current class and sync header info on active-session change.
effect(() => {
  const active = activeSessionId.value;
  let activeLi = null;
  for (const li of sessionList.querySelectorAll("li[data-session-id]")) {
    const match = li.dataset.sessionId === active;
    li.classList.toggle("current", match);
    if (match) activeLi = li;
  }
  if (activeLi) {
    const titleSpan = activeLi.querySelector(".session-title");
    const cwdSpan = activeLi.querySelector(".session-cwd");
    setSessionTopic(titleSpan?.textContent && titleSpan.textContent !== t("untitled") ? titleSpan.textContent : "");
    setSessionCwd(cwdSpan?.title ?? "");
  }
});

// Clean up exit transition class on bfcache restore (Back button)
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) document.body.classList.remove("exiting");
});

// Force re-render on language switch so bucket headers / tooltips update.
document.addEventListener("langchange", () => {
  fullSessionsHash = "";
  sessionsHash = "";
  workspacesHash = "";
  terminalsHash = "";
  renderSessions();
  renderWorkspaces();
  renderTerminals();
});

// Inline update — a full re-render would clobber an in-progress title edit.
export const updateSessionTitle = (sid, title) => {
  if (!title) return;
  if (sid === activeSessionId.peek()) setSessionTopic(title);
  const items = sessionList.querySelectorAll("li");
  for (const li of items) {
    const a = li.querySelector("a");
    const href = a?.getAttribute("href") ?? "";
    if (href === `/${sid}/`) {
      const titleSpan = li.querySelector(".session-title");
      if (titleSpan) titleSpan.textContent = title;
      break;
    }
  }
};

newBtn?.addEventListener("click", async () => {
  newBtn.disabled = true;
  try {
    let cwd = null;
    if (window.electronAPI?.pickDirectory) {
      const data = await window.electronAPI.pickDirectory();
      if (data.cancelled || !data.cwd) { newBtn.disabled = false; return; }
      cwd = data.cwd;
    } else {
      const r = await fetch("/pick-dir");
      if (!r.ok) { newBtn.disabled = false; return; }
      const data = await r.json();
      if (!data.cwd || data.cancelled) { newBtn.disabled = false; return; }
      cwd = data.cwd;
    }
    try {
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const text = await res.text();
        alert(text || `New session failed (${res.status})`);
        return;
      }
      const sess = await res.json();
      if (sess.instanceId) window.location.href = `/${sess.instanceId}/`;
    } catch (e) {
      alert(`New session failed: ${e?.message ?? e}`);
    }
  } catch {
  } finally {
    newBtn.disabled = false;
  }
});

newTerminalBtn?.addEventListener("click", async (ev) => {
  newTerminalBtn.disabled = true;
  try {
    const kind = (ev.metaKey || ev.ctrlKey) ? "ash-terminal" : "terminal";
    const cwd = sessionInfo.get(activeSessionId.peek())?.cwd ?? null;
    const body = cwd ? { cwd, kind } : { kind };
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    const sess = await res.json();
    if (sess.instanceId) {
      setSessionKind(sess.instanceId, kind);
      window.location.href = `/${sess.instanceId}/`;
    }
  } finally {
    newTerminalBtn.disabled = false;
  }
});

