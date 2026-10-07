import { effect } from "../vendor/signals-core.js";
import { activeSessionId, activeSession, openTab } from "./session-manager.js";
import { createSession } from "./sidebar.js";
import { t, lang } from "./i18n.js";
import { toast } from "./toast.js";
import {
  loadProviderCatalog,
  providerLabel,
  saveProviderApiKey,
} from "./config-panel.js";

const panel = document.getElementById("no-session-empty");
const cta = document.getElementById("no-session-cta");

// Older versions stored an unbound query across navigation. Discard it:
// no session id means there is no safe destination for automatic submission.
try { sessionStorage.removeItem("ash.pending-query"); } catch {}

cta?.addEventListener("click", () => {
  document.getElementById("new-session")?.click();
});

// Localized template query: prefer data-query-{lang}, fall back to data-query.
const pickQuery = (btn) => {
  const attr = lang.value === "zh" ? "queryZh" : "queryEn";
  return btn.dataset[attr] || btn.dataset.query || "";
};

// Content frames rendered by session-view (see exitReplayMode there); any of
// these in the stream means the session already has history.
const SESSION_CONTENT_SELECTOR =
  ".turn-sep, .agent-box, .tool-row, .thinking-block, .shell-block";

// Submit only to the session returned by this exact creation request.
// If the user navigates away, preserve their current conversation and draft.
const submitQueryWhenReady = (query, sessionId, timeoutMs = 15000) => {
  const stop = () => { clearInterval(check); clearTimeout(timer); };
  const check = setInterval(() => {
    if (activeSessionId.peek() !== sessionId) { stop(); return; }
    const input = document.getElementById("query");
    const sv = activeSession.peek();
    if (!input || input.disabled || !sv || sv.id !== sessionId || sv.state?.replaying) return;
    if (sv.streamEl?.querySelector(SESSION_CONTENT_SELECTOR) || input.value.trim()) { stop(); return; }
    stop();
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form?.requestSubmit();
  }, 100);
  const timer = setTimeout(stop, timeoutMs);
};

panel?.querySelectorAll(".stream-empty-prompt.template").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const query = pickQuery(btn);
    if (!query) return;
    const id = await createSession({ navigate: false });
    if (!id) return;
    openTab(id);
    submitQueryWhenReady(query, id);
  });
});

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
let onboardingCheckSeq = 0;
let onboardingTexts = null;
document.addEventListener("langchange", () => {
  if (!onboardingEl) return;
  onboardingTexts?.();
  setTemplatesEnabled(false);
});

const removeOnboarding = () => {
  ++onboardingCheckSeq;
  onboardingTexts = null;
  onboardingEl?.remove();
  onboardingEl = null;
  if (templatesEl) templatesEl.hidden = false;
  setTemplatesEnabled(true);
};

const renderOnboarding = async (request) => {
  if (!templatesEl || onboardingEl) return;
  const catalog = await loadProviderCatalog();
  if (request !== onboardingCheckSeq || onboardingEl) return;
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
  select.replaceChildren(...providerIds.map(id => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = providerLabel(id);
    return option;
  }));
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
  onboardingTexts = applyTexts;
  applyTexts();

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
  const request = ++onboardingCheckSeq;
  let cfg;
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    cfg = await r.json();
  } catch {
    return;
  }
  if (request !== onboardingCheckSeq) return;
  if (hasAnyApiKey(cfg)) { removeOnboarding(); return; }
  setTemplatesEnabled(false);
  await renderOnboarding(request);
};
document.addEventListener("ash:models-changed", checkFirstRun);
checkFirstRun();
