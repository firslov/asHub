import { currentSessionId } from "./state.js";
import { setCtxOpen } from "./context-panel.js";
import { setConfigOpen } from "./config-panel.js";
import { t } from "./i18n.js";

const app = document.querySelector(".app");
const filesPanel = document.getElementById("files-panel");
const filesToggle = document.getElementById("files-toggle");
const filesClose = document.getElementById("files-close");
const filesRefresh = document.getElementById("files-refresh");
const filesBody = document.getElementById("files-body");
const filesCwd = document.getElementById("files-cwd");
const filesEmpty = document.getElementById("files-empty");

const LS_FILES = "ash.files-open";

// Set initial text (JS manages this dynamically, so no data-i18n in HTML)
if (filesEmpty) filesEmpty.textContent = t("files.loading");

import { activeSession } from "./session-manager.js";
const expandedDirs = () => activeSession.peek()?.files.expandedDirs ?? new Map();

const showFilesEmpty = (msg, sub) => {
  if (!filesEmpty) return;
  filesEmpty.hidden = false;
  filesEmpty.innerHTML = msg;
  const subEl = filesEmpty.querySelector(".files-empty-sub");
  if (sub) {
    if (!subEl) filesEmpty.insertAdjacentHTML("beforeend", `<span class="files-empty-sub">${sub}</span>`);
    else subEl.textContent = sub;
  } else {
    if (subEl) subEl.remove();
  }
};

