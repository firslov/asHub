import { effect } from "../vendor/signals-core.js";
import { activeSessionId, openTabs, openTab, closeTab } from "./session-manager.js";
import { sessionInfo, sessionsTick } from "./sidebar.js";
import { t } from "./i18n.js";
import { escape } from "./utils.js";

const strip = document.getElementById("session-tabs");
const app = document.querySelector(".app");

const labelFor = (id) => {
  const meta = sessionInfo.get(id);
  if (meta?.title && meta.title !== id) return meta.title;
  return t("untitled");
};

let dragId = null;
let editingId = null;

const startRename = (btn, id) => {
  const labelEl = btn.querySelector(".session-tab-label");
  if (!labelEl || editingId) return;
  editingId = id;
  const current = labelEl.textContent ?? "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-tab-rename";
  input.value = current;
  input.maxLength = 100;
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  const finish = async (commit) => {
    if (editingId !== id) return;
    editingId = null;
    const val = input.value.trim();
    const shouldSave = commit && val && val !== current;
    if (shouldSave) {
      const meta = sessionInfo.get(id);
      if (meta) meta.title = val;
    }
    render();
    if (shouldSave) {
      try {
        await fetch(`/${id}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: val }),
        });
      } catch {}
    }
  };

  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
};

const clearDropMarks = () => {
  for (const el of strip?.querySelectorAll(".session-tab") ?? []) {
    el.classList.remove("drop-before", "drop-after");
  }
};

const reorder = (sourceId, targetId, side) => {
  if (!sourceId || sourceId === targetId) return;
  const order = openTabs.peek().slice();
  const from = order.indexOf(sourceId);
  if (from < 0) return;
  order.splice(from, 1);
  const to = order.indexOf(targetId);
  if (to < 0) return;
  order.splice(side === "after" ? to + 1 : to, 0, sourceId);
  openTabs.value = order;
};

const render = () => {
  if (!strip) return;
  const tabs = openTabs.value;
  const active = activeSessionId.value;
  sessionsTick.value;  // signal subscription — re-render on title/cwd updates
  if (editingId) return;  // don't clobber an in-progress rename

  strip.hidden = tabs.length === 0 || app?.dataset.uiTabsEnabled !== "true";
  strip.innerHTML = "";
  for (const id of tabs) {
    const btn = document.createElement("button");
    btn.className = "session-tab";
    btn.type = "button";
    btn.role = "tab";
    btn.dataset.sessionId = id;
    if (id === active) btn.classList.add("active");
    const label = escape(labelFor(id));
    btn.innerHTML = `<span class="session-tab-label" title="${label}">${label}</span>`;

    const close = document.createElement("span");
    close.className = "session-tab-close";
    close.title = t("close");
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeTab(id);
    });
    btn.appendChild(close);

    btn.addEventListener("click", () => openTab(id));
    btn.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      startRename(btn, id);
    });
    btn.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        closeTab(id);
      }
    });

    btn.draggable = true;
    btn.addEventListener("dragstart", (ev) => {
      dragId = id;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", id);
      btn.classList.add("dragging");
    });
    btn.addEventListener("dragend", (ev) => {
      const torn = dragId;
      dragId = null;
      btn.classList.remove("dragging");
      clearDropMarks();
      if (!torn || ev.dataTransfer.dropEffect !== "none") return;
      const sx = ev.screenX, sy = ev.screenY;
      const wx = window.screenX, wy = window.screenY;
      const ww = window.outerWidth, wh = window.outerHeight;
      const outside = sx < wx || sx > wx + ww || sy < wy || sy > wy + wh;
      if (!outside) return;
      if (openTabs.peek().length <= 1) return;  // tearing out the only tab would orphan the window
      const api = window.electronAPI;
      if (!api?.openSessionWindow) return;
      api.openSessionWindow(torn, { x: sx, y: sy }).then((res) => {
        if (res?.ok) closeTab(torn);
      });
    });
    btn.addEventListener("dragover", (ev) => {
      if (!dragId || dragId === id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const rect = btn.getBoundingClientRect();
      const after = ev.clientX > rect.left + rect.width / 2;
      btn.classList.toggle("drop-after", after);
      btn.classList.toggle("drop-before", !after);
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("drop-before", "drop-after");
    });
    btn.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const after = btn.classList.contains("drop-after");
      btn.classList.remove("drop-before", "drop-after");
      reorder(dragId, id, after ? "after" : "before");
    });

    strip.appendChild(btn);
  }
};

effect(render);

// The pref attr lands after the /api/config fetch resolves, post-render.
new MutationObserver(render).observe(app, {
  attributes: true,
  attributeFilter: ["data-ui-tabs-enabled"],
});
