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
let dragDropped = false;
let editingId = null;
// Non-empty string while a cross-window drag is hovering this renderer; the
// value is the label to show in the ghost placeholder.
let externalDragLabel = "";
let externalDropTargetId = null;
let externalDropSide = null;

// Transparent drag image so the OS snap-back animation has nothing to fly
// back to when the drop is handled out-of-band via Electron IPC.
const blankDragImg = new Image();
blankDragImg.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";

let previewEl = null;
const showPreview = (clientX, clientY, label) => {
  if (!previewEl) {
    previewEl = document.createElement("div");
    previewEl.className = "tab-drag-preview";
    document.body.appendChild(previewEl);
  }
  if (label !== undefined) previewEl.textContent = label;
  previewEl.style.transform = `translate(${clientX + 12}px, ${clientY + 4}px)`;
};
const hidePreview = () => { previewEl?.remove(); previewEl = null; };

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

  strip.hidden = (tabs.length === 0 && !externalDragLabel) || app?.dataset.uiTabsEnabled !== "true";
  strip.innerHTML = "";
  if (externalDragLabel && tabs.length === 0) {
    const ghost = document.createElement("div");
    ghost.className = "session-tab session-tab-ghost";
    ghost.textContent = externalDragLabel;
    strip.appendChild(ghost);
    return;
  }
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
      dragDropped = false;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", id);
      ev.dataTransfer.setDragImage(blankDragImg, 0, 0);
      btn.classList.add("dragging");
      const label = labelFor(id);
      showPreview(ev.clientX, ev.clientY, label);
      window.electronAPI?.tabDragUpdate?.({ label }, "start");
    });
    btn.addEventListener("drag", (ev) => {
      if (!dragId) return;
      if (!ev.clientX && !ev.clientY) return;  // final drag event reports (0,0)
      const stripRect = strip?.getBoundingClientRect();
      const inSource = ev.clientX >= 0 && ev.clientX <= window.innerWidth
        && ev.clientY >= 0 && ev.clientY <= window.innerHeight;
      const tearing = stripRect && inSource && ev.clientY > stripRect.bottom + 40;
      app?.classList.toggle("tab-tearing-out", !!tearing);
      if (inSource) showPreview(ev.clientX, ev.clientY);
      else hidePreview();
    });
    btn.addEventListener("dragend", async (ev) => {
      const torn = dragId;
      const dropped = dragDropped;
      dragId = null;
      dragDropped = false;
      btn.classList.remove("dragging");
      app?.classList.remove("tab-tearing-out");
      hidePreview();
      clearDropMarks();

      const api = window.electronAPI;
      const stopPoll = () => api?.tabDragUpdate?.(null, "end");
      if (!torn || dropped || !api) { stopPoll(); return; }

      const sx = ev.screenX, sy = ev.screenY;
      const outsideSource = sx < window.screenX || sx > window.screenX + window.outerWidth
        || sy < window.screenY || sy > window.screenY + window.outerHeight;
      const stripRect = strip?.getBoundingClientRect();
      const farBelowStrip = stripRect && ev.clientY > stripRect.bottom + 40;
      if (!outsideSource && !farBelowStrip) { stopPoll(); return; }

      if (outsideSource) {
        const res = await api.moveTabToWindowAt?.(torn);
        if (res?.moved) { closeTab(torn); stopPoll(); return; }
      }
      // Stop poll before new-window creation so it cannot fire IPC against a
      // half-initialized webContents.
      stopPoll();
      if (openTabs.peek().length <= 1 || !api.openSessionWindow) return;
      const r = await api.openSessionWindow(torn, { x: sx, y: sy });
      if (r?.ok) closeTab(torn);
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
      dragDropped = true;
      const after = btn.classList.contains("drop-after");
      btn.classList.remove("drop-before", "drop-after");
      reorder(dragId, id, after ? "after" : "before");
    });

    strip.appendChild(btn);
  }
};

effect(render);

const clearExternalDropMarks = () => {
  externalDropTargetId = null;
  externalDropSide = null;
  clearDropMarks();
};

window.electronAPI?.onTabDragHover?.(({ hovering, screenPos, label }) => {
  if (!hovering || !screenPos) {
    clearExternalDropMarks();
    hidePreview();
    if (externalDragLabel) { externalDragLabel = ""; render(); }
    return;
  }
  const newLabel = label || "tab";
  if (newLabel !== externalDragLabel) {
    externalDragLabel = newLabel;
    render();
  }
  const cx = screenPos.x - window.screenX;
  const cy = screenPos.y - window.screenY;
  showPreview(cx, cy, label);
  const tabs = [...(strip?.querySelectorAll(".session-tab:not(.session-tab-ghost)") ?? [])];
  let nearest = null;
  let side = null;
  let bestDx = Infinity;
  for (const el of tabs) {
    const r = el.getBoundingClientRect();
    if (cy < r.top - 20 || cy > r.bottom + 20) continue;
    const mid = r.left + r.width / 2;
    const dx = Math.abs(cx - mid);
    if (dx < bestDx) { bestDx = dx; nearest = el; side = cx > mid ? "after" : "before"; }
  }
  const anchor = nearest ?? tabs[tabs.length - 1] ?? null;
  const anchorId = anchor?.dataset.sessionId ?? null;
  const finalSide = anchor ? (nearest ? side : "after") : null;
  if (anchorId === externalDropTargetId && finalSide === externalDropSide) return;
  clearDropMarks();
  externalDropTargetId = anchorId;
  externalDropSide = finalSide;
  if (anchor) anchor.classList.add(finalSide === "after" ? "drop-after" : "drop-before");
});

window.electronAPI?.onAcceptTab?.((sessionId) => {
  if (typeof sessionId !== "string") return;
  const targetId = externalDropTargetId;
  const side = externalDropSide;
  clearExternalDropMarks();
  if (targetId && targetId !== sessionId) {
    const order = openTabs.peek().slice().filter((x) => x !== sessionId);
    const idx = order.indexOf(targetId);
    if (idx >= 0) {
      order.splice(side === "after" ? idx + 1 : idx, 0, sessionId);
      openTabs.value = order;
    }
  }
  openTab(sessionId);
});

// The pref attr lands after the /api/config fetch resolves, post-render.
new MutationObserver(render).observe(app, {
  attributes: true,
  attributeFilter: ["data-ui-tabs-enabled"],
});