const makeEntryEl = (f, basePath) => {
  const el = document.createElement("div");
  el.className = `files-entry ${f.kind}`;
  el.dataset.name = f.name;
  el.dataset.path = basePath ? basePath + "/" + f.name : f.name;

  const depth = basePath ? basePath.split("/").length : 0;
  if (depth > 0) el.style.paddingLeft = `${1 + depth * 1.2}rem`;

  // Expand/collapse chevron for directories
  if (f.kind === "dir") {
    const chevron = document.createElement("span");
    chevron.className = "files-entry-chevron";
    chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 2L7 5L3 8"/>
    </svg>`;
    el.appendChild(chevron);
  }

  const icon = document.createElement("span");
  icon.className = `files-entry-icon ${f.kind}`;
  icon.innerHTML = f.kind === "dir"
    ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 3.5a1.5 1.5 0 0 1 1.5-1.5h3L7 4h4.5a1.5 1.5 0 0 1 1.5 1.5V11a1.5 1.5 0 0 1-1.5 1.5H2.5A1.5 1.5 0 0 1 1 11V3.5z"/>
       </svg>`
    : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 1.5h5l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z"/>
        <polyline points="8 1.5 8 4.5 11 4.5"/>
       </svg>`;
  const name = document.createElement("span");
  name.className = "files-entry-name";
  name.textContent = f.name;
  const kb = document.createElement("span");
  kb.className = "files-entry-kb";
  el.appendChild(icon);
  el.appendChild(name);
  el.appendChild(kb);
  el.title = t("files.dblclick.hint", { name: "@" + el.dataset.path });

  el.addEventListener("dblclick", () => {
    const inp = document.getElementById("query");
    if (!inp) return;
    const current = inp.value.trim();
    const sep = current.length > 0 ? " " : "";
    inp.value = current + sep + "@" + el.dataset.path;
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });

  return el;
};

// Fetch subdirectory contents from the server
const fetchSubdir = async (subdirPath) => {
  const resp = await fetch(`/${currentSessionId()}/files?subdir=${encodeURIComponent(subdirPath)}`);
  if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
  return resp.json();
};

// Toggle expand/collapse for a folder entry
const toggleDir = async (entryEl) => {
  const dirPath = entryEl.dataset.path;
  if (!dirPath) return;

  const chevron = entryEl.querySelector(".files-entry-chevron");

  if (expandedDirs().has(dirPath)) {
    // Collapse: remove children and clean up nested expanded state
    const childContainer = expandedDirs().get(dirPath);
    if (childContainer) {
      // Collect nested keys first to safely delete during iteration
      const nestedKeys = [];
      for (const key of expandedDirs().keys()) {
        if (key === dirPath || key.startsWith(dirPath + "/")) {
          nestedKeys.push(key);
        }
      }
      for (const key of nestedKeys) {
        expandedDirs().delete(key);
      }
      childContainer.remove();
    }
    entryEl.classList.remove("expanded");
    if (chevron) chevron.classList.remove("expanded");
    return;
  }

  // Expand: show loading state
  entryEl.classList.add("loading");
  if (chevron) chevron.classList.add("loading");

  try {
    const data = await fetchSubdir(dirPath);
    entryEl.classList.remove("loading");
    if (chevron) chevron.classList.remove("loading");

    // Create child container
    const childContainer = document.createElement("div");
    childContainer.className = "files-children";

    const frag = document.createDocumentFragment();
    for (const f of data.files || []) {
      const childEl = makeEntryEl(f, dirPath);
      childEl.classList.add("files-child");
      frag.appendChild(childEl);
    }
    childContainer.appendChild(frag);

    // Insert after the entry
    entryEl.after(childContainer);
    expandedDirs().set(dirPath, childContainer);
    entryEl.classList.add("expanded");
    if (chevron) chevron.classList.add("expanded");
  } catch {
    entryEl.classList.remove("loading");
    if (chevron) chevron.classList.remove("loading");
  }
};

const renderFiles = (files, basePath) => {
  if (!filesBody || !filesEmpty) return;

  // Only clear root entries; we manage children separately
  filesBody.querySelectorAll(":scope > .files-entry, :scope > .files-children").forEach((el) => el.remove());
  expandedDirs().clear();

  if (files.length === 0) {
    showFilesEmpty(basePath ? t("files.empty.dir") : t("files.no.files"), basePath ? "" : t("files.empty.hint"));
    return;
  }
  filesEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  for (const f of files) {
    const el = makeEntryEl(f, basePath || "");
    frag.appendChild(el);
  }
  filesBody.appendChild(frag);
};

// Delegate click events on the files body for expand/collapse
filesBody?.addEventListener("click", (e) => {
  const entry = e.target.closest(".files-entry");
  if (!entry) return;
  // Only handle click for directories
  if (!entry.classList.contains("dir")) return;

  // Ignore clicks on already-loading entries
  if (entry.classList.contains("loading")) return;

  toggleDir(entry);
});

const fetchFiles = async () => {
  if (!filesBody || !filesCwd || !filesEmpty) return;
  const sid = currentSessionId();
  if (!sid) { showFilesEmpty(t("files.no.session"), t("files.no.session.hint")); return; }
  showFilesEmpty(t("files.loading"));
  filesBody.querySelectorAll(":scope > .files-entry, :scope > .files-children").forEach((el) => el.remove());
  expandedDirs().clear();
  try {
    const resp = await fetch(`/${sid}/files`);
    const data = await resp.json();
    filesCwd.textContent = data.cwd || "";
    filesCwd.title = data.cwd || "";
    renderFiles(data.files || [], "");
  } catch {
    showFilesEmpty(t("files.failed"), t("files.failed.hint"));
  }
};

const setFilesOpen = (on) => {
  if (on) {
    // 互斥：关闭其他面板
    setCtxOpen(false);
    setConfigOpen(false);
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
    filesPanel.removeAttribute("hidden"); app.classList.add("files-open"); fetchFiles(); filesToggle?.classList.add("active");
  }
  else { filesPanel.setAttribute("hidden", ""); app.classList.remove("files-open"); filesToggle?.classList.remove("active"); }
  try { localStorage.setItem(LS_FILES, on ? "1" : "0"); } catch {}
};

filesToggle?.addEventListener("click", () => setFilesOpen(filesPanel.hasAttribute("hidden")));
filesClose?.addEventListener("click", () => setFilesOpen(false));
filesRefresh?.addEventListener("click", () => fetchFiles());

// 延迟初始化，避免循环依赖导致的 TDZ 错误
setTimeout(() => {
  try {
    if (localStorage.getItem(LS_FILES) === "1") setFilesOpen(true);
  } catch {}
}, 0);

export { setFilesOpen };

// Refresh files panel content when language changes while panel is open
document.addEventListener("langchange", () => {
  if (filesPanel && !filesPanel.hasAttribute("hidden")) fetchFiles();
});

export const refreshFilesIfOpen = () => {
  if (filesPanel && !filesPanel.hasAttribute("hidden")) fetchFiles();
};
