import { t } from "./i18n.js";
import { escape } from "./utils.js";
import { currentSessionId, agentInfo } from "./state.js";
import { toast } from "./toast.js";

const saPanel = document.getElementById("subagent-panel");
const saToggle = document.getElementById("sa-toggle");
const saClose = document.getElementById("sa-close");
const saBody = document.getElementById("sa-body");
const saTypes = document.getElementById("sa-types");

const LS_SA = "ash.sa-open";

// ── Subagent type definitions ──────────────────────────────────────

// Icons stay frontend-side; all other metadata is fetched from
// GET /<id>/sa-types (mirrors SUBAGENT_TYPES in src/bridges/ash.ts).
const SA_ICONS = { plan: "✦", explore: "◈", review: "◆", research: "⚗", implement: "⚒" };

// Fallback metadata when the sa-types endpoint is unavailable.
// Keep in sync with SUBAGENT_TYPES in src/bridges/ash.ts.
const FALLBACK_TYPES = {
  plan: {
    description: "Create a detailed step-by-step plan for a complex task.",
    tools: [],
    maxIterations: 1,
    budgetTokens: 4000,
  },
  explore: {
    description: "Explore and search the codebase to answer questions.",
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 15,
    budgetTokens: 8000,
  },
  review: {
    description: "Review code for bugs, style issues, and improvements.",
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 30,
    budgetTokens: 16000,
  },
  research: {
    description: "Deep investigation of code structure and dependencies.",
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 20,
    budgetTokens: 10000,
  },
  implement: {
    description: "Implement a feature or change end-to-end.",
    tools: ["*"],
    maxIterations: 25,
    budgetTokens: 12000,
  },
};

const formatTools = (tools) => {
  if (!Array.isArray(tools) || !tools.length) return "None";
  if (tools.includes("*")) return "All tools";
  return tools.join(", ");
};

// ── Render ─────────────────────────────────────────────────────────

export const renderSubagentPanel = () => {
  if (!saTypes) return;
  const sid = currentSessionId();

  fetch(`/${sid}/sa-types`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(d => {
      const list = Array.isArray(d) ? d : d?.types;
      if (!Array.isArray(list) || !list.length) throw new Error("empty sa-types");
      return list;
    })
    .catch(() => Object.entries(FALLBACK_TYPES).map(([type, cfg]) => ({ type, ...cfg })))
    .then(renderCards);
};

const renderCards = (types) => {
  saTypes.innerHTML = "";
  for (const cfg of types) {
    const card = document.createElement("div");
    card.className = "skill-card";
    card.dataset.type = cfg.type;
    card.innerHTML =
      `<span class="sa-type-icon">${SA_ICONS[cfg.type] ?? "◇"}</span>` +
      `<div class="skill-card-main">` +
        `<div class="skill-card-header">` +
          `<span class="skill-name">${escape(cfg.type)}</span>` +
          `<span class="skill-tag">≤${Number(cfg.budgetTokens ?? 0).toLocaleString()} tk</span>` +
        `</div>` +
        `<div class="skill-desc">${escape(cfg.description)}</div>` +
        `<div class="skill-meta">` +
          `<span>🛠 ${escape(formatTools(cfg.tools))}</span>` +
          `<span>↻ ${cfg.maxIterations} iter</span>` +
        `</div>` +
        `<div class="sa-model-line"><span class="sa-model-label">Model: inherit</span></div>` +
      `</div>`;
    saTypes.appendChild(card);
  }

  // Async: fetch models + current overrides and add dropdowns
  loadModelDropdowns();
};

// Overrides set under another provider match no listed option; insert one
// showing the raw value (annotated with its provider) instead of silently
// displaying "inherit".
const ensureOverrideOption = (select, value) => {
  if (value === "inherit") return;
  if (Array.from(select.options).some(o => o.value === value)) return;
  const at = value.lastIndexOf("@");
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = at > 0 ? `${value.slice(0, at)} (${value.slice(at + 1)})` : value;
  select.appendChild(opt);
};

// Sequence guard for sa-model writes: a stale PUT-failure re-read must not
// reset the select after a newer change.
let saModelSeq = 0;

const loadModelDropdowns = () => {
  const sid = currentSessionId();
  // The backend strips @provider from overrides and reuses the main
  // session's provider, so only the current provider's models are listed.
  const provider = agentInfo.provider || "";
  Promise.all([
    fetch("/api/models").then(r => r.json()),
    fetch(`/${sid}/sa-model`).then(r => r.json()).catch(() => ({ models: {} })),
  ]).then(([d, overridesData]) => {
      const models = [];
      for (const p of (d?.providers ?? [])) {
        if (provider && p?.name !== provider) continue;
        for (const m of (p?.models ?? [])) {
          if (typeof m.id === "string") models.push({ id: m.id, provider: typeof p.name === "string" ? p.name : "" });
        }
      }

      // Replace model labels with select dropdowns
      const overrides = overridesData?.models ?? {};
      saTypes.querySelectorAll(".sa-model-label").forEach((label) => {
        const type = label.closest(".skill-card")?.dataset.type;
        if (!type) return;
        const wrap = label.parentElement;
        if (!wrap) return;
        label.remove();

        const selected = overrides[type] ?? "inherit";
        const opts = [`<option value="inherit"${selected === "inherit" ? " selected" : ""}>inherit</option>`];
        for (const m of models) {
          const val = `${m.id}@${m.provider}`;
          opts.push(`<option value="${escape(val)}"${selected === val ? " selected" : ""}>${escape(m.id)}</option>`);
        }
        const select = document.createElement("select");
        select.className = "sa-model-select";
        select.dataset.type = type;
        select.innerHTML = opts.join("");
        ensureOverrideOption(select, selected);
        select.value = selected;
        select.addEventListener("change", () => {
          const mySeq = ++saModelSeq;
          fetch(`/${sid}/sa-model`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, model: select.value }),
          })
            .then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              toast(t("sa.model.saved", { type }), { type: "success" });
            })
            .catch(() => {
              toast(t("sa.model.failed", { type }), { type: "error" });
              // Re-read the real value so the select matches the backend.
              fetch(`/${sid}/sa-model`).then(r => r.json())
                .then(d => {
                  if (mySeq !== saModelSeq) return;
                  const v = d?.models?.[type] ?? "inherit";
                  ensureOverrideOption(select, v);
                  select.value = v;
                })
                .catch(() => { if (mySeq === saModelSeq) select.value = "inherit"; });
            });
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
