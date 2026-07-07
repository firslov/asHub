import { escape } from "./utils.js";
import { state, homeDir, headerTopic, headerCwd } from "./state.js";
import { signal, effect } from "../vendor/signals-core.js";
import { activeSessionId, switchTo, spaEnabled, sessions, openTabs, closeTab, setSessionKind } from "./session-manager.js";
import { agents, getSession, setSessions, updateSession, pinnedIds, allSessions } from "./store.js";
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

let sessionsHash = "";
let workspacesHash = "";
let terminalsHash = "";
let fullHashCache = "";

export { setSessions } from "./store.js";

effect(() => {
  const id = activeSessionId.value;
  const s = id ? getSession(id) : null;
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
    // Two-click confirmation — avoids native confirm() which steals
    // OS focus on Windows and never returns it to the renderer.
    if (!close.classList.contains("confirming")) {
      close.classList.add("confirming");
      close.textContent = "?";
      close.title = t("close.session.confirm", { title: escape(s.title || t("untitled")) });
      setTimeout(() => {
        close.classList.remove("confirming");
        close.textContent = "×";
        close.title = t("close.session");
      }, 2500);
      return;
    }
    close.classList.remove("confirming");
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
        // Remove old session BEFORE switching — unregisterSession
        // clears activeSessionId in disconnectedCallback if the
        // deleted session matches.
        sessions.get(s.instanceId)?.remove();
        switchTo(nextId);
        renderSessions().then(() => {
          document.getElementById("query")?.focus();
        });
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
    if (!archiveBtn.classList.contains("confirming")) {
      archiveBtn.classList.add("confirming");
      archiveBtn.innerHTML = "?";
      archiveBtn.title = t("archive.confirm", { title: escape(s.title || t("untitled")) });
      setTimeout(() => {
        archiveBtn.classList.remove("confirming");
        archiveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
        archiveBtn.title = t("archive");
      }, 2500);
      return;
    }
    archiveBtn.classList.remove("confirming");
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

  // Change directory button
  const cwdBtn = document.createElement("button");
  cwdBtn.className = "session-cwd-btn";
  cwdBtn.title = t("change.dir");
  cwdBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  cwdBtn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    let cwd = null;
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
    if (cwd) {
      try {
        await fetch(`/${s.instanceId}/cwd`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        renderSessions();
      } catch {}
    }
  });
  li.appendChild(cwdBtn);

  sessionList.appendChild(li);
  return li;
};

  const updateSessionItemInPlace = (li, s, isPinned) => {
    const a = li.querySelector("a");
    if (a) {
      const hasTitle = s.title && s.title !== s.instanceId;
      const title = escape(hasTitle ? s.title : t("untitled"));
      const cwdText = s.cwd ? '<span class="session-cwd" title="' + escape(s.cwd) + '">' + escape(shortenCwd(s.cwd)) + '</span>' : "";
      const timeText = s.startedAt ? '<span class="session-time" title="' + escape(new Date(s.startedAt).toLocaleString()) + '">' + escape(relativeTime(s.startedAt)) + '</span>' : "";
      a.innerHTML = '<span class="session-title" title="' + title + '">' + title + '</span><span class="session-meta">' + cwdText + timeText + '</span>';
    }
    li.className = "";
    if (isPinned) li.classList.add("session-pinned");
    if (s.isProcessing) li.classList.add("session-streaming");
    else if (s.hasUnread) li.classList.add("session-unread");
    if (s.instanceId === activeSessionId.peek()) li.classList.add("current");
    li.dataset.isPinned = isPinned ? "1" : "0";

    // Sync pin button state (only updated in renderSessionItem for new DOM)
    const pinBtn = li.querySelector(".session-pin-btn");
    if (pinBtn) {
      if (isPinned) { pinBtn.classList.add("pinned"); pinBtn.title = t("unpin"); }
      else { pinBtn.classList.remove("pinned"); pinBtn.title = t("pin"); }
    }
  };

