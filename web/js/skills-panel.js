import { t } from "./i18n.js";
import { toast } from "./toast.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";

const skillsOverlay = document.getElementById("skills-overlay");
const skillsToggle = document.getElementById("skills-toggle");
const skillsClose = document.getElementById("skills-close");
const skillsList = document.getElementById("skills-list");
const skillsCount = document.getElementById("skills-count");
const skillsSearch = document.getElementById("skills-search");
const installedList = document.getElementById("skills-installed-list");
const skillsTabs = document.getElementById("skills-tabs");
const skillsSourceTabs = document.getElementById("skills-source-tabs");
let allSkills = [];
let catalogSource = null;
let catalogPartial = false;
let installed = new Set();
let installedPaths = new Map();
let installedSources = new Map();
let installedCwd = null;
let skillsFetchSeq = 0;
let installedFetchSeq = 0;
const skillsCwd = () => activeSession.peek()?.state?.cwd || "";
const uninstall = async (name, target) => {
  // A rendered row owns its path and cwd together; never combine an old
  // row with the currently active project's cwd.
  if (!target?.path || target.cwd !== skillsCwd()) return false;
  try {
    const response = await fetch("/api/skills/uninstall", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, path: target.path, cwd: target.cwd, sourceId: target.sourceId }) });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    return true;
  } catch (err) {
    toast(t("skills.uninstall.failed"), { type: "error", detail: String(err?.message ?? err) });
    throw err;
  }
};
let currentSource = "gitee";

// ── Source switching ──

skillsSourceTabs?.addEventListener("click", (e) => {
  const tab = e.target.closest(".p-seg-item");
  if (!tab || tab.classList.contains("active")) return;
  skillsSourceTabs.querySelectorAll(".p-seg-item").forEach((t) => t.classList.toggle("active", t === tab));
  currentSource = tab.dataset.source;
  refreshSkills();
});

// ── Tab switching ──

skillsTabs?.addEventListener("click", (e) => {
  const tab = e.target.closest(".p-seg-item");
  if (!tab) return;
  const panel = tab.dataset.tab;
  skillsTabs.querySelectorAll(".p-seg-item").forEach((t) => t.classList.toggle("active", t === tab));
  document.getElementById("skills-panel-market")?.toggleAttribute("hidden", panel !== "market");
  document.getElementById("skills-panel-installed")?.toggleAttribute("hidden", panel !== "installed");
  if (panel === "installed") refreshInstalled();
});

// ── Overlay toggle ──

export const setSkillsOpen = (on) => {
  if (!skillsOverlay) return;
  if (on) {
    skillsOverlay.removeAttribute("hidden");
    skillsToggle?.classList.add("active");
    initSkillsPanel();
  } else {
    skillsOverlay.setAttribute("hidden", "");
    skillsToggle?.classList.remove("active");
  }
};

if (skillsToggle) {
} else {
  console.error("[skills] toggle button not found");
}
if (skillsClose) {
  skillsClose.addEventListener("click", () => setSkillsOpen(false));
}
if (skillsOverlay) {
  skillsOverlay.addEventListener("click", (e) => {
    if (e.target === skillsOverlay) setSkillsOpen(false);
  });
}

// ── Panel logic ──

let _initialized = false;

export const initSkillsPanel = () => {
  if (!skillsSearch || !skillsList) return;
  if (!_initialized) {
    _initialized = true;
    skillsSearch.addEventListener("input", () => renderSkills(skillsSearch.value));
  }
  refreshSkills();
};

