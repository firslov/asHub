import { currentSessionId } from "./state.js";
import { setFilesOpen } from "./files-panel.js";
import { escape } from "./utils.js";

const app = document.querySelector(".app");
const panel = document.getElementById("tree-panel");
const body = document.getElementById("tree-body");
const toggle = document.getElementById("tree-toggle");
const closeBtn = document.getElementById("tree-close");
const refreshBtn = document.getElementById("tree-refresh");

const setTreeOpen = (open) => {
  if (!panel) return;
  if (open) {
    setFilesOpen(false);
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

const render = ({ leafId, rootId, entries }) => {
  if (!body) return;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const children = new Map();
  for (const e of entries) {
    if (e.parentId == null) continue;
    if (!children.has(e.parentId)) children.set(e.parentId, []);
    children.get(e.parentId).push(e.id);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => (byId.get(a)?.timestamp ?? 0) - (byId.get(b)?.timestamp ?? 0));
  }
  const leafIds = entries.filter((e) => !children.has(e.id)).map((e) => e.id);
  const isLeaf = new Set(leafIds);

  const rows = [];
  const walk = (id, prefix, char) => {
    const entry = byId.get(id);
    if (!entry) return;
    rows.push(renderRow(entry, prefix + char, id === leafId, isLeaf.has(id)));
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const childPrefix = char === "├─" ? prefix + "│ "
      : char === "└─" ? prefix + "  "
      : prefix;
    if (kids.length === 1) {
      walk(kids[0], childPrefix, "");
    } else {
      for (let i = 0; i < kids.length; i++) {
        const isLast = i === kids.length - 1;
        walk(kids[i], childPrefix, isLast ? "└─" : "├─");
      }
    }
  };
  walk(rootId, "", "");

  body.innerHTML = `<div class="tree-rows">${rows.join("")}</div>`;
  body.querySelectorAll(".tree-row[data-entry-id]").forEach((row) => {
    row.addEventListener("click", () => fork(row.dataset.entryId));
  });
};

const renderRow = (entry, prefix, isActive, isLeaf) => {
  const icon = entry.type === "session" ? "◉"
    : entry.type === "compaction" ? "📦"
    : entry.role === "user" ? "▸"
    : entry.role === "assistant" ? "◂"
    : entry.role === "tool" ? "⚙"
    : "·";
  const preview = entry.type === "compaction"
    ? `compacted (firstKept ${escape(String(entry.firstKeptId ?? "").slice(0, 6))})`
    : (entry.preview ?? entry.type);
  const idShort = entry.id.slice(0, 6);
  const activeBadge = isActive ? `<span class="tree-active-badge">current</span>` : "";
  const leafBadge = isLeaf && !isActive ? `<span class="tree-leaf-badge">leaf</span>` : "";
  return `<div class="tree-row" data-entry-id="${escape(entry.id)}" title="${escape(entry.id)}">
    <span class="tree-prefix">${escape(prefix)}</span>
    <span class="tree-icon">${icon}</span>
    <span class="tree-id">${escape(idShort)}</span>
    <span class="tree-preview">${escape(preview)}</span>
    ${activeBadge}${leafBadge}
  </div>`;
};

const fork = async (entryId) => {
  const sid = currentSessionId();
  if (!sid) return;
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
