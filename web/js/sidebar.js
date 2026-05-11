import { escape } from "./utils.js";
import { sessionId, state } from "./state.js";
import { attachAutocomplete } from "./autocomplete.js";
import { switchTo } from "./session-switcher.js";
import { t } from "./i18n.js";

const sessionList = document.getElementById("sessions");
const newForm = document.getElementById("new-session-form");
const newCwd = document.getElementById("new-session-cwd");
const newErr = document.getElementById("new-session-err");
const newBtn = document.getElementById("new-session");

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
    for (const s of list) {
      const li = document.createElement("li");
      const isCurrent = s.instanceId === sessionId;
      if (isCurrent) li.className = "current";
      // Apply status indicator classes from server data
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
      const title = escape(s.title || s.instanceId);
      const modelText = s.model ? ` <span class="session-model">${escape(s.model)}</span>` : "";
      const cwdText = s.cwd ? ` <span class="session-cwd" title="${escape(s.cwd)}">${escape(shortenCwd(s.cwd))}</span>` : "";
      a.innerHTML = `<span class="session-title">${title}</span>${modelText}${cwdText}`;
      li.appendChild(a);

      // Status indicator dot
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
        startTitleEdit(li, s.instanceId, s.title || s.instanceId);
      });
      li.appendChild(editBtn);

      const close = document.createElement("button");
      close.className = "session-close";
      close.title = t("close.session");
      close.textContent = "×";
      close.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!confirm(t("close.session.confirm", { title: escape(s.title || s.instanceId) }))) return;
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
    }
  } catch {}
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
