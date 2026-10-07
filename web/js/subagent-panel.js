import { t } from "./i18n.js";
import { escape } from "./utils.js";
import { currentSessionId, agentInfo } from "./state.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { toast } from "./toast.js";
import { setModelCache } from "./sse.js";

const saPanel = document.getElementById("subagent-panel");
const saToggle = document.getElementById("sa-toggle");
const saClose = document.getElementById("sa-close");
const saBody = document.getElementById("sa-body");
const saTypes = document.getElementById("sa-types");

const LS_SA = "ash.sa-open";

// ── Subagent type definitions ──────────────────────────────────────

// Fallback metadata when the sa-types endpoint is unavailable.
// Keep in sync with SUBAGENT_TYPES in src/bridges/ash.ts.
const FALLBACK_TYPES = {
  plan: {
    description: "Create a detailed step-by-step plan for a complex task.",
    tools: [],
    maxIterations: 1,
    budgetTokens: 6000,
    reasoning: "low",
  },
  explore: {
    description: "Explore and search the codebase to answer questions.",
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 25,
    budgetTokens: 30000,
    reasoning: "low",
  },
  review: {
    description: "Review code for bugs, style issues, and improvements.",
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 60,
    budgetTokens: 64000,
    reasoning: "medium",
  },
  research: {
    description: "Deep investigation of code structure and dependencies.",
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 30,
    budgetTokens: 40000,
    reasoning: "medium",
  },
  implement: {
    description: "Implement a feature or change end-to-end.",
    tools: ["*"],
    maxIterations: 40,
    budgetTokens: 40000,
    reasoning: "low",
  },
};

const REASONING_LEVELS = ["off", "low", "medium", "high", "xhigh"];

// 60000 → "60k", 64000 → "64k", 32500 → "32.5k", 900 → "900".
const fmtTokens = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(v);
};

const formatTools = (tools) => {
  if (!Array.isArray(tools) || !tools.length) return "None";
  if (tools.includes("*")) return "All tools";
  return tools.join(", ");
};

// ── Render ─────────────────────────────────────────────────────────

// Session the cards were built for — repeat opens of the same session
// reuse the DOM; only a session switch re-renders.
let _renderedSid = null;
// Signature of the model list currently baked into the selects — options
// are rebuilt only when the catalog (or provider filter) changes.
let _optionsSig = "";

// ── Shared model catalog cache ─────────────────────────────────────
// sse.js owns the canonical /api/models cache but exposes no getter, so
// keep a local copy, prime sse's cache on fetch (setModelCache), and drop
// ours when config-panel broadcasts ash:models-changed after a save.
let _modelsCache = null;
let _modelsPromise = null;
let _modelsGeneration = 0;

const fetchModelsCatalog = () => {
  // Mirror sse.js: an OpenRouter catalog stuck at ≤1 model means its async
  // catalog fetch had not finished when cached — retry.
  const stale = _modelsCache?.providers?.some(
    (p) => p.name === "openrouter" && (p.models?.length || 0) <= 1
  );
  if (_modelsCache && !stale) return Promise.resolve(_modelsCache);
  if (!_modelsPromise) {
    const generation = _modelsGeneration;
    const pending = fetch("/api/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (generation !== _modelsGeneration) return fetchModelsCatalog();
        if (setModelCache(d) === false) throw new Error("Invalid model catalog");
        _modelsCache = d;
        return d;
      })
      .catch(() => generation !== _modelsGeneration ? fetchModelsCatalog() : _modelsCache ?? null)
      .finally(() => { if (_modelsPromise === pending) _modelsPromise = null; });
    _modelsPromise = pending;
  }
  return _modelsPromise;
};

document.addEventListener("ash:models-changed", () => {
  _modelsGeneration++;
  _modelsCache = null;
  _modelsPromise = null;
});

