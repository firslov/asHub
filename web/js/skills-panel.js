import { t } from "./i18n.js";
import { toast } from "./toast.js";
import { activeSession } from "./session-manager.js";

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
let installed = new Set();
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
  if (_initialized) return;
  if (!skillsSearch || !skillsList) return;
  _initialized = true;
  skillsSearch.addEventListener("input", () => renderSkills(skillsSearch.value));
  refreshSkills();
};

const refreshSkills = async () => {
  if (skillsList) skillsList.innerHTML = `<div class="p-empty">${t("skills.loading")}</div>`;
  const cwd = activeSession.peek()?.state?.cwd || "";
  try {
    const [markerRes, instRes] = await Promise.all([
      fetch(`/api/skills?source=${currentSource}`),
      fetch(`/api/skills/installed${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
    ]);
    const marker = await markerRes.json();
    const inst = await instRes.json();
    allSkills = marker.skills || [];
    installed = new Set((inst.installed || []).map((s) => s.name));
    renderSkills(skillsSearch?.value || "");
    refreshInstalled();
  } catch (err) {
    if (skillsList) skillsList.innerHTML = `<div class="p-empty sk-error">${esc(err.message)}</div>`;
  }
};

const renderSkills = (query) => {
  if (!skillsList || !skillsCount) return;
  let list = allSkills;
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((s) => `${s.name} ${s.description} ${s.topics?.join(" ")}`.toLowerCase().includes(q));
  }
  skillsCount.textContent = list.length ? `${list.length} ${t("skills.count")}` : "";

  skillsList.innerHTML = list.map((s) => {
    const isInstalled = installed.has(s.name);
    const label = s.displayName || s.name;
    const meta = [s.author, s.updated, ...(s.topics || [])].filter(Boolean).map(esc).join(" · ");
    return `<div class="p-card sk-card">
      <div class="sk-card-head">
        <span class="sk-badge">${esc(label.trim().charAt(0) || "?")}</span>
        <span class="sk-name" title="${esc(label)}">${esc(label)}</span>
        <button class="p-btn sk-install ${isInstalled ? "installed" : ""}" data-id="${esc(s.id)}" data-name="${esc(s.name)}">
          ${isInstalled ? t("skills.installed") : t("skills.install")}
        </button>
      </div>
      <div class="sk-desc">${esc(s.description || "")}</div>
      <div class="sk-meta">${meta}</div>
    </div>`;
  }).join("") || `<div class="p-empty">${query ? t("skills.noresults") : t("skills.empty")}</div>`;

  // Attach install handlers
  skillsList.querySelectorAll(".sk-install").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!id) return;
      if (installed.has(name)) {
        // Uninstall
        btn.textContent = "...";
        try {
          await fetch("/api/skills/uninstall", { method: "POST", body: JSON.stringify({ name }) });
          installed.delete(name);
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
          if (d.ok) {
            installed.add(name);
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
  try {
    const cwd = activeSession.peek()?.state?.cwd || "";
    const r = await fetch(`/api/skills/installed${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
    const d = await r.json();
    const list = d.installed || [];
    installed = new Set(list.map((s) => s.name));
    installedList.innerHTML = list.length
      ? list.map((s) => `<div class="p-row sk-installed-row">
          <span class="p-row-main">${esc(s.name)}</span>
          <button class="p-icon-btn danger sk-remove" data-name="${esc(s.name)}" title="${t("skills.uninstall")}">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
            </svg>
          </button>
        </div>`).join("")
      : `<div class="p-empty">${t("skills.none")}</div>`;
    // Attach remove handlers
    installedList.querySelectorAll(".sk-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if (!name) return;
        btn.disabled = true;
        try {
          await fetch("/api/skills/uninstall", { method: "POST", body: JSON.stringify({ name }) });
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
  } catch {}
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

import { registerPanel } from './panel-manager.js';
registerPanel('skills', { toggleBtnId: 'skills-toggle', panelId: 'skills-overlay', open: () => setSkillsOpen(true), close: () => setSkillsOpen(false) });
