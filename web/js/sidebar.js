import { escape } from "./utils.js";
import { state, homeDir, headerTopic, headerCwd } from "./state.js";
import { signal, effect } from "../vendor/signals-core.js";
import { activeSessionId, switchTo, spaEnabled, sessions, openTabs, closeTab, setSessionKind } from "./session-manager.js";
import { attachAutocomplete } from "./autocomplete.js";
import { t } from "./i18n.js";

const sessionList = document.getElementById("sessions");
const workspaceList = document.getElementById("workspaces");
const viewButtons = document.querySelectorAll(".sidebar-view-btn");
const sessionTopic = document.getElementById("session-topic");
const sessionCwdMeta = document.getElementById("session-cwd-meta");
const newForm = document.getElementById("new-session-form");
const newCwd = document.getElementById("new-session-cwd");
const newErr = document.getElementById("new-session-err");
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

const LS_LAST_CWD = "ash.last-cwd";
const LS_SIDEBAR_VIEW = "ash.sidebar-view";
const LS_WORKSPACE_COLLAPSED = "ash.workspace-collapsed";

let sessionsHash = "";
let workspacesHash = "";

// Shared with tabs.js so the strip can label tabs off the same poll.
export const sessionInfo = new Map();
export const sessionsTick = signal(0);

const initialView = (() => {
  try {
    const v = localStorage.getItem(LS_SIDEBAR_VIEW);
    return v === "workspaces" ? "workspaces" : "sessions";
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

const renderSessionItem = (s) => {
  const li = document.createElement("li");
  li.dataset.sessionId = s.instanceId;
  const isCurrent = s.instanceId === activeSessionId.peek();
  const hasTitle = s.title && s.title !== s.instanceId;
  if (isCurrent) {
    li.className = "current";
    setSessionTopic(hasTitle ? s.title : "");
    setSessionCwd(s.cwd);
  }
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

  sessionList.appendChild(li);
  return li;
};

const renderSessions = async () => {
  try {
    const res = await fetch("/sessions");
    const list = await res.json();
    sessionInfo.clear();
    for (const s of list) {
      sessionInfo.set(s.instanceId, s);
      setSessionKind(s.instanceId, s.kind ?? "agent");
    }
    sessionsTick.value = sessionsTick.peek() + 1;
    const agents = list.filter((s) => (s.kind ?? "agent") === "agent");
    const hash = JSON.stringify(agents.map((s) => [
      s.instanceId, s.title, s.cwd, s.startedAt, s.isProcessing, s.hasUnread,
    ]));
    if (hash === sessionsHash) return;  // 5s poll: skip rebuild when nothing changed
    const isFirstRender = sessionsHash === "";
    sessionsHash = hash;
    if (!homeDir.value && agents[0]?.cwd) {
      const m = agents[0].cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
      if (m) homeDir.value = m[1];
    }
    sessionList.innerHTML = "";
    const buckets = new Map();
    for (const s of agents) {
      const k = bucketKey(s.startedAt);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(s);
    }
    for (const k of BUCKET_ORDER) {
      const items = buckets.get(k);
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
  const all = [...sessionInfo.values()];
  const buckets = new Map();
  for (const s of all) {
    const key = s.cwd || "(no cwd)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }
  const groups = [...buckets.entries()].map(([cwd, items]) => {
    items.sort((a, b) => {
      const ak = (a.kind ?? "agent") === "terminal" ? 0 : 1;
      const bk = (b.kind ?? "agent") === "terminal" ? 0 : 1;
      if (ak !== bk) return ak - bk;
      return (b.lastModified ?? b.startedAt ?? 0) - (a.lastModified ?? a.startedAt ?? 0);
    });
    const lastModified = Math.max(...items.map((s) => s.lastModified ?? s.startedAt ?? 0));
    return { cwd, items, lastModified };
  });
  groups.sort((a, b) => b.lastModified - a.lastModified);

  const hash = JSON.stringify(groups.map((g) => [
    g.cwd, g.items.map((s) => [s.instanceId, s.title, s.kind, s.isProcessing, s.hasUnread]),
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
    const terms = g.items.filter((s) => (s.kind ?? "agent") === "terminal").length;
    const ags = g.items.length - terms;
    count.textContent = `${ags}a${terms ? ` · ${terms}t` : ""}`;
    head.appendChild(count);

    const actions = document.createElement("span");
    actions.className = "workspace-actions";
    const mkAction = (label, title, kind) => {
      const b = document.createElement("button");
      b.className = "workspace-action";
      b.title = title;
      b.textContent = label;
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const res = await fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: g.cwd, kind }),
        });
        if (!res.ok) return;
        const sess = await res.json();
        if (sess.instanceId) {
          setSessionKind(sess.instanceId, kind);
          window.location.href = `/${sess.instanceId}/`;
        }
      });
      return b;
    };
    actions.appendChild(mkAction("❯", "Open shell here", "terminal"));
    actions.appendChild(mkAction("+", "New agent here", "agent"));
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
      const kind = s.kind ?? "agent";
      const child = document.createElement("li");
      child.dataset.sessionId = s.instanceId;
      child.className = `kind-${kind}`;
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
        `<span class="workspace-child-kind">${kind === "terminal" ? "❯" : "◆"}</span>` +
        `<span class="workspace-child-title" title="${escape(titleText)}">${escape(titleText)}</span>`;
      child.appendChild(a);
      children.appendChild(child);
    }
    li.appendChild(children);

    workspaceList.appendChild(li);
  }
};

for (const btn of viewButtons) {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    if (v !== "sessions" && v !== "workspaces") return;
    sidebarView.value = v;
    try { localStorage.setItem(LS_SIDEBAR_VIEW, v); } catch {}
  });
}