let panelRenderSeq = 0;
export const renderSubagentPanel = function renderSubagentPanel() {
  if (!saTypes) return;
  const sid = currentSessionId();
  const request = ++panelRenderSeq;
  if (!sid) {
    ++modelRefreshSeq;
    _renderedSid = null;
    _optionsSig = "";
    saTypes.innerHTML = `<div class="p-empty">${escape(t("no.session.title"))}</div>`;
    return;
  }
  const protectEdits = _renderedSid === sid;
  if (!protectEdits) {
    saTypes.innerHTML = "";
    _renderedSid = null;
  }
  const budgetChange = saBudgetSeq;
  const modelChange = saModelSeq;

  fetch(`/${sid}/sa-types`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(d => {
      const list = Array.isArray(d) ? d : d?.types;
      if (!Array.isArray(list) || !list.length) throw new Error("empty sa-types");
      return list;
    })
    .catch(() => Object.entries(FALLBACK_TYPES).map(([type, cfg]) => ({ type, ...cfg })))
    .then((list) => {
      // Session switched again while sa-types was in flight — the newer
      // render owns the panel now.
      if (sid !== currentSessionId() || request !== panelRenderSeq) return;
      if (budgetChange !== saBudgetSeq || modelChange !== saModelSeq) {
        // Keep current edits, but a newly cleared panel needs a fresh read.
        if (!protectEdits || _renderedSid !== sid) renderSubagentPanel();
        else document.dispatchEvent(new Event("ash:subagent-budget-deferred"));
        return;
      }
      if (_renderedSid === sid && (
        Array.from(saTypes.querySelectorAll(".sa-card")).some(card => Object.values(card._budgetSaving ?? {}).some(Boolean))
        || Array.from(saTypes.querySelectorAll(".sa-model-select")).some(select => select._modelSaving)
        || saTypes.querySelectorAll(".sa-meta-input").length > 0
      )) {
        document.dispatchEvent(new Event("ash:subagent-budget-deferred"));
        return;
      }
      _renderedSid = sid;
      _optionsSig = "";
      renderCards(list);
      document.dispatchEvent(new Event("ash:subagent-budget-rendered"));
    });
};

const accessBadge = (tools) =>
  !Array.isArray(tools) || !tools.length ? t("sa.badge.none")
  : tools.includes("*") ? t("sa.badge.full")
  : t("sa.badge.readonly");

const renderCards = (types) => {
  saTypes.innerHTML = "";
  for (const cfg of types) {
    const toolsText = formatTools(cfg.tools);
    const card = document.createElement("div");
    card.className = "p-card sa-card";
    card.dataset.type = cfg.type;
    card._saCfg = cfg;
    card.innerHTML =
      `<div class="sa-card-head">` +
        `<span class="sa-name">${escape(cfg.type)}</span>` +
        `<span class="p-badge">${escape(accessBadge(cfg.tools))}</span>` +
      `</div>` +
      `<div class="sa-desc">${escape(cfg.description)}</div>` +
      `<div class="sa-tools" title="${escape(toolsText)}">${escape(toolsText)}</div>` +
      `<div class="sa-meta"></div>` +
      `<div class="sa-model-row"><span class="sa-model-label">${escape(t("model"))}</span></div>`;
    saTypes.appendChild(card);
  }

  // Async: budget/iteration/reasoning controls, then one select per card,
  // then fill options + overrides.
  buildBudgetControls();
  buildModelSelects();
  refreshModelDropdowns();
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

// ── Budget / iteration / reasoning controls ────────────────────────

// Sequence guard for sa-budget writes: a stale PUT-failure re-read must not
// reset a control after a newer change (mirrors saModelSeq below).
let saBudgetSeq = 0;

const metaLabel = (field, v) =>
  field === "budgetTokens" ? `${fmtTokens(v)} tk` : `↻ ${v}`;

// PUT one budget field; on failure re-read sa-types and restore the
// control's value to the backend's effective one.
const commitBudgetField = (card, field, value, restore) => {
  const sid = currentSessionId();
  if (!sid) return;
  const type = card.dataset.type;
  const mySeq = ++saBudgetSeq;
  card._budgetSeq ??= {};
  card._budgetSeq[field] = mySeq;
  card._budgetSaving ??= {};
  card._budgetSaving[field] = true;
  fetch(`/${sid}/sa-budget`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, [field]: value }),
  })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast(t(field === "reasoning" ? "sa.reasoning.saved" : "sa.budget.saved", { type }), { type: "success" });
    })
    .catch(() => {
      toast(t(field === "reasoning" ? "sa.reasoning.failed" : "sa.budget.failed", { type }), { type: "error" });
      // Re-read the effective values so the card matches the backend.
      return fetch(`/${sid}/sa-types`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(d => {
          if (mySeq !== card._budgetSeq[field]) return;
          // Session switched while the re-read was in flight — don't write
          // the old session's values into the new one's card.
          if (sid !== currentSessionId()) return;
          const list = Array.isArray(d) ? d : d?.types;
          restore(list?.find?.(e => e?.type === type) ?? null);
        })
        .catch(() => { if (mySeq === card._budgetSeq[field] && sid === currentSessionId()) restore(null); });
    }).finally(() => {
      ++saBudgetSeq;
      if (mySeq === card._budgetSeq[field]) card._budgetSaving[field] = false;
      if (sid !== currentSessionId()) document.dispatchEvent(new Event("ash:subagent-budget-changed"));
      else document.dispatchEvent(new Event("ash:subagent-budget-settled"));
    });
};

