import { escape } from "./utils.js";
import { state, homeDir, headerTopic, headerCwd } from "./state.js";
import { signal, effect } from "../vendor/signals-core.js";
import { activeSessionId, switchTo, spaEnabled, sessions, openTabs, closeTab, setSessionKind } from "./session-manager.js";
import { t } from "./i18n.js";

const sessionList = document.getElementById("sessions");
const workspaceList = document.getElementById("workspaces");
const terminalList = document.getElementById("terminals");
const viewButtons = document.querySelectorAll(".sidebar-view-btn");
const VIEWS = new Set(["sessions", "workspaces", "terminals"]);
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

const renderSessionItem = (s) => {
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
  const isRemote = s.host && s.host !== "local";
  const hostTag = isRemote ? `<span class="session-host" title="${escape(s.host)}">${escape(s.host)}</span>` : "";
  a.innerHTML = `<span class="session-title" title="${title}">${hostTag}${title}</span><span class="session-meta">${cwdText}${timeText}</span>`;
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
    const fullHash = JSON.stringify(list.map((s) => [
      s.instanceId, s.title, s.cwd, s.startedAt, s.isProcessing, s.hasUnread, s.kind ?? "agent",
    ]));
    if (fullHash === fullSessionsHash) return;
    fullSessionsHash = fullHash;
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
    if (hash === sessionsHash) return;
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

effect(() => {
  const view = sidebarView.value;
  if (sessionList) sessionList.hidden = view !== "sessions";
  if (workspaceList) workspaceList.hidden = view !== "workspaces";
  if (terminalList) terminalList.hidden = view !== "terminals";
  for (const btn of viewButtons) {
    btn.classList.toggle("current", btn.dataset.view === view);
  }
});

effect(() => {
  sessionsTick.value;
  const v = sidebarView.value;
  if (v === "workspaces") renderWorkspaces();
  else if (v === "terminals") renderTerminals();
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

async function fetchHosts() {
  try {
    const r = await fetch("/api/hosts");
    if (!r.ok) return [{ id: "local", label: "local", local: true }];
    const j = await r.json();
    return Array.isArray(j.hosts) ? j.hosts : [];
  } catch {
    return [{ id: "local", label: "local", local: true }];
  }
}

function openPickerOverlay() {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,0.4)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: "9999",
  });
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    background: "var(--bg, #1e1e1e)", color: "var(--fg, #eaeaea)",
    padding: "16px 18px", borderRadius: "8px", minWidth: "280px",
    boxShadow: "0 4px 24px rgba(0,0,0,0.5)", fontSize: "14px",
  });
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  return { overlay, panel };
}

