import { escape } from "./utils.js";
import { sessionId, state } from "./state.js";
import { attachAutocomplete } from "./autocomplete.js";
import { switchTo } from "./session-switcher.js";
import { t } from "./i18n.js";

const sessionList = document.getElementById("sessions");
const sessionTopic = document.getElementById("session-topic");
const sessionCwdMeta = document.getElementById("session-cwd-meta");
const newForm = document.getElementById("new-session-form");
const newCwd = document.getElementById("new-session-cwd");
const newErr = document.getElementById("new-session-err");
const newBtn = document.getElementById("new-session");

export const setSessionTopic = (title) => {
  if (!sessionTopic) return;
  sessionTopic.textContent = title ?? "";
  sessionTopic.dataset.empty = t("untitled");
};

const homeRelativeCwd = (cwd) => {
  if (!cwd) return "";
  if (state.homeDir && cwd.startsWith(state.homeDir)) return "~" + cwd.slice(state.homeDir.length);
  return cwd;
};

export const setSessionCwd = (cwd) => {
  if (!sessionCwdMeta) return;
  sessionCwdMeta.textContent = homeRelativeCwd(cwd);
  if (cwd) sessionCwdMeta.title = cwd;
};

const LS_LAST_CWD = "ash.last-cwd";

let sessionsHash = "";

const shortenCwd = (cwd) => {
  if (!cwd) return "";
  let path = cwd;
  if (state.homeDir && path.startsWith(state.homeDir)) path = "~" + path.slice(state.homeDir.length);
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
 * Update the status indicator on the current session's tab.
 * Called from sse.js on processing-start / processing-done.
 */
export const setCurrentSessionStatus = (status) => {
  const items = sessionList.querySelectorAll("li");
  for (const li of items) {
    if (li.classList.contains("current")) {
      // Remove all status classes first
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

const renderSessions = async () => {
  try {
    const res = await fetch("/sessions");
    const list = await res.json();
    const hash = JSON.stringify(list);
    if (hash === sessionsHash) return;  // 5s poll: skip rebuild when nothing changed
    sessionsHash = hash;
    if (!state.homeDir && list[0]?.cwd) {
      const m = list[0].cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
      if (m) state.homeDir = m[1];
    }
    sessionList.innerHTML = "";
    const buckets = new Map();
    for (const s of list) {
      const k = bucketKey(s.lastModified ?? s.startedAt);
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
      for (const s of items) renderSessionItem(s);
    }
  } catch {}
};

const renderSessionItem = (s) => {
  const li = document.createElement("li");
  const isCurrent = s.instanceId === sessionId;
  if (isCurrent) {
    li.className = "current";
    setSessionTopic(s.title);
    setSessionCwd(s.cwd);
  }
  if (s.isProcessing) li.classList.add("session-streaming");
  else if (s.hasUnread) li.classList.add("session-unread");

  const a = document.createElement("a");
  a.href = `/${s.instanceId}/`;
  a.addEventListener("click", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    if (s.instanceId === sessionId) return;
    switchTo(s.instanceId);
  });
  const title = escape(s.title || t("untitled"));
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
    if (s.instanceId === sessionId) {
      window.location.href = "/";
    } else {
      renderSessions();
    }
  });
  li.appendChild(close);

  sessionList.appendChild(li);
};

renderSessions();
setInterval(renderSessions, 5000);

// Force re-render on language switch so tooltips update immediately
document.addEventListener("langchange", () => {
  sessionsHash = "";
  renderSessions();
});

// Inline update — a full re-render would clobber an in-progress title edit.
export const updateSessionTitle = (sid, title) => {
  if (!title) return;
  if (sid === sessionId) setSessionTopic(title);
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
