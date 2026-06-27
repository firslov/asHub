import { t } from "./i18n.js";
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
  const tab = e.target.closest(".skills-source-tab");
  if (!tab || tab.classList.contains("active")) return;
  skillsSourceTabs.querySelectorAll(".skills-source-tab").forEach((t) => t.classList.toggle("active", t === tab));
  currentSource = tab.dataset.source;
  refreshSkills();
});

// ── Tab switching ──

skillsTabs?.addEventListener("click", (e) => {
  const tab = e.target.closest(".skills-tab");
  if (!tab) return;
  const panel = tab.dataset.tab;
  skillsTabs.querySelectorAll(".skills-tab").forEach((t) => t.classList.toggle("active", t === tab));
  document.getElementById("skills-panel-market")?.toggleAttribute("hidden", panel !== "market");
  document.getElementById("skills-panel-installed")?.toggleAttribute("hidden", panel !== "installed");
  if (panel === "installed") refreshInstalled();
});

// ── Overlay toggle ──

export const setSkillsOpen = (on) => {
  if (!skillsOverlay) return;
  if (on) {
    // Close other panels for mutual exclusion
    import("./files-panel.js").then((m) => m.setFilesOpen?.(false));
    import("./context-panel.js").then((m) => m.setCtxOpen?.(false));
    import("./tree-panel.js").then((m) => m.setTreeOpen?.(false));
    import("./config-panel.js").then((m) => m.setConfigOpen(false));
    import("./subagent-panel.js").then((m) => m.setSgOpen?.(false));
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
    skillsOverlay.removeAttribute("hidden");
    skillsOverlay.classList.add("open");
    skillsToggle?.classList.add("active");
    initSkillsPanel();
  } else {
    skillsOverlay.setAttribute("hidden", "");
    skillsOverlay.classList.remove("open");
    skillsToggle?.classList.remove("active");
  }
};

if (skillsToggle) {
  skillsToggle.addEventListener("click", () => setSkillsOpen(skillsOverlay.hasAttribute("hidden")));
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
  if (skillsList) skillsList.innerHTML = `<div class="skills-loading">${t("skills.loading")}</div>`;
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
    if (skillsList) skillsList.innerHTML = `<div class="skills-error">${err.message}</div>`;
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
    return `<div class="skill-card">
      <div class="skill-card-main">
        <div class="skill-card-header">
          <img class="skill-avatar" src="${s.avatar}&s=40" alt="" width="20" height="20" loading="lazy" />
          <span class="skill-name">${esc(s.displayName || s.name)}</span>
          ${s.topics?.slice(0, 3).map((tag) => `<span class="skill-tag">${esc(tag)}</span>`).join("") || ""}
        </div>
        <div class="skill-desc">${esc(s.description || "")}</div>
        <div class="skill-meta">
          <span class="skill-author">${esc(s.author)}</span>
          <span class="skill-updated">${s.updated || ""}</span>
        </div>
      </div>
      <button class="skill-install-btn ${isInstalled ? "installed" : ""}" data-id="${s.id}" data-name="${s.name}">
        ${isInstalled ? t("skills.installed") : t("skills.install")}
      </button>
    </div>`;
  }).join("") || `<div class="skills-empty">${query ? t("skills.noresults") : t("skills.empty")}</div>`;

  // Attach install handlers
  skillsList.querySelectorAll(".skill-install-btn").forEach((btn) => {
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
            btn.textContent = "❌";
            setTimeout(() => { btn.textContent = t("skills.install"); }, 2000);
          }
        } catch {
          btn.textContent = "❌";
          setTimeout(() => { btn.textContent = t("skills.install"); }, 2000);
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
      ? list.map((s) => `<div class="skill-installed-item">
          <span class="skill-installed-name">${esc(s.name)}</span>
          <button class="skill-remove-btn" data-name="${esc(s.name)}" title="${t("skills.uninstall")}">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
            </svg>
          </button>
        </div>`).join("")
      : `<div class="skills-empty">${t("skills.none")}</div>`;
    // Attach remove handlers
    installedList.querySelectorAll(".skill-remove-btn").forEach((btn) => {
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
