import { effect } from "../vendor/signals-core.js";
import { activeSessionId } from "./session-manager.js";
import { t, lang } from "./i18n.js";
import { toast } from "./toast.js";
import {
  loadProviderCatalog,
  providerLabel,
  saveProviderApiKey,
} from "./config-panel.js";

const panel = document.getElementById("no-session-empty");
const cta = document.getElementById("no-session-cta");

const PENDING_QUERY_KEY = "ash.pending-query";

cta?.addEventListener("click", () => {
  document.getElementById("new-session")?.click();
});

// Localized template query: prefer data-query-{lang}, fall back to data-query.
const pickQuery = (btn) => {
  const attr = lang.value === "zh" ? "queryZh" : "queryEn";
  return btn.dataset[attr] || btn.dataset.query || "";
};

const clearPendingQuery = () => {
  try { sessionStorage.removeItem(PENDING_QUERY_KEY); } catch {}
};

// Content frames rendered by session-view (see exitReplayMode there); any of
// these in the stream means the session already has history.
const SESSION_CONTENT_SELECTOR =
  ".turn-sep, .agent-box, .tool-row, .thinking-block, .shell-block";

// Poll until the composer input is ready, then submit the query — but only
// into an empty session: a stale pending query must never land in a session
// that already has history (e.g. the user switched sessions mid-create).
const submitQueryWhenReady = (query, timeoutMs, { onSubmitted, onGiveUp } = {}) => {
  const giveUp = () => {
    clearInterval(check);
    clearTimeout(timer);
    onGiveUp?.();
  };
  const check = setInterval(() => {
    const input = document.getElementById("query");
    if (!input || input.disabled) return;
    const sv = document.querySelector("session-view");
    if (sv) {
      if (sv.state?.replaying) return; // history still loading — wait
      if (sv.streamEl?.querySelector(SESSION_CONTENT_SELECTOR)) {
        giveUp(); // non-empty session — drop the pending query
        return;
      }
    }
    clearInterval(check);
    clearTimeout(timer);
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form?.requestSubmit();
    onSubmitted?.();
  }, 100);
  const timer = setTimeout(giveUp, timeoutMs);
};

// Quick-start templates: create session and submit query in one click.
panel?.querySelectorAll(".stream-empty-prompt.template").forEach((btn) => {
  btn.addEventListener("click", () => {
    const query = pickQuery(btn);
    if (!query) return;
    // Creating a session navigates via window.location.href, which destroys
    // this JS context (and any polling interval) — persist the query so the
    // new page can pick it up and submit it there.
    try { sessionStorage.setItem(PENDING_QUERY_KEY, query); } catch {}
    document.getElementById("new-session")?.click();
    // Same-page fallback, in case no navigation happens.
    submitQueryWhenReady(query, 5000, {
      onSubmitted: clearPendingQuery,
      onGiveUp: clearPendingQuery, // timeout or non-empty session — don't leave a stale key
    });
  });
});

// Resume a pending template query after a full-page navigation.
let pendingQuery = null;
try {
  pendingQuery = sessionStorage.getItem(PENDING_QUERY_KEY);
  // Take-and-delete up front so it can never be submitted twice.
  if (pendingQuery) sessionStorage.removeItem(PENDING_QUERY_KEY);
} catch {}
if (pendingQuery) {
  submitQueryWhenReady(pendingQuery, 15000);
}

effect(() => {
  if (!panel) return;
  panel.hidden = !!activeSessionId.value;
});

// ── First-run API key onboarding ─────────────────────────────────────
const templatesEl = panel?.querySelector(".stream-empty-templates");
const templateButtons = templatesEl
  ? [...templatesEl.querySelectorAll(".stream-empty-prompt.template")]
  : [];

// Prefer the backend-reported flag (covers env vars and keys files);
// fall back to scanning settings.json apiKeys for older backends.
const hasAnyApiKey = (cfg) => {
  if (cfg?.anyProviderConfigured === true) return true;
  const providers = cfg?.providers;
  if (!providers || typeof providers !== "object") return false;
  return Object.values(providers).some(
    (p) => p && typeof p.apiKey === "string" && p.apiKey.trim()
  );
};

const setTemplatesEnabled = (on) => {
  templateButtons.forEach((btn) => {
    btn.disabled = !on;
    btn.style.opacity = on ? "" : "0.5";
    btn.style.cursor = on ? "" : "not-allowed";
    btn.title = on ? "" : t("onboarding.need.key");
  });
};

let onboardingEl = null;

const removeOnboarding = () => {
  onboardingEl?.remove();
  onboardingEl = null;
  if (templatesEl) templatesEl.hidden = false;
  setTemplatesEnabled(true);
};

const renderOnboarding = async () => {
  if (!templatesEl || onboardingEl) return;
  const catalog = await loadProviderCatalog();
  const ids = (catalog?.providers ?? []).map((p) => p.name);
  const providerIds = ids.length ? ids : ["deepseek", "zhipu", "openrouter"];

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:0.7rem;width:min(340px,100%);text-align:left;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;color:var(--text);";

  const subtitle = document.createElement("span");
  subtitle.className = "config-hint";

  const providerField = document.createElement("div");
  providerField.className = "config-field";
  const providerLabelEl = document.createElement("label");
  providerLabelEl.className = "config-label";
  const selectWrap = document.createElement("div");
  selectWrap.className = "config-select-wrap";
  const select = document.createElement("select");
  select.className = "config-select";
  select.innerHTML = providerIds
    .map((id) => `<option value="${id}">${providerLabel(id)}</option>`)
    .join("");
  selectWrap.appendChild(select);
  providerField.append(providerLabelEl, selectWrap);

  const keyField = document.createElement("div");
  keyField.className = "config-field";
  const keyLabelEl = document.createElement("label");
  keyLabelEl.className = "config-label";
  const keyInput = document.createElement("input");
  keyInput.className = "config-input";
  keyInput.type = "password";
  keyInput.placeholder = "sk-...";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyField.append(keyLabelEl, keyInput);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "bar-btn config-btn-save";
  saveBtn.style.alignSelf = "flex-start";

  wrap.append(title, subtitle, providerField, keyField, saveBtn);
  templatesEl.hidden = true;
  templatesEl.after(wrap);
  onboardingEl = wrap;

  const applyTexts = () => {
    title.textContent = t("onboarding.title");
    subtitle.textContent = t("onboarding.subtitle");
    providerLabelEl.textContent = t("provider");
    keyLabelEl.textContent = t("api.key");
    saveBtn.textContent = t("onboarding.save");
  };
  applyTexts();
  document.addEventListener("langchange", () => {
    if (!onboardingEl) return;
    applyTexts();
    setTemplatesEnabled(false); // refresh the disabled tooltip language
  });

  saveBtn.addEventListener("click", async () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      toast(t("onboarding.key.required"), { type: "error" });
      keyInput.focus();
      return;
    }
    saveBtn.disabled = true;
    const ok = await saveProviderApiKey(select.value, apiKey);
    saveBtn.disabled = false;
    if (ok) removeOnboarding();
  });
};

// Show the onboarding only when no provider has an API key configured.
// Any /api/config failure is silent — the landing page stays as-is.
const checkFirstRun = async () => {
  if (!templatesEl) return;
  let cfg;
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    cfg = await r.json();
  } catch {
    return;
  }
  if (hasAnyApiKey(cfg)) return;
  setTemplatesEnabled(false);
  renderOnboarding();
};
checkFirstRun();