const refreshSkills = async () => {
  const request = ++skillsFetchSeq;
  const cwd = skillsCwd();
  const source = currentSource;
  catalogSource = null;
  if (skillsCount) skillsCount.textContent = "";
  if (skillsList) skillsList.innerHTML = `<div class="p-empty">${t("skills.loading")}</div>`;
  void refreshInstalled();
  try {
    const response = await fetch(`/api/skills?source=${source}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const marker = await response.json();
    if (request !== skillsFetchSeq || cwd !== skillsCwd() || source !== currentSource) return;
    allSkills = marker.skills || [];
    catalogSource = source;
    catalogPartial = marker.cached === true;
    renderSkills(skillsSearch?.value || "");
  } catch (err) {
    if (request !== skillsFetchSeq || cwd !== skillsCwd() || source !== currentSource) return;
    if (skillsList) {
      skillsList.innerHTML = `<div class="p-empty sk-error"><p>${esc(t("skills.load.failed"))}</p><button class="p-btn sk-retry">${esc(t("error.retry"))}</button></div>`;
      skillsList.querySelector(".sk-retry")?.addEventListener("click", refreshSkills);
    }
  }
};

const renderSkills = (query) => {
  if (!skillsList || !skillsCount || catalogSource !== currentSource) return;
  const cwd = skillsCwd();
  const paths = installedCwd === cwd ? new Map(installedPaths) : new Map();
  const sources = new Map(installedSources);
  const sourceId = id => id.includes(":") ? id : `github:${id}`;
  let list = allSkills;
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((s) => `${s.name} ${s.description} ${s.topics?.join(" ")}`.toLowerCase().includes(q));
  }
  skillsCount.textContent = list.length ? `${list.length} ${t("skills.count")}` : "";

  skillsList.innerHTML = list.map((s) => {
    const isInstalled = paths.has(s.name) && sources.get(s.name) === sourceId(s.id);
    const conflict = paths.has(s.name) && !isInstalled;
    const label = s.displayName || s.name;
    const meta = [s.author, s.updated, ...(s.topics || [])].filter(Boolean).map(esc).join(" · ");
    return `<div class="p-card sk-card">
      <div class="sk-card-head">
        <span class="sk-badge">${esc(label.trim().charAt(0) || "?")}</span>
        <span class="sk-name" title="${esc(label)}">${esc(label)}</span>
        <button class="p-btn sk-install ${isInstalled ? "installed" : ""}" data-id="${esc(s.id)}" data-name="${esc(s.name)}">
          ${conflict ? t("skills.source.conflict") : isInstalled ? t("skills.installed") : t("skills.install")}
        </button>
      </div>
      <div class="sk-desc">${esc(s.description || "")}</div>
      <div class="sk-meta">${meta}</div>
    </div>`;
  }).join("") || `<div class="p-empty">${query ? t("skills.noresults") : t("skills.empty")}</div>`;

  if (catalogPartial) {
    skillsList.innerHTML = `<div class="p-empty">${esc(t("skills.catalog.partial"))} <button class="p-btn sk-retry">${esc(t("error.retry"))}</button></div>` + skillsList.innerHTML;
    skillsList.querySelector(".sk-retry")?.addEventListener("click", refreshSkills);
  }

  // Attach install handlers
  skillsList.querySelectorAll(".sk-install").forEach((btn) => {
    const conflict = paths.has(btn.dataset.name) && sources.get(btn.dataset.name) !== sourceId(btn.dataset.id);
    btn.disabled = installedCwd !== cwd || conflict;
    if (conflict) btn.title = t("skills.source.conflict.hint");
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!id || btn.disabled || cwd !== skillsCwd()) return;
      if (paths.has(name) && sources.get(name) !== sourceId(id)) return;
      if (paths.has(name)) {
        // Uninstall
        btn.textContent = "...";
        try {
          if (!await uninstall(name, { path: paths.get(name), cwd, sourceId: sourceId(id) }) || cwd !== skillsCwd()) return;
          installed.delete(name);
          installedPaths.delete(name);
          installedSources.delete(name);
          sources.delete(name);
          paths.delete(name);
          btn.textContent = t("skills.install");
          btn.classList.remove("installed");
          refreshInstalled();
        } catch { btn.textContent = t("skills.installed"); }
      } else {
        // Install
        btn.textContent = "...";
        try {
          const r = await fetch("/api/skills/install", { method: "POST", body: JSON.stringify({ id }) });
          const d = await r.json();
          if (cwd !== skillsCwd()) return;
          if (d.ok) {
            installed.add(name);
            if (d.sourceId) { sources.set(name, d.sourceId); installedSources.set(name, d.sourceId); }
            if (typeof d.path === "string") { paths.set(name, d.path); installedPaths.set(name, d.path); }
            btn.textContent = t("skills.installed");
            btn.classList.add("installed");
            refreshInstalled();
          } else {
            btn.textContent = "✕";
            btn.title = d?.error || "Install failed";
            setTimeout(() => { btn.textContent = t("skills.install"); btn.title = ""; }, 4000);
            toast(t("skills.install.failed"), { type: "error", detail: d?.error || undefined });
          }
        } catch {
          btn.textContent = "✕";
          btn.title = "Network error";
          setTimeout(() => { btn.textContent = t("skills.install"); btn.title = ""; }, 4000);
          toast(t("skills.install.failed"), { type: "error", detail: "Network error" });
        }
      }
    });
  });
};

const refreshInstalled = async () => {
  if (!installedList) return;
  const request = ++installedFetchSeq;
  const cwd = skillsCwd();
  // Disable the previous project's actions while this project's list loads.
  if (installedCwd !== cwd) {
    installed = new Set();
    installedPaths = new Map();
    installedSources = new Map();
    installedCwd = null;
    installedList.innerHTML = `<div class="p-empty">${t("skills.loading")}</div>`;
  }
  try {
    const r = await fetch(`/api/skills/installed${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (request !== installedFetchSeq || cwd !== skillsCwd()) return;
    const list = d.installed || [];
    installedCwd = cwd;
    installed = new Set(list.map((s) => s.name));
    installedPaths = new Map(list.map(s => [s.name, s.path]));
    installedSources = new Map(list.map(s => [s.name, s.sourceId]));
    installedList.innerHTML = list.length
      ? list.map((s) => `<div class="p-row sk-installed-row">
          <span class="p-row-main" title="${esc(s.path)}">${esc(s.name)}</span>
          <button class="p-icon-btn danger sk-remove" data-name="${esc(s.name)}" title="${t("skills.uninstall")}">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
            </svg>
          </button>
        </div>`).join("")
      : `<div class="p-empty">${t("skills.none")}</div>`;
    // Bind actions to this exact response, independent of later refreshes.
    const paths = new Map(installedPaths);
    installedList.querySelectorAll(".sk-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if (!name || cwd !== skillsCwd()) return;
        btn.disabled = true;
        try {
          if (!await uninstall(name, { path: paths.get(name), cwd }) || cwd !== skillsCwd()) return;
          installed.delete(name);
          refreshInstalled();
          renderSkills(skillsSearch?.value || "");
        } catch {
          btn.disabled = false;
        }
      });
    });
    // Re-render cards to update install/uninstall buttons
    renderSkills(skillsSearch?.value || "");
  } catch (err) {
    if (request === installedFetchSeq && cwd === skillsCwd()) {
      installedList.innerHTML = `<div class="p-empty sk-error">${esc(err.message)}</div>`;
    }
  }
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

import { registerPanel } from './panel-manager.js';
registerPanel('skills', { toggleBtnId: 'skills-toggle', panelId: 'skills-overlay', open: () => setSkillsOpen(true), close: () => setSkillsOpen(false) });

// A project switch invalidates all pending responses, including A → B → A.
const invalidateProjectSkills = () => {
  ++skillsFetchSeq;
  ++installedFetchSeq;
  installedCwd = null;
  installed = new Set();
  installedPaths = new Map();
  installedSources = new Map();
  if (skillsOverlay && !skillsOverlay.hidden) refreshSkills();
};
effect(() => {
  activeSession.value;
  invalidateProjectSkills();
});
document.addEventListener("ash:cwd-change", (event) => {
  if (event.detail?.sessionId === activeSession.peek()?.id) invalidateProjectSkills();
});
