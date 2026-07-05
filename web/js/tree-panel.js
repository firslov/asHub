import { currentSessionId, state } from "./state.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { escape } from "./utils.js";

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

let _treeHash = "";

const refresh = async () => {
  const sid = currentSessionId();
  if (!sid || !body) return;
  try {
    const res = await fetch(`/${sid}/tree`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Skip full render if tree structure hasn't changed — only
    // update active/leaf badges in-place.
    const hash = `${data.leafId}|${data.entries.length}|${data.rootId}`;
    if (hash === _treeHash && body.firstChild) {
      updateBadgesInPlace(data.leafId, data.entries);
      return;
    }
    _treeHash = hash;
    render(data);
  } catch (err) {
    body.innerHTML = `<div class="tree-empty">failed: ${escape(String(err))}</div>`;
  }
};

const updateBadgesInPlace = (leafId, entries) => {
  if (!body) return;
  // Determine leaf entries from the full entry list.
  const childIds = new Set();
  for (const e of entries) { if (e.parentId) childIds.add(e.parentId); }
  const leafIds = new Set();
  for (const e of entries) { if (!childIds.has(e.id)) leafIds.add(e.id); }

  for (const row of body.querySelectorAll(".tree-row[data-entry-id]")) {
    const eid = row.dataset.entryId;
    const isActive = eid === leafId;
    const isLeaf = leafIds.has(eid) && !isActive;

    // Update active badge
    let badge = row.querySelector(".tree-active-badge");
    if (isActive && !badge) {
      badge = document.createElement("span");
      badge.className = "tree-active-badge";
      badge.textContent = "current";
      row.appendChild(badge);
    } else if (!isActive && badge) {
      badge.remove();
    }

    // Update leaf badge
    let leafBadge = row.querySelector(".tree-leaf-badge");
    if (isLeaf && !leafBadge) {
      leafBadge = document.createElement("span");
      leafBadge.className = "tree-leaf-badge";
      leafBadge.textContent = "leaf";
      row.appendChild(leafBadge);
    } else if (!isLeaf && leafBadge) {
      leafBadge.remove();
    }

    row.dataset.switchable = (isLeaf && !isActive) ? "1" : "0";
  }
};

const isVisible = (entry) => {
  if (!entry) return false;
  if (entry.type === "session" || entry.type === "compaction") return true;
  return entry.role === "user";
};

const render = ({ leafId, rootId, entries }) => {
  if (!body) return;
  const byId = new Map(entries.map((e) => [e.id, e]));
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
  const walk = (id, lineage, isDirectBranchChild) => {
    const entry = byId.get(id);
    if (!entry) return;
    const cols = isDirectBranchChild
      ? [...lineage.slice(0, -1), lineage[lineage.length - 1] === "vert" ? "branch-mid" : "branch-end"]
      : lineage;
    rows.push(renderRow(entry, cols, id === visibleLeafId, visibleLeafIds.has(id)));
    const kids = visibleChildren(id);
    if (kids.length === 0) return;
    if (kids.length === 1) {
      walk(kids[0], lineage, false);
    } else {
      for (let i = 0; i < kids.length; i++) {
        const isLast = i === kids.length - 1;
        walk(kids[i], [...lineage, isLast ? "none" : "vert"], true);
      }
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
    row.addEventListener("click", () => fork(descendToRawLeaf(row.dataset.entryId)));
  });
};

const renderRow = (entry, cols, isActive, isLeaf) => {
  const icon = entry.type === "session" ? "◉"
    : entry.type === "compaction" ? "📦"
    : entry.role === "user" ? "▸"
    : entry.role === "assistant" ? "◂"
    : "·";
  const preview = entry.type === "compaction"
    ? `compacted (firstKept ${escape(String(entry.firstKeptId ?? "").slice(0, 6))})`
    : (entry.preview ?? entry.type);
  const idShort = entry.id.slice(0, 6);
  const activeBadge = isActive ? `<span class="tree-active-badge">current</span>` : "";
  const leafBadge = isLeaf && !isActive ? `<span class="tree-leaf-badge">leaf</span>` : "";
  const switchable = isLeaf && !isActive ? "1" : "0";
  const titleHint = switchable === "1"
    ? `Switch to this branch (${entry.id})`
    : isActive ? `${entry.id} (current branch)` : entry.id;
  const prefixHtml = cols.map((c) => `<span class="tp-col" data-line="${c}"></span>`).join("");
  return `<div class="tree-row" data-entry-id="${escape(entry.id)}" data-switchable="${switchable}" title="${escape(titleHint)}">
    <span class="tree-prefix">${prefixHtml}</span>
    <span class="tree-icon">${icon}</span>
    <span class="tree-id">${escape(idShort)}</span>
    <span class="tree-preview">${escape(preview)}</span>
    ${activeBadge}${leafBadge}
  </div>`;
};

const fork = async (entryId) => {
  const sid = currentSessionId();
  if (!sid) return;
  if (state.isProcessing) { alert("Cancel or wait for the current turn before switching branches."); return; }
  const ok = confirm(`Switch active branch to entry ${entryId.slice(0, 6)}? Current live view will be replaced.`);
  if (!ok) return;
  try {
    const res = await fetch(`/${sid}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    if (!res.ok) {
      const msg = await res.text();
      alert(`Fork failed: ${msg}`);
      return;
    }
    refresh();
  } catch (err) {
    alert(`Fork error: ${err}`);
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

import { registerPanel } from './panel-manager.js';
registerPanel('tree', { toggleBtnId: 'tree-toggle', panelId: 'tree-panel', open: () => setTreeOpen(true), close: () => setTreeOpen(false) });
