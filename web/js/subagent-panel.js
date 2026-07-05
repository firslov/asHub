import { t } from "./i18n.js";
import { escape } from "./utils.js";
import { currentSessionId } from "./state.js";

const saPanel = document.getElementById("subagent-panel");
const saToggle = document.getElementById("sa-toggle");
const saClose = document.getElementById("sa-close");
const saBody = document.getElementById("sa-body");
const saTypes = document.getElementById("sa-types");

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
    budgetTokens: 12000,
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

  // Render cards immediately with static content
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
        `<div class="sa-model-line"><span class="sa-model-label">Model: inherit</span></div>` +
      `</div>`;
    saTypes.appendChild(card);
  }

  // Async: fetch models + current overrides and add dropdowns
  const sid = currentSessionId();
  Promise.all([
    fetch("/api/models").then(r => r.json()),
    fetch(`/${sid}/sa-model`).then(r => r.json()).catch(() => ({ models: {} })),
  ]).then(([d, overridesData]) => {
      const models = [];
      for (const p of (d?.providers ?? [])) {
        for (const m of (p?.models ?? [])) {
          if (typeof m.id === "string") models.push({ id: m.id, provider: typeof p.name === "string" ? p.name : "" });
        }
      }

      // Replace model labels with select dropdowns
      const overrides = overridesData?.models ?? {};
      saTypes.querySelectorAll(".sa-model-label").forEach((label, i) => {
        const type = Object.keys(SUBAGENT_TYPES)[i];
        if (!type) return;
        const wrap = label.parentElement;
        if (!wrap) return;
        label.remove();

        const selected = overrides[type] ?? "inherit";
        let lastProvider = "";
        const opts = [`<option value="inherit"${selected === "inherit" ? " selected" : ""}>inherit</option>`];
        for (const m of models) {
          const val = `${m.id}@${m.provider}`;
          if (m.provider !== lastProvider) {
            if (lastProvider) opts.push('</optgroup>');
            opts.push(`<optgroup label="${escape(m.provider)}">`);
            lastProvider = m.provider;
          }
          opts.push(`<option value="${escape(val)}"${selected === val ? " selected" : ""}>${escape(m.id)}</option>`);
        }
        if (lastProvider) opts.push('</optgroup>');
        const select = document.createElement("select");
        select.className = "sa-model-select";
        select.dataset.type = type;
        select.innerHTML = opts.join("");
        select.addEventListener("change", () => {
          fetch(`/${sid}/sa-model`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, model: select.value }),
          }).catch(() => {});
        });
        wrap.appendChild(select);
      });
    })
    .catch(() => {});
};

// ── Toggle ─────────────────────────────────────────────────────────

export const setSgOpen = (on) => {
  if (!saPanel) return;
  if (on) {
    saPanel.removeAttribute("hidden");
    document.querySelector(".app")?.classList.add("sa-open");
    saToggle?.classList.add("active");
    renderSubagentPanel();
  } else {
    saPanel.setAttribute("hidden", "");
    document.querySelector(".app")?.classList.remove("sa-open");
    saToggle?.classList.remove("active");
  }
};;

saClose?.addEventListener("click", () => setSgOpen(false));

import { registerPanel } from './panel-manager.js';
registerPanel('subagent', { toggleBtnId: 'sa-toggle', panelId: 'subagent-panel', open: () => setSgOpen(true), close: () => setSgOpen(false) });
