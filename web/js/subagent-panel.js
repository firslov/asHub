import { t } from "./i18n.js";
import { escape } from "./utils.js";
import { setFilesOpen } from "./files-panel.js";
import { setCtxOpen } from "./context-panel.js";

const saPanel = document.getElementById("subagent-panel");
const saToggle = document.getElementById("sa-toggle");
const saClose = document.getElementById("sa-close");
const saBody = document.getElementById("sa-body");
const saTypes = document.getElementById("sa-types");
const saMeta = document.getElementById("sa-meta");

const LS_SA = "ash.sa-open";

// ── Subagent type definitions (mirrored from ash.ts SUBAGENT_TYPES) ──

const SUBAGENT_TYPES = {
  plan: {
    icon: "✦",
    description: "Create a detailed step-by-step plan for a complex task.",
    tools: "None",
    maxIterations: 1,
    budgetTokens: 4000,
  },
  explore: {
    icon: "◈",
    description: "Explore and search the codebase to answer questions.",
    tools: "glob, grep, read_file, ls",
    maxIterations: 15,
    budgetTokens: 8000,
  },
  review: {
    icon: "◆",
    description: "Review code for bugs, style issues, and improvements.",
    tools: "glob, grep, read_file, ls",
    maxIterations: 10,
    budgetTokens: 6000,
  },
  research: {
    icon: "⚗",
    description: "Deep investigation of code structure and dependencies.",
    tools: "glob, grep, read_file, ls",
    maxIterations: 20,
    budgetTokens: 10000,
  },
  implement: {
    icon: "⚒",
    description: "Implement a feature or change end-to-end.",
    tools: "All tools",
    maxIterations: 25,
    budgetTokens: 12000,
  },
};

// ── Render ─────────────────────────────────────────────────────────

export const renderSubagentPanel = () => {
  if (!saTypes) return;

  saTypes.innerHTML = "";
  for (const [name, cfg] of Object.entries(SUBAGENT_TYPES)) {
    const card = document.createElement("div");
    card.className = "skill-card";
    card.innerHTML =
      `<span class="sa-type-icon">${cfg.icon}</span>` +
      `<div class="skill-card-main">` +
        `<div class="skill-card-header">` +
          `<span class="skill-name">${escape(name)}</span>` +
          `<span class="skill-tag">≤${cfg.budgetTokens.toLocaleString()} tk</span>` +
        `</div>` +
        `<div class="skill-desc">${escape(cfg.description)}</div>` +
        `<div class="skill-meta">` +
          `<span>🛠 ${escape(cfg.tools)}</span>` +
          `<span>↻ ${cfg.maxIterations} iter</span>` +
        `</div>` +
      `</div>`;
    saTypes.appendChild(card);
  }
};

// ── Toggle ─────────────────────────────────────────────────────────

export const setSgOpen = (on) => {
  if (!saPanel) return;
  if (on) {
    // Mutually exclusive: close other panels
    try { setFilesOpen(false); } catch {}
    try { setCtxOpen(false); } catch {}
    // Also close skills overlay, config, etc.
    const skillsOverlay = document.getElementById("skills-overlay");
    if (skillsOverlay && !skillsOverlay.hidden) {
      import("./skills-panel.js").then((m) => m.setSkillsOpen?.(false));
    }
    const configOverlay = document.getElementById("config-overlay");
    if (configOverlay && !configOverlay.hidden) {
      configOverlay.setAttribute("hidden", "");
    }
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hidden) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
    const treePanel = document.getElementById("tree-panel");
    if (treePanel && !treePanel.hasAttribute("hidden")) {
      treePanel.setAttribute("hidden", "");
      document.getElementById("tree-toggle")?.classList.remove("active");
    }

    saPanel.removeAttribute("hidden");
    saToggle?.classList.add("active");
    document.querySelector(".app")?.classList.add("sa-open");
    renderSubagentPanel();
  } else {
    saPanel.setAttribute("hidden", "");
    saToggle?.classList.remove("active");
    document.querySelector(".app")?.classList.remove("sa-open");
  }
  try { localStorage.setItem(LS_SA, on ? "1" : "0"); } catch {}
};

saToggle?.addEventListener("click", () => setSgOpen(saPanel.hasAttribute("hidden")));
saClose?.addEventListener("click", () => setSgOpen(false));