const renderSessions = async (force = false) => {
  try {
    const list = await (await fetch("/sessions")).json();
    const fullHash = JSON.stringify(list.map((s) => [
      s.instanceId, s.title, s.cwd, s.startedAt, s.isProcessing, s.hasUnread, s.kind ?? "agent",
    ]));
    if (!force && fullHash === fullHashCache) return;
    fullHashCache = fullHash;

    // Update store with fresh data
    for (const s of list) setSessionKind(s.instanceId, s.kind ?? "agent");
    setSessions(list);
    // Refresh pinned after sessions update
    try {
      const pinnedRes = await fetch("/api/sessions/pinned");
      if (pinnedRes.ok) {
        const data = await pinnedRes.json();
        if (Array.isArray(data.pinned)) pinnedIds.value = new Set(data.pinned);
      }
    } catch {}

    const agentList = list.filter((s) => (s.kind ?? "agent") === "agent");
    const pinIds = pinnedIds.peek();

    const hash = JSON.stringify(agentList.map((s) => [
      s.instanceId, s.title, s.cwd, s.startedAt, s.isProcessing, s.hasUnread,
      pinIds.has(s.instanceId),
    ]));
    if (hash === sessionsHash) return;
    const isFirstRender = sessionsHash === "";
    sessionsHash = hash;
    if (!homeDir.value && agentList[0]?.cwd) {
      const m = agentList[0].cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
      if (m) homeDir.value = m[1];
    }
    // Suppress entrance animation for non-first renders
    if (!isFirstRender) sessionList.classList.add("no-anim");

    // Build list in-place: update existing items, insert new ones, remove stale.
    // Avoids replaceChildren which causes a visible flash.
    const newIds = new Set();
    const existingItems = new Map();
    for (const li of sessionList.querySelectorAll("li[data-session-id]")) {
      existingItems.set(li.dataset.sessionId, li);
    }

    // Group items by pin-first then by time bucket
    const pinnedItems = [];
    const restByBucket = new Map();
    for (const s of agentList) {
      if (pinIds.has(s.instanceId)) {
        pinnedItems.push(s);
      } else {
        const k = bucketKey(s.startedAt);
        if (!restByBucket.has(k)) restByBucket.set(k, []);
        restByBucket.get(k).push(s);
      }
    }

    const buildOrder = [];
    if (pinnedItems.length > 0) {
      buildOrder.push({ kind: "head", text: t("pinned") });
      for (const s of pinnedItems) buildOrder.push({ kind: "item", session: s, pinned: true });
    }
    for (const k of BUCKET_ORDER) {
      const items = restByBucket.get(k);
      if (!items?.length) continue;
      buildOrder.push({ kind: "head", text: t("bucket." + k), count: items.length });
      for (const s of items) buildOrder.push({ kind: "item", session: s });
    }

    const newChildren = [];
    // Walk in order, updating or creating DOM nodes.
    // Only update display content — do NOT reorder DOM nodes
    // when only metadata (isProcessing, title) changed.
    // This prevents the visual flash of items jumping position.
    for (const entry of buildOrder) {
      if (entry.kind === "head") {
        // Group headers are always recreated (cheap, few of them)
        const head = document.createElement("li");
        head.className = "session-group-head";
        head.dataset.headerKey = entry.text;
        head.textContent = entry.text;
        if (entry.count != null) {
          const count = document.createElement("span");
          count.className = "bucket-count";
          count.textContent = String(entry.count);
          head.appendChild(count);
        }
        newChildren.push(head);
      } else {
        const s = entry.session;
        newIds.add(s.instanceId);
        const existing = existingItems.get(s.instanceId);
        if (existing) {
          updateSessionItemInPlace(existing, s, !!entry.pinned);
          newChildren.push(existing);
          existingItems.delete(s.instanceId);
        } else {
          const li = renderSessionItem(s, !!entry.pinned);
          if (isFirstRender) li.style.animationDelay = (newChildren.length * 0.02) + "s";
          newChildren.push(li);
        }
      }
    }

    // Pin toggle needs full rebuild — items change position.
    if (force) {
      sessionList.replaceChildren(...newChildren);
    } else {
      // Remove stale session items.
      for (const [, stale] of existingItems) stale.remove();

    // Reconcile group headers: reuse existing DOM nodes, only
    // insert/remove/update text when buckets actually change.
    const oldHeaders = new Map();
    for (const h of sessionList.querySelectorAll(".session-group-head")) {
      oldHeaders.set(h.dataset.headerKey || h.textContent?.trim() || "", {
        el: h,
        countEl: h.querySelector(".bucket-count"),
      });
    }

    let prevChild = null;
    for (const child of newChildren) {
      if (child.classList.contains("session-group-head")) {
        const key = child.dataset.headerKey || child.textContent?.trim() || "";
        const old = oldHeaders.get(key);
        if (old) {
          if (old.countEl) {
            const newCount = child.querySelector(".bucket-count");
            if (newCount) old.countEl.textContent = newCount.textContent;
          }
          if (prevChild) {
            sessionList.insertBefore(old.el, prevChild.nextSibling || null);
          } else {
            sessionList.insertBefore(old.el, sessionList.firstChild);
          }
          prevChild = old.el;
          oldHeaders.delete(key);
        } else {
          if (prevChild) {
            sessionList.insertBefore(child, prevChild.nextSibling || null);
          } else {
            sessionList.insertBefore(child, sessionList.firstChild);
          }
          prevChild = child;
        }
      } else {
        if (!sessionList.contains(child)) {
          if (prevChild) {
            sessionList.insertBefore(child, prevChild.nextSibling || null);
          } else {
            sessionList.insertBefore(child, sessionList.firstChild);
          }
        }
        prevChild = child;
      }
    }

    for (const [, { el }] of oldHeaders) el.remove();
    } // end incremental reconcile
  } catch {

  } finally {
    if (sessionList) sessionList.classList.remove("no-anim");
  }
};

const renderWorkspaces = () => {
  if (!workspaceList) return;
  const agentList = agents.value;
  if (!agentList.length) return;
  const buckets = new Map();
  for (const s of agentList) {
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
  const items = allSessions.value
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
// Event-driven refresh: poll on session state changes instead of blind timer.
// SSE events (title, processing) come through session-view; we hook in via
// the sidebar's own event listeners on the document.
let _refreshQueued = false;
const queueRefresh = () => {
  if (_refreshQueued) return;
  _refreshQueued = true;
  queueMicrotask(async () => {
    _refreshQueued = false;
    renderSessions();
  });
};
// Trigger on title changes, processing start/end via SSE events.
document.addEventListener("sse:title", queueRefresh);
document.addEventListener("sse:processing-change", queueRefresh);
// Fallback: poll every 5 minutes in case SSE events were missed
setInterval(() => renderSessions(), 5 * 60 * 1000);

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
  fullHashCache = "";
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

// ── Quick-create: one-click session with default directory ─────────

const getDefaultCwd = () => {
  // Always use the user's home directory for new sessions.
  // "~" is resolved to os.homedir() by the server's expandHome().
  return "~";
};

const doCreateSession = async (cwd) => {
  if (!cwd) return;
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
};

newBtn?.addEventListener("click", () => {
  doCreateSession(getDefaultCwd());
});

newTerminalBtn?.addEventListener("click", async (ev) => {
  newTerminalBtn.disabled = true;
  try {
    const kind = (ev.metaKey || ev.ctrlKey) ? "ash-terminal" : "terminal";
    const cwd = getSession(activeSessionId.peek())?.cwd ?? null;
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

