import { currentSessionId, state } from "./state.js";
import { setFilesOpen } from "./files-panel.js";
import { setCtxOpen } from "./context-panel.js";
import { setConfigOpen } from "./config-panel.js";
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
    setFilesOpen(false);
    setCtxOpen(false);
    setConfigOpen(false);
    try { import("./subagent-panel.js").then(m => m.setSgOpen(false)); } catch {}
    const skillsOverlay = document.getElementById("skills-overlay");
    if (skillsOverlay && !skillsOverlay.hidden) {
      import("./skills-panel.js").then((m) => m.setSkillsOpen(false));
    }
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
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

const refresh = async () => {
  const sid = currentSessionId();
  if (!sid || !body) return;
  body.innerHTML = `<div class="tree-empty">loading…</div>`;
  try {
    const res = await fetch(`/${sid}/tree`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
  } catch (err) {
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

toggle?.addEventListener("click", () => setTreeOpen(panel?.hasAttribute("hidden") ?? true));
closeBtn?.addEventListener("click", () => setTreeOpen(false));
refreshBtn?.addEventListener("click", () => refresh());

effect(() => {
  const busy = !!activeSession.value?.state?.isProcessing;
  panel?.classList.toggle("busy", busy);
});

// Refresh tree when active session changes (if panel is open).
// Deferred via setTimeout so the effect registers after session-view
// has been upgraded and registerSession has fired — avoiding an init-
// time race with ES module evaluation order.
setTimeout(() => {
  effect(() => {
    activeSession.value;
    refreshTreeIfOpen();
  });
}, 0);

export const refreshTreeIfOpen = () => {
  if (panel && !panel.hasAttribute("hidden")) refresh();
};