// Resolves to { hostId, cwd } where cwd is undefined for local (caller uses
// pickDirectory), or set when the user picked a remote host and supplied a
// path.  Resolves null on cancel.
function pickHostAndCwd(hosts) {
  return new Promise((resolve) => {
    if (hosts.length <= 1) { resolve({ hostId: hosts[0]?.id ?? "local" }); return; }
    const { overlay, panel } = openPickerOverlay();

    const renderHostList = () => {
      panel.innerHTML = "";
      const title = document.createElement("div");
      title.textContent = "Spawn on";
      Object.assign(title.style, { marginBottom: "12px", fontWeight: "600" });
      panel.appendChild(title);
      for (const h of hosts) {
        const btn = document.createElement("button");
        btn.textContent = h.label + (h.local ? "" : `  (${h.id})`);
        Object.assign(btn.style, {
          display: "block", width: "100%", textAlign: "left",
          padding: "8px 10px", marginBottom: "6px", borderRadius: "4px",
          border: "1px solid var(--border, #444)", background: "transparent", color: "inherit",
          cursor: "pointer", fontSize: "13px",
        });
        btn.addEventListener("click", () => {
          if (h.local) { overlay.remove(); resolve({ hostId: h.id }); }
          else renderCwdStep(h);
        });
        panel.appendChild(btn);
      }
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      Object.assign(cancel.style, {
        marginTop: "6px", padding: "6px 10px", borderRadius: "4px",
        border: "1px solid var(--border, #444)", background: "transparent", color: "inherit",
        cursor: "pointer", fontSize: "12px",
      });
      cancel.addEventListener("click", () => { overlay.remove(); resolve(null); });
      panel.appendChild(cancel);
    };

    const renderCwdStep = (host) => {
      panel.innerHTML = "";
      const title = document.createElement("div");
      title.textContent = `Spawn on ${host.label}`;
      Object.assign(title.style, { marginBottom: "10px", fontWeight: "600" });
      panel.appendChild(title);

      // Readiness banner — populated async after panel renders.
      const banner = document.createElement("div");
      Object.assign(banner.style, {
        fontSize: "12px", padding: "8px 10px", borderRadius: "4px",
        marginBottom: "10px", display: "none",
      });
      panel.appendChild(banner);
      const showBanner = (text, kind) => {
        banner.style.display = "block";
        banner.style.background = kind === "warn" ? "rgba(255,180,0,0.15)" : "rgba(0,200,120,0.12)";
        banner.style.border = `1px solid ${kind === "warn" ? "rgba(255,180,0,0.4)" : "rgba(0,200,120,0.35)"}`;
        banner.textContent = "";
        const span = document.createElement("span");
        span.textContent = text;
        banner.appendChild(span);
        return banner;
      };
      const checkAndRenderReadiness = async () => {
        try {
          const r = await fetch(`/api/hosts/${encodeURIComponent(host.id)}/status`);
          if (!r.ok) return;
          const j = await r.json();
          const ready = j.readiness;
          if (!ready) return;
          if (ready.keys && ready.providers) {
            showBanner("Remote config ready.", "ok");
            return;
          }
          const missing = [];
          if (!ready.keys) missing.push("keys.json");
          if (!ready.providers) missing.push("providers");
          showBanner(`Missing on remote: ${missing.join(", ")}.`, "warn");
          const push = document.createElement("button");
          push.textContent = "Push from local";
          Object.assign(push.style, {
            marginLeft: "8px", padding: "3px 8px", borderRadius: "3px",
            border: "1px solid var(--border, #444)", background: "transparent", color: "inherit",
            cursor: "pointer", fontSize: "11px",
          });
          push.addEventListener("click", async () => {
            push.disabled = true; push.textContent = "Pushing…";
            try {
              const pr = await fetch(`/api/hosts/${encodeURIComponent(host.id)}/bootstrap`, { method: "POST" });
              if (!pr.ok) { showBanner(`Push failed: ${await pr.text()}`, "warn"); return; }
              const pj = await pr.json();
              const r2 = pj.readiness;
              if (r2?.keys && r2?.providers) showBanner("Pushed. Remote config ready.", "ok");
              else showBanner(`Pushed; still missing: ${[!r2?.keys && "keys.json", !r2?.providers && "providers"].filter(Boolean).join(", ")}`, "warn");
            } catch (e) {
              showBanner(`Push failed: ${e?.message ?? e}`, "warn");
            } finally {
              push.disabled = false;
            }
          });
          banner.appendChild(push);
        } catch { /* probe failure is non-fatal */ }
      };

      const label = document.createElement("div");
      label.textContent = "Remote working directory:";
      Object.assign(label.style, { fontSize: "12px", opacity: "0.7", marginBottom: "6px" });
      panel.appendChild(label);
      const input = document.createElement("input");
      input.type = "text";
      input.value = "~";
      Object.assign(input.style, {
        display: "block", width: "100%", boxSizing: "border-box",
        padding: "6px 8px", borderRadius: "4px", marginBottom: "10px",
        border: "1px solid var(--border, #444)", background: "rgba(0,0,0,0.25)",
        color: "inherit", fontSize: "13px", fontFamily: "monospace",
      });
      panel.appendChild(input);
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "6px", justifyContent: "flex-end" });
      const back = document.createElement("button");
      back.textContent = "Back";
      Object.assign(back.style, {
        padding: "6px 10px", borderRadius: "4px",
        border: "1px solid var(--border, #444)", background: "transparent", color: "inherit",
        cursor: "pointer", fontSize: "12px",
      });
      back.addEventListener("click", renderHostList);
      const spawn = document.createElement("button");
      spawn.textContent = "Spawn";
      Object.assign(spawn.style, {
        padding: "6px 14px", borderRadius: "4px",
        border: "1px solid var(--accent, #6090e0)", background: "var(--accent, #6090e0)", color: "white",
        cursor: "pointer", fontSize: "12px", fontWeight: "600",
      });
      const submit = () => {
        const cwd = input.value.trim();
        if (!cwd) return;
        overlay.remove();
        resolve({ hostId: host.id, cwd });
      };
      spawn.addEventListener("click", submit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") submit();
        else if (ev.key === "Escape") { overlay.remove(); resolve(null); }
      });
      row.appendChild(back);
      row.appendChild(spawn);
      panel.appendChild(row);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      void checkAndRenderReadiness();
    };

    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    renderHostList();
  });
}

newBtn?.addEventListener("click", async () => {
  newBtn.disabled = true;
  try {
    const hosts = await fetchHosts();
    const picked = await pickHostAndCwd(hosts);
    if (!picked) return;
    const hostId = picked.hostId;
    const isLocal = hostId === "local";

    let cwd = null;
    if (isLocal) {
      if (window.electronAPI?.pickDirectory) {
        const data = await window.electronAPI.pickDirectory();
        if (data.cancelled || !data.cwd) return;
        cwd = data.cwd;
      } else {
        const r = await fetch("/pick-dir");
        if (!r.ok) return;
        const data = await r.json();
        if (!data.cwd || data.cancelled) return;
        cwd = data.cwd;
      }
    } else {
      cwd = picked.cwd;
    }

    try {
      const body = isLocal ? { cwd } : { cwd, host: hostId };
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

