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
  void createSession();
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

// Seed a draft only in the session returned by this exact creation request.
// If the user navigates away, preserve their current conversation and draft.
const fillDraftWhenReady = (query, sessionId, timeoutMs = 15000) => {
  const stop = () => { clearInterval(check); clearTimeout(timer); };
  const check = setInterval(() => {
    if (activeSessionId.peek() !== sessionId) { stop(); return; }
    const input = document.getElementById("query");
    const sv = activeSession.peek();
    if (!input || input.disabled || !sv || sv.id !== sessionId || sv.state?.replaying) return;
    if (sv.streamEl?.querySelector(SESSION_CONTENT_SELECTOR) || input.value) { stop(); return; }
    stop();
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }, 100);
  const timer = setTimeout(stop, timeoutMs);
};

panel?.querySelectorAll(".stream-empty-prompt.template").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const query = pickQuery(btn);
    if (!query) return;
    const id = await createSession({ navigate: false });
    if (!id || (activeSessionId.peek() && activeSessionId.peek() !== id)) return;
    openTab(id);
    fillDraftWhenReady(query, id);
  });
});

effect(() => {
  if (!panel) return;
  panel.hidden = !!activeSessionId.value;
});

// ── First-run API key onboarding ─────────────────────────────────────
const templatesEl = panel?.querySelector(".stream-empty-templates");
const setup = document.getElementById("welcome-setup");
const select = document.getElementById("welcome-provider");
const keyInput = document.getElementById("welcome-api-key");
const saveBtn = setup?.querySelector('button[type="submit"]');

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

let onboardingCheckSeq = 0;
const finishOnboarding = (restoreFocus = false) => {
  ++onboardingCheckSeq;
  const hadFocus = !setup.hidden && setup.contains(document.activeElement);
  if (!setup.hidden) setup.reset();
  setup.hidden = true;
  templatesEl.hidden = false;
  if (!panel.hidden && (hadFocus || (restoreFocus && document.activeElement === document.body))) {
    cta.focus();
  }
};

setup?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (setup.hidden || saveBtn.disabled || !select.value) return;
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    toast(t("onboarding.key.required"), { type: "error" });
    keyInput.focus();
    return;
  }
  const restoreFocus = setup.contains(document.activeElement);
  saveBtn.disabled = true;
  try {
    if (await saveProviderApiKey(select.value, apiKey)) finishOnboarding(restoreFocus);
  } finally {
    saveBtn.disabled = false;
  }
});

// Show the onboarding only when no provider has an API key configured.
// Any /api/config failure is silent — the landing page stays as-is.
const checkFirstRun = async () => {
  if (!templatesEl || !setup || !select) return;
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
  if (hasAnyApiKey(cfg)) { finishOnboarding(); return; }
  templatesEl.hidden = true;
  if (!setup.hidden) return;
  const catalog = await loadProviderCatalog();
  if (request !== onboardingCheckSeq) return;
  const ids = (catalog?.providers ?? []).map((p) => p.name);
  const providerIds = ids.length ? ids : ["deepseek", "zhipu", "openrouter"];
  select.replaceChildren(...providerIds.map(id => new Option(providerLabel(id), id)));
  setup.hidden = false;
};
document.addEventListener("ash:models-changed", checkFirstRun);
checkFirstRun();
