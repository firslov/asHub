import { currentSessionId, state } from "./state.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { escape } from "./utils.js";
import { t } from "./i18n.js";
import { toast } from "./toast.js";

const app = document.querySelector(".app");
const panel = document.getElementById("tree-panel");
const body = document.getElementById("tree-body");
const toggle = document.getElementById("tree-toggle");
const closeBtn = document.getElementById("tree-close");
const refreshBtn = document.getElementById("tree-refresh");

export const setTreeOpen = (open) => {
  if (!panel) return;
  if (open) {
    panel.removeAttribute("hidden");
    app?.classList.add("tree-open");
    toggle?.classList.add("active");
    refresh();
  } else {
    panel.setAttribute("hidden", "");
    app?.classList.remove("tree-open");
    toggle?.classList.remove("active");
  }
};

let treeFetchSeq = 0;
let treeFetchAbort = null;

const refresh = async () => {
  const sid = currentSessionId();
  // Invalidate any in-flight fetch even when there is nothing to load, so a
  // stale response from a previous session can't render into the panel.
  const mySeq = ++treeFetchSeq;
  if (!sid || !body) return;
  treeFetchAbort?.abort();
  const ac = new AbortController();
  treeFetchAbort = ac;
  try {
    const res = await fetch(`/${sid}/tree`, { signal: ac.signal });
    if (mySeq !== treeFetchSeq) return;
    if (!res.ok) {
      // 409 = session has no tree store (e.g. terminal sessions)
      if (res.status === 409 || res.status === 404) {
        body.innerHTML = `<div class="tree-empty">${escape(t("tree.unsupported"))}</div>`;
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    if (mySeq !== treeFetchSeq) return;
    render(data);
  } catch (err) {
    if (err?.name === "AbortError" || mySeq !== treeFetchSeq) return;
    body.innerHTML = `<div class="tree-empty">failed: ${escape(String(err))}</div>`;
  }
};


const isVisible = (entry) => {
  if (!entry) return false;
  if (entry.type === "session" || entry.type === "compaction") return true;
  return entry.role === "user";
};

const render = ({ leafId, rootId, entries }) => {
  if (!body) return;
  const byId = new Map((entries ?? []).map((e) => [e.id, e]));
  if (byId.size === 0 || !byId.get(rootId)) {
    body.innerHTML = `<div class="tree-empty">${escape(t("tree.empty"))}</div>`;
    return;
  }
  const rawChildren = new Map();
  for (const e of entries) {
    if (e.parentId == null) continue;
    if (!rawChildren.has(e.parentId)) rawChildren.set(e.parentId, []);
    rawChildren.get(e.parentId).push(e.id);
  }
  for (const ids of rawChildren.values()) {
    ids.sort((a, b) => (byId.get(a)?.timestamp ?? 0) - (byId.get(b)?.timestamp ?? 0));
  }

  const visibleChildren = (id) => {
    const out = [];
    const stack = [...(rawChildren.get(id) ?? [])];
    while (stack.length) {
      const cid = stack.shift();
      const entry = byId.get(cid);
      if (isVisible(entry)) {
        out.push(cid);
      } else {
        const grand = rawChildren.get(cid) ?? [];
        stack.unshift(...grand);
      }
    }
    return out;
  };

  const visibleLeafIds = new Set();
  for (const e of entries) {
    if ((rawChildren.get(e.id) ?? []).length > 0) continue;
    let cur = e;
    while (cur && !isVisible(cur)) cur = byId.get(cur.parentId);
    if (cur) visibleLeafIds.add(cur.id);
  }
  let visibleLeafId = leafId;
  while (visibleLeafId && !isVisible(byId.get(visibleLeafId))) {
    visibleLeafId = byId.get(visibleLeafId)?.parentId;
  }

  const rows = [];
  // Single-child chains are followed iteratively to avoid stack overflow on
  // very long sessions; recursion only happens at actual branch points.
  const walk = (id, lineage, isDirectBranchChild) => {
    let curId = id;
    let curDirect = isDirectBranchChild;
    while (true) {
      const entry = byId.get(curId);
      if (!entry) return;
      const cols = curDirect
        ? [...lineage.slice(0, -1), lineage[lineage.length - 1] === "vert" ? "branch-mid" : "branch-end"]
        : lineage;
      rows.push(renderRow(entry, cols, curId === visibleLeafId, visibleLeafIds.has(curId)));
      const kids = visibleChildren(curId);
      if (kids.length === 0) return;
      if (kids.length === 1) {
        curId = kids[0];
        curDirect = false;
        continue;
      }
      for (let i = 0; i < kids.length; i++) {
        const isLast = i === kids.length - 1;
        walk(kids[i], [...lineage, isLast ? "none" : "vert"], true);
      }
      return;
    }
  };
  walk(rootId, [], false);

  const descendToRawLeaf = (id) => {
    let cur = id;
    while (true) {
      const kids = rawChildren.get(cur);
      if (!kids || kids.length === 0) return cur;
      cur = kids[kids.length - 1];
    }
  };

  body.innerHTML = `<div class="tree-rows">${rows.join("")}</div>`;
  body.querySelectorAll('.tree-row[data-entry-id][data-switchable="1"]').forEach((row) => {
    row.addEventListener("click", () => confirmFork(row, descendToRawLeaf(row.dataset.entryId)));
  });
};

const relTime = (ts) => {
  if (typeof ts !== "number" || !ts) return "";
  const mins = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (mins < 1) return t("tree.time.now");
  if (mins < 60) return t("tree.time.ago", { t: `${mins}m` });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("tree.time.ago", { t: `${hours}h` });
  return t("tree.time.ago", { t: `${Math.floor(hours / 24)}d` });
};

const renderRow = (entry, cols, isActive, isLeaf) => {
  const icon = entry.type === "session" ? "◉"
    : entry.type === "compaction" ? "📦"
    : entry.role === "user" ? "▸"
    : entry.role === "assistant" ? "◂"
    : "·";
  const preview = entry.type === "compaction"
    ? t("tree.compacted")
    : (entry.preview ?? entry.type);
  const time = relTime(entry.timestamp);
  const activeBadge = isActive ? `<span class="tree-active-badge">${escape(t("tree.badge.current"))}</span>` : "";
  const leafBadge = isLeaf && !isActive ? `<span class="tree-leaf-badge">${escape(t("tree.badge.leaf"))}</span>` : "";
  const switchable = isLeaf && !isActive ? "1" : "0";
  const titleHint = switchable === "1"
    ? t("tree.switch.hint", { id: entry.id })
    : isActive ? t("tree.current.hint", { id: entry.id }) : entry.id;
  const prefixHtml = cols.map((c) => `<span class="tp-col" data-line="${c}"></span>`).join("");
  return `<div class="tree-row" data-entry-id="${escape(entry.id)}" data-switchable="${switchable}" title="${escape(titleHint)}">
    <span class="tree-prefix">${prefixHtml}</span>
    <span class="tree-icon">${icon}</span>
    <span class="tree-preview">${escape(preview)}</span>
    ${time ? `<span class="tree-time">${escape(time)}</span>` : ""}
    ${activeBadge}${leafBadge}
  </div>`;
};

// Two-step confirm (mirrors the approve-all pattern in sse.js): the first
// click arms the row for 3s, the second click performs the fork.
const disarmForkRow = (row) => {
  if (row._forkTimer) { clearTimeout(row._forkTimer); row._forkTimer = null; }
  row.classList.remove("confirming");
  const badge = row.querySelector(".tree-leaf-badge");
  if (badge) badge.textContent = t("tree.badge.leaf");
  row.title = t("tree.switch.hint", { id: row.dataset.entryId });
};

const confirmFork = (row, entryId) => {
  if (state.isProcessing) { toast(t("tree.busy"), { type: "info" }); return; }
  if (row.classList.contains("confirming")) {
    disarmForkRow(row);
    fork(entryId);
    return;
  }
  row.classList.add("confirming");
  const badge = row.querySelector(".tree-leaf-badge");
  if (badge) badge.textContent = t("tree.fork.confirm");
  row.title = t("tree.fork.confirm.hint");
  row._forkTimer = setTimeout(() => disarmForkRow(row), 3000);
};

const fork = async (entryId) => {
  const sid = currentSessionId();
  if (!sid) return;
  if (state.isProcessing) { toast(t("tree.busy"), { type: "info" }); return; }
  try {
    const res = await fetch(`/${sid}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    if (!res.ok) {
      const msg = await res.text();
      toast(t("tree.fork.failed"), { type: "error", detail: msg });
      return;
    }
    toast(t("tree.fork.done"), { type: "success" });
    refresh();
  } catch (err) {
    toast(t("tree.fork.failed"), { type: "error", detail: String(err?.message ?? err) });
  }
};

closeBtn?.addEventListener("click", () => setTreeOpen(false));
refreshBtn?.addEventListener("click", () => refresh());

effect(() => {
  const busy = !!activeSession.value?.state?.isProcessing;
  panel?.classList.toggle("busy", busy);
});

// Refresh tree when active session changes (if panel is open).
// Wait for session-view to be registered so registerSession has fired
// before the first refresh — avoids an init-time race.
customElements.whenDefined("session-view").then(() => {
  effect(() => {
    activeSession.value;
    refreshTreeIfOpen();
  });
});

export const refreshTreeIfOpen = () => {
  if (panel && !panel.hasAttribute("hidden")) refresh();
};

// Contract H: rewind/fork from the message stream switches the active branch
document.addEventListener("ash:branch-switched", () => refreshTreeIfOpen());

import { registerPanel } from './panel-manager.js';
registerPanel('tree', { toggleBtnId: 'tree-toggle', panelId: 'tree-panel', open: () => setTreeOpen(true), close: () => setTreeOpen(false) });