const makeMetaButton = (field, value) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sa-meta-btn";
  btn.dataset.field = field;
  btn.dataset.value = String(value);
  btn.textContent = metaLabel(field, value);
  btn.title = t(field === "budgetTokens" ? "sa.budget.title" : "sa.iters.title");
  btn.addEventListener("click", () => startNumberEdit(btn));
  return btn;
};

// Click-to-edit: swap the value button for a number input; Enter/blur
// commits, Esc cancels.  Optimistically shows the new value; a failed PUT
// restores the backend value via the re-read in commitBudgetField.
const startNumberEdit = (btn) => {
  const field = btn.dataset.field;
  const oldVal = Number(btn.dataset.value) || 0;
  const card = btn.closest(".sa-card");
  if (card) {
    card._budgetValues ??= {};
    card._budgetValues[field] ??= oldVal;
  }
  const input = document.createElement("input");
  input.type = "number";
  input.className = "p-input sa-meta-input";
  input.min = "1";
  input.step = field === "budgetTokens" ? "1000" : "1";
  input.value = String(oldVal);
  btn.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const settle = (commit) => {
    if (settled) return;
    settled = true;
    const val = Math.round(Number(input.value));
    const effective = card?._budgetValues[field] ?? oldVal;
    const accepted = commit && Number.isFinite(val) && val > 0 && val !== effective;
    const fresh = makeMetaButton(field, accepted ? val : effective);
    input.replaceWith(fresh);
    if (!accepted || !card) {
      document.dispatchEvent(new Event("ash:subagent-budget-settled"));
      return;
    }
    card._budgetValues[field] = val;
    commitBudgetField(card, field, val, (entry) => {
      const v = Number(entry?.[field]);
      const restored = Number.isFinite(v) && v > 0 ? v : effective;
      card._budgetValues[field] = restored;
      // The original button may now be an input or a newer button. Keep
      // an in-progress draft intact; its cancel path reads the shared value.
      const visible = card.querySelector(`.sa-meta-btn[data-field="${field}"]`);
      if (visible) {
        visible.dataset.value = String(restored);
        visible.textContent = metaLabel(field, restored);
      }
    });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); settle(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); settle(false); }
  });
  input.addEventListener("blur", () => settle(true));
};

const makeReasoningSelect = (type, current) => {
  const select = document.createElement("select");
  select.className = "p-select sa-reasoning";
  select.title = t("sa.reasoning.title");
  select.innerHTML = REASONING_LEVELS.map(l => `<option value="${l}">${l}</option>`).join("");
  const initial = REASONING_LEVELS.includes(current) ? current : (FALLBACK_TYPES[type]?.reasoning ?? "low");
  select.value = initial;
  select.dataset.prev = initial;
  select.addEventListener("change", () => {
    const card = select.closest(".sa-card");
    if (!card) return;
    const prev = select.dataset.prev;
    const value = select.value;
    select.dataset.prev = value;
    commitBudgetField(card, "reasoning", value, (entry) => {
      const v = typeof entry?.reasoning === "string" ? entry.reasoning : prev;
      select.value = REASONING_LEVELS.includes(v) ? v : prev;
      select.dataset.prev = select.value;
    });
  });
  return select;
};