effect(() => {
  const view = sidebarView.value;
  if (sessionList) sessionList.hidden = view !== "sessions";
  if (workspaceList) workspaceList.hidden = view !== "workspaces";
  for (const btn of viewButtons) {
    btn.classList.toggle("current", btn.dataset.view === view);
  }
});

effect(() => {
  sessionsTick.value;
  if (sidebarView.value === "workspaces") {
    workspacesHash = "";
    renderWorkspaces();
  }
});

effect(() => {
  const active = activeSessionId.value;
  if (!workspaceList) return;
  for (const li of workspaceList.querySelectorAll("li[data-session-id]")) {
    li.classList.toggle("current", li.dataset.sessionId === active);
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

// Force re-render on language switch so tooltips update immediately
document.addEventListener("langchange", () => {
  sessionsHash = "";
  renderSessions();
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

const cwdAc = attachAutocomplete({
  inputEl: newCwd,
  listEl: document.getElementById("cwd-autocomplete"),
  shouldOpen: (b) => b.length > 0,
  fetcher: async (buffer) => {
    const r = await fetch(`/fs?prefix=${encodeURIComponent(buffer)}`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.items;
  },
  accept: (it) => { newCwd.value = it.name; },
});

const closeNewForm = () => {
  if (!newForm) return;
  newForm.hidden = true;
  newErr.hidden = true;
  newCwd.value = "";
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
        if (newErr) { newErr.textContent = text || `failed (${res.status})`; newErr.hidden = false; newForm.hidden = false; }
        return;
      }
      const sess = await res.json();
      try { localStorage.setItem(LS_LAST_CWD, cwd); } catch {}
      if (sess.instanceId) window.location.href = `/${sess.instanceId}/`;
    } catch (e) {
      if (newErr) { newErr.textContent = String(e?.message ?? e); newErr.hidden = false; newForm.hidden = false; }
    }
  } catch {
  } finally {
    newBtn.disabled = false;
  }
});

newTerminalBtn?.addEventListener("click", async () => {
  newTerminalBtn.disabled = true;
  try {
    let cwd = null;
    try { cwd = localStorage.getItem(LS_LAST_CWD); } catch {}
    const body = cwd ? { cwd, kind: "terminal" } : { kind: "terminal" };
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return;
    const sess = await res.json();
    if (sess.instanceId) {
      setSessionKind(sess.instanceId, "terminal");
      window.location.href = `/${sess.instanceId}/`;
    }
  } finally {
    newTerminalBtn.disabled = false;
  }
});

newCwd?.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeNewForm();
  }
});

newForm?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (cwdAc?.hasSelection()) {
    cwdAc.acceptCurrent();
    return;
  }
  const cwd = newCwd.value.trim();
  try {
    const res = await fetch("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cwd ? { cwd } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      newErr.textContent = text || `failed (${res.status})`;
      newErr.hidden = false;
      return;
    }
    const data = await res.json();
    if (cwd) try { localStorage.setItem(LS_LAST_CWD, cwd); } catch {}
    if (data.instanceId) window.location.href = `/${data.instanceId}/`;
  } catch (e) {
    newErr.textContent = String(e?.message ?? e);
    newErr.hidden = false;
  }
});