// Budget tokens / iteration cap / reasoning level for each card — the
// effective values (incl. user overrides) reported by sa-types, falling
// back to FALLBACK_TYPES when a field is absent.
const buildBudgetControls = () => {
  saTypes.querySelectorAll(".sa-card").forEach((card) => {
    const meta = card.querySelector(".sa-meta");
    const cfg = card._saCfg;
    const type = card.dataset.type;
    if (!meta || !cfg || !type) return;
    const fallback = FALLBACK_TYPES[type] ?? {};
    const budget = Number(cfg.budgetTokens) || fallback.budgetTokens || 0;
    const iters = Number(cfg.maxIterations) || fallback.maxIterations || 0;
    meta.appendChild(makeMetaButton("budgetTokens", budget));
    meta.appendChild(makeMetaButton("maxIterations", iters));
    meta.appendChild(makeReasoningSelect(type, cfg.reasoning));
  });
};

// Sequence guard for sa-model writes: a stale PUT-failure re-read must not
// reset the select after a newer change.
let saModelSeq = 0;

// Create one select per type card (once per render).  Options and values
// are filled by refreshModelDropdowns.
const buildModelSelects = () => {
  saTypes.querySelectorAll(".sa-model-label").forEach((label) => {
    const type = label.closest(".sa-card")?.dataset.type;
    if (!type) return;
    const wrap = label.parentElement;
    if (!wrap) return;
    label.remove();

    const select = document.createElement("select");
    select.className = "p-select sa-model-select";
    select.dataset.type = type;
    select.innerHTML = `<option value="inherit">${escape(t("loading"))}</option>`;
    select.disabled = true;
    select.addEventListener("change", () => {
      ++saModelSeq;
      const mySeq = select._modelSeq = (select._modelSeq ?? 0) + 1;
      select._modelSaving = true;
      const value = select.value;
      const previous = select.dataset.confirmed ?? "inherit";
      const sid = currentSessionId();
      if (!sid) { select._modelSaving = false; return; }
      fetch(`/${sid}/sa-model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, model: value }),
      })
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          if (mySeq === select._modelSeq) select.dataset.confirmed = value;
          toast(t("sa.model.saved", { type }), { type: "success" });
        })
        .catch(() => {
          toast(t("sa.model.failed", { type }), { type: "error" });
          // Re-read the real value so the select matches the backend.
          return fetch(`/${sid}/sa-model`).then(async r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            if (!data?.models || typeof data.models !== "object" || Array.isArray(data.models)
              || Object.values(data.models).some(value => typeof value !== "string")) throw new Error("Invalid subagent model settings");
            return data;
          })
            .then(d => {
              if (mySeq !== select._modelSeq) return;
              // Session switched while the re-read was in flight — don't
              // write the old session's override into the new one's select.
              if (sid !== currentSessionId()) return;
              const v = d?.models?.[type] ?? "inherit";
              ensureOverrideOption(select, v);
              select.value = v;
              select.dataset.confirmed = v;
            })
            .catch(() => { if (mySeq === select._modelSeq && sid === currentSessionId()) select.value = select.dataset.confirmed ?? previous; });
        })
        .finally(() => {
          // Invalidate GETs started while this write was pending, even if
          // their responses arrive after the write has completed.
          ++saModelSeq;
          if (mySeq === select._modelSeq) select._modelSaving = false;
          if (sid !== currentSessionId()) document.dispatchEvent(new Event("ash:subagent-model-changed"));
          document.dispatchEvent(new Event("ash:subagent-budget-settled"));
        });
    });
    wrap.appendChild(select);
  });
};

// Fill/refresh the per-card selects: the model catalog comes from the
// shared cache (options rebuilt only when the list changes); the sa-model
// overrides are always re-read for the current session.
let modelRefreshSeq = 0;
const refreshModelDropdowns = function refreshModelDropdowns() {
  const refresh = ++modelRefreshSeq;
  const modelChange = saModelSeq;
  const sid = currentSessionId();
  if (!sid) return;
  // The backend strips @provider from overrides and reuses the main
  // session's provider, so only the current provider's models are listed.
  const provider = agentInfo.provider || "";
  Promise.all([
    fetchModelsCatalog(),
    fetch(`/${sid}/sa-model`).then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data?.models || typeof data.models !== "object" || Array.isArray(data.models)
        || Object.values(data.models).some(value => typeof value !== "string")) throw new Error("Invalid subagent model settings");
      return data;
    }),
  ]).then(([d, overridesData]) => {
      // Session switched while the fetches were in flight — the newer
      // session's render owns the panel; don't write the old session's
      // overrides into its selects.
      if (sid !== currentSessionId() || refresh !== modelRefreshSeq) return;
      if (modelChange !== saModelSeq) {
        // A previous session's save must not strand new dropdowns on inherit.
        // Re-read after the global change; edited controls keep their value.
        if (Array.from(saTypes.querySelectorAll(".sa-model-select")).some(
          select => !select._modelsLoaded && !select._modelSeq && !select._modelSaving
        )) refreshModelDropdowns();
        return;
      }
      const models = [];
      for (const p of (d?.providers ?? [])) {
        if (provider && p?.name !== provider) continue;
        for (const m of (p?.models ?? [])) {
          if (typeof m.id === "string") models.push({ id: m.id, provider: typeof p.name === "string" ? p.name : "" });
        }
      }

      const sig = models.map(m => `${m.id}@${m.provider}`).join("\x1e");
      const rebuild = sig !== _optionsSig;
      const overrides = overridesData?.models ?? {};
      let skipped = false;
      saTypes.querySelectorAll(".sa-model-select").forEach((select) => {
        if (select._modelSaving) { skipped = true; return; }
        const type = select.dataset.type;
        const selected = overrides[type] ?? "inherit";
        if (rebuild || !select._modelsLoaded) {
          const opts = [`<option value="inherit">inherit</option>`];
          for (const m of models) {
            const val = `${m.id}@${m.provider}`;
            opts.push(`<option value="${escape(val)}">${escape(m.id)}</option>`);
          }
          select.innerHTML = opts.join("");
        }
        ensureOverrideOption(select, selected);
        select.value = selected;
        select.dataset.confirmed = selected;
        select._modelsLoaded = true;
        select.disabled = false;
      });
      _optionsSig = skipped ? "" : sig;
    })
    .catch(err => {
      if (sid !== currentSessionId() || refresh !== modelRefreshSeq || modelChange !== saModelSeq) return;
      toast(t("sa.model.load.failed"), { type: "error", detail: String(err?.message ?? err) });
    });
};

// Overrides are global. A save from a departed session also invalidates
// a new panel whose first read happened to finish before that save.
document.addEventListener("ash:subagent-model-changed", () => {
  if (saPanel && !saPanel.hidden) refreshModelDropdowns();
});

let budgetRefreshPending = false;
const refreshDeferredBudget = () => {
  if (!budgetRefreshPending) return;
  if (!saPanel || saPanel.hidden) { _renderedSid = null; return; }
  if (Array.from(saTypes.querySelectorAll(".sa-card")).some(card => Object.values(card._budgetSaving ?? {}).some(Boolean))
    || Array.from(saTypes.querySelectorAll(".sa-model-select")).some(select => select._modelSaving)
    || saTypes.querySelectorAll(".sa-meta-input").length) return;
  renderSubagentPanel();
};
document.addEventListener("ash:subagent-budget-changed", () => {
  budgetRefreshPending = true;
  refreshDeferredBudget();
});
document.addEventListener("ash:subagent-budget-deferred", () => { budgetRefreshPending = true; refreshDeferredBudget(); });
document.addEventListener("ash:subagent-budget-rendered", () => { budgetRefreshPending = false; });
document.addEventListener("ash:subagent-budget-settled", refreshDeferredBudget);

// ── Toggle ─────────────────────────────────────────────────────────

export const setSgOpen = (on) => {
  if (!saPanel) return;
  if (on) {
    saPanel.removeAttribute("hidden");
    document.querySelector(".app")?.classList.add("sa-open");
    saToggle?.classList.add("active");
    // Repeat opens of the same session reuse the rendered cards and
    // selects — only the override values are re-read.  A session switch
    // (or first open) re-renders from scratch.
    if (_renderedSid === currentSessionId() && saTypes?.childElementCount) {
      refreshModelDropdowns();
    } else {
      renderSubagentPanel();
    }
  } else {
    saPanel.setAttribute("hidden", "");
    document.querySelector(".app")?.classList.remove("sa-open");
    saToggle?.classList.remove("active");
  }
};;

saClose?.addEventListener("click", () => setSgOpen(false));

// Re-render when the active session changes while the panel is open.
effect(() => {
  activeSession.value;
  if (saPanel && !saPanel.hidden) renderSubagentPanel();
});

import { registerPanel } from './panel-manager.js';
registerPanel('subagent', { toggleBtnId: 'sa-toggle', panelId: 'subagent-panel', open: () => setSgOpen(true), close: () => setSgOpen(false) });
