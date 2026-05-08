import { setFilesOpen } from "./files-panel.js";
import { setCtxOpen } from "./context-panel.js";
import { t } from "./i18n.js";

const configOverlay = document.getElementById("config-overlay");
const configToggle = document.getElementById("config-toggle");
const configClose = document.getElementById("config-close");
const configReset = document.getElementById("config-reset");

const configBodySimple = document.getElementById("config-body-simple");
const configProvider = document.getElementById("config-provider");
const configProviderDesc = document.getElementById("config-provider-desc");
const configApikey = document.getElementById("config-apikey");
const configApikeyToggle = document.getElementById("config-apikey-toggle");
const configSaveSimple = document.getElementById("config-save-simple");
const configModelField = document.getElementById("config-model-field");
const configModelInput = document.getElementById("config-model");
const configModelList = document.getElementById("config-model-list");
const configModelRefresh = document.getElementById("config-model-refresh");
const configModelHint = document.getElementById("config-model-hint");

const configBodyAdvanced = document.getElementById("config-body-advanced");
const configEditor = document.getElementById("config-editor");
const configSave = document.getElementById("config-save");
const configFormat = document.getElementById("config-format");
const configValid = document.getElementById("config-valid");
const configInvalid = document.getElementById("config-invalid");

const configModeTabs = document.getElementById("config-mode-tabs");

let configMode = "simple";
let originalConfig = "";
let serverConfig = "";
let originalApiKey = "";

const PROVIDERS = {
  deepseek: {
    name: "DeepSeek",
    description: "DeepSeek V4 models with 1M context window",  // i18n'd in updateProviderDesc
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    models: [
      {
        id: "deepseek-v4-pro",
        contextWindow: 1000000,
        maxTokens: 300000,
        echoReasoning: true,
      },
      {
        id: "deepseek-v4-flash",
        contextWindow: 1000000,
        maxTokens: 300000,
        echoReasoning: true,
      },
    ],
  },
  zhipu: {
    name: "Z.AI",
    description: "GLM models with 200K context window",
    baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
    defaultModel: "glm-5.1",
    models: [
      { id: "glm-5.1", contextWindow: 204800, maxTokens: 131072 },
      { id: "glm-5-turbo", contextWindow: 204800, maxTokens: 131072 },
      { id: "glm-4.7", contextWindow: 204800, maxTokens: 131072 },
    ],
  },
  openrouter: {
    name: "OpenRouter",
    description: "Aggregator — pick any model in the OpenRouter catalog",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "",
    models: [],
    dynamicModels: true,
  },
};

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
let openrouterCatalog = null;
let openrouterFetchPromise = null;

const buildConfig = () => {
  const providerId = configProvider.value;
  const apiKey = configApikey.value.trim();
  const providerDef = PROVIDERS[providerId];
  if (!providerDef) return null;

  let existing = {};
  try { existing = JSON.parse(originalConfig || "{}"); } catch {}

  // Preserve existing provider fields, falling back to hardcoded defaults
  const existingProvider =
    existing.providers && typeof existing.providers === "object"
      ? existing.providers[providerId]
      : null;
  const prev = existingProvider && typeof existingProvider === "object"
    ? existingProvider
    : {};

  const providerCfg = {
    baseURL: prev.baseURL ?? providerDef.baseURL,
    apiKey: apiKey || prev.apiKey || "YOUR_API_KEY",
    defaultModel: prev.defaultModel ?? providerDef.defaultModel,
    models: prev.models ?? providerDef.models,
  };

  if (providerDef.dynamicModels) {
    const typed = configModelInput?.value.trim();
    if (typed) {
      providerCfg.defaultModel = typed;
      const known = Array.isArray(prev.models) ? prev.models : [];
      const meta = openrouterCatalog?.find((m) => m.id === typed);
      const merged = known.filter((m) => m && m.id !== typed);
      merged.unshift(meta || { id: typed });
      providerCfg.models = merged;
    }
  }

  // Carry over any extra fields on the existing provider that aren't
  // part of the standard template (e.g. contextWindow, reasoningShape).
  for (const [key, val] of Object.entries(prev)) {
    if (!(key in providerCfg)) {
      providerCfg[key] = val;
    }
  }

  const config = {
    providers: {
      [providerId]: providerCfg,
    },
    defaultProvider: existing.defaultProvider || providerId,
  };

  for (const [key, val] of Object.entries(existing)) {
    if (key !== "providers" && key !== "defaultProvider") {
      config[key] = val;
    }
  }

  // Preserve providers that were configured outside the simple form
  // (e.g. manually in advanced mode). Only the currently-selected
  // provider is rebuilt from the simple form inputs.
  if (existing.providers && typeof existing.providers === "object") {
    for (const [key, val] of Object.entries(existing.providers)) {
      if (!(key in config.providers)) {
        config.providers[key] = val;
      }
    }
  }

  return config;
};

const parseConfigToSimple = (config) => {
  if (!config || typeof config !== "object" || Object.keys(config).length === 0) {
    configProvider.value = "deepseek";
    configApikey.value = "";
    return;
  }

  const dp = config.defaultProvider;
  let detectedProvider = null;
  let detectedApiKey = "";

  if (dp && PROVIDERS[dp]) {
    detectedProvider = dp;
  } else if (config.providers && typeof config.providers === "object") {
    for (const key of Object.keys(config.providers)) {
      if (PROVIDERS[key]) {
        detectedProvider = key;
        break;
      }
    }
  }

  if (detectedProvider) {
    configProvider.value = detectedProvider;
    if (config.providers && config.providers[detectedProvider]) {
      const p = config.providers[detectedProvider];
      if (typeof p.apiKey === "string" && p.apiKey !== "YOUR_API_KEY") {
        detectedApiKey = p.apiKey;
      }
    }
  } else {
    configProvider.value = "deepseek";
  }

  configApikey.value = detectedApiKey;
};

const updateProviderDesc = () => {
  const providerId = configProvider.value;
  if (configProviderDesc) {
    configProviderDesc.textContent = t(`provider.desc.${providerId}`);
  }
};

const renderOpenrouterDatalist = () => {
  if (!configModelList) return;
  const items = openrouterCatalog || [];
  configModelList.innerHTML = items
    .map((m) => {
      const label = m.name && m.name !== m.id ? `${m.id} — ${m.name}` : m.id;
      return `<option value="${m.id}" label="${label.replace(/"/g, "&quot;")}"></option>`;
    })
    .join("");
};

const fetchOpenrouterCatalog = async ({ force = false } = {}) => {
  if (openrouterCatalog && !force) {
    renderOpenrouterDatalist();
    return openrouterCatalog;
  }
  if (openrouterFetchPromise && !force) return openrouterFetchPromise;

  if (configModelHint) configModelHint.textContent = t("model.loading");
  configModelRefresh?.classList.add("loading");

  openrouterFetchPromise = (async () => {
    try {
      const r = await fetch(OPENROUTER_MODELS_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const list = Array.isArray(data?.data) ? data.data : [];
      openrouterCatalog = list
        .map((m) => ({
          id: m.id,
          name: m.name,
          contextWindow: m.context_length,
          maxTokens: m.top_provider?.max_completion_tokens ?? undefined,
        }))
        .filter((m) => m.id);
      renderOpenrouterDatalist();
      if (configModelHint) configModelHint.textContent = t("model.hint");
      return openrouterCatalog;
    } catch (err) {
      console.error("[openrouter] models fetch failed:", err);
      if (configModelHint) configModelHint.textContent = t("model.load.failed");
      return null;
    } finally {
      configModelRefresh?.classList.remove("loading");
      openrouterFetchPromise = null;
    }
  })();

  return openrouterFetchPromise;
};

const updateModelField = () => {
  if (!configModelField) return;
  const providerId = configProvider.value;
  const def = PROVIDERS[providerId];
  const dynamic = !!def?.dynamicModels;
  configModelField.hidden = !dynamic;
  if (!dynamic) return;

  let saved = "";
  try {
    const cfg = JSON.parse(originalConfig || serverConfig || "{}");
    const p = cfg.providers?.[providerId];
    if (p?.defaultModel) saved = p.defaultModel;
    else if (Array.isArray(p?.models) && p.models[0]?.id) saved = p.models[0].id;
  } catch {}
  if (configModelInput) configModelInput.value = saved;

  // Seed from cached provider models so the datalist works offline first.
  try {
    const cfg = JSON.parse(originalConfig || serverConfig || "{}");
    const cached = cfg.providers?.[providerId]?.models;
    if (Array.isArray(cached) && cached.length && !openrouterCatalog) {
      openrouterCatalog = cached.map((m) => ({ id: m.id, name: m.id, ...m }));
      renderOpenrouterDatalist();
    }
  } catch {}

  fetchOpenrouterCatalog();
};

const validateJson = () => {
  const val = configEditor.value;
  try {
    JSON.parse(val);
    configValid.hidden = false;
    configInvalid.hidden = true;
    configEditor.classList.remove("config-error");
    return true;
  } catch {
    configValid.hidden = true;
    configInvalid.hidden = false;
    configEditor.classList.add("config-error");
    return false;
  }
};

const switchConfigMode = (mode) => {
  configMode = mode;

  configModeTabs.querySelectorAll(".config-mode-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });

  if (mode === "simple") {
    configBodySimple.removeAttribute("hidden");
    configBodyAdvanced.setAttribute("hidden", "");
    // Sync editor content so Advanced edits survive a Simple→Save round-trip.
    try {
      const edited = JSON.parse(configEditor.value);
      if (edited && typeof edited === "object" && !Array.isArray(edited)) {
        originalConfig = JSON.stringify(edited, null, 2);
      }
    } catch {}
    try {
      const parsed = JSON.parse(configEditor.value || "{}");
      parseConfigToSimple(parsed);
    } catch {
      parseConfigToSimple({});
    }
    updateProviderDesc();
    updateModelField();
  } else {
    configBodySimple.setAttribute("hidden", "");
    configBodyAdvanced.removeAttribute("hidden");
    // Use current editor content as the base so edits made in Advanced
    // mode aren't lost when switching Simple → Advanced.
    try {
      const edited = JSON.parse(configEditor.value);
      if (edited && typeof edited === "object" && !Array.isArray(edited)) {
        originalConfig = JSON.stringify(edited, null, 2);
      }
    } catch {}
    const config = buildConfig();
    configEditor.value = config
      ? JSON.stringify(config, null, 2)
      : originalConfig || "{}";
    validateJson();
    configEditor.focus();
  }
};

let apiKeyVisible = false;
configApikeyToggle?.addEventListener("click", () => {
  apiKeyVisible = !apiKeyVisible;
  configApikey.type = apiKeyVisible ? "text" : "password";
  configApikeyToggle.classList.toggle("showing", apiKeyVisible);
});

configProvider?.addEventListener("change", () => {
  updateProviderDesc();
  updateModelField();
  // When switching providers in simple mode, populate the API key
  // input with the stored key for the newly selected provider (if any).
  try {
    const cfg = JSON.parse(originalConfig || serverConfig || "{}");
    if (cfg.providers && cfg.providers[configProvider.value]) {
      const pk = cfg.providers[configProvider.value].apiKey;
      const key = (typeof pk === "string" && pk !== "YOUR_API_KEY") ? pk : "";
      configApikey.value = key;
      originalApiKey = key;
    } else {
      configApikey.value = "";
      originalApiKey = "";
    }
  } catch {
    configApikey.value = "";
    originalApiKey = "";
  }
});

export const setConfigOpen = async (on) => {
  if (on) {
    // 互斥：关闭其他面板
    setFilesOpen(false);
    setCtxOpen(false);
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
    configOverlay.removeAttribute("hidden");
    configOverlay.classList.add("open");
    configToggle?.classList.add("active");
    let rawConfig = {};
    try {
      const r = await fetch("/api/config");
      rawConfig = await r.json();
    } catch {}
    originalConfig = JSON.stringify(rawConfig, null, 2);
    serverConfig = originalConfig;
    configEditor.value = originalConfig;

    originalApiKey = "";
    if (rawConfig.providers && rawConfig.defaultProvider && rawConfig.providers[rawConfig.defaultProvider]) {
      const pk = rawConfig.providers[rawConfig.defaultProvider].apiKey;
      if (typeof pk === "string" && pk !== "YOUR_API_KEY") {
        originalApiKey = pk;
      }
    }

    // Always open in simple mode by default. The user can switch to
    // advanced mode via the tabs if they need to edit providers not
    // listed in the simple dropdown or tweak advanced settings.
    switchConfigMode("simple");
  } else {
    configOverlay.setAttribute("hidden", "");
    configOverlay.classList.remove("open");
    configToggle?.classList.remove("active");
  }
};

configModeTabs?.addEventListener("click", (ev) => {
  const tab = ev.target.closest(".config-mode-tab");
  if (!tab) return;
  switchConfigMode(tab.dataset.mode);
});

configEditor?.addEventListener("input", validateJson);

configEditor?.addEventListener("keydown", (ev) => {
  if (ev.key === "Tab") {
    ev.preventDefault();
    const start = configEditor.selectionStart;
    const end = configEditor.selectionEnd;
    configEditor.value = configEditor.value.substring(0, start) + "  " + configEditor.value.substring(end);
    configEditor.selectionStart = configEditor.selectionEnd = start + 2;
  }
  if (ev.key === "s" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    configSave?.click();
  }
});

const doSave = async (jsonStr) => {
  try {
    const r = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: jsonStr,
    });
    if (!r.ok) throw new Error(await r.text());
    originalConfig = jsonStr;
    setConfigOpen(false);
  } catch (e) {
    alert(t("config.save.failed", { msg: e.message ?? e }));
  }
};

configSave?.addEventListener("click", async () => {
  if (!validateJson()) return;
  await doSave(configEditor.value);
});

configSaveSimple?.addEventListener("click", async () => {
  const config = buildConfig();
  if (!config) return;

  // If the API key field is empty but we had one from the server,
  // keep the original key instead of replacing it with a placeholder.
  if (!configApikey.value.trim() && originalApiKey) {
    const providerId = configProvider.value;
    config.providers[providerId].apiKey = originalApiKey;
  }

  await doSave(JSON.stringify(config, null, 2) + "\n");
});

configFormat?.addEventListener("click", () => {
  try {
    const parsed = JSON.parse(configEditor.value);
    configEditor.value = JSON.stringify(parsed, null, 2);
    validateJson();
  } catch {}
});

configReset?.addEventListener("click", () => {
  if (configMode === "advanced") {
    configEditor.value = serverConfig;
    originalConfig = serverConfig;
    validateJson();
  } else {
    // Reset both the simple form and originalConfig to server state,
    // so a subsequent simple-mode save doesn't resurrect advanced edits.
    originalConfig = serverConfig;
    configEditor.value = serverConfig;
    parseConfigToSimple(JSON.parse(serverConfig || "{}"));
  }
});

configToggle?.addEventListener("click", () => setConfigOpen(configOverlay.hasAttribute("hidden")));
configClose?.addEventListener("click", () => setConfigOpen(false));

configModelRefresh?.addEventListener("click", () => {
  fetchOpenrouterCatalog({ force: true });
});

// Refresh provider description when language changes while panel is open
document.addEventListener("langchange", () => {
  if (configOverlay && !configOverlay.hasAttribute("hidden")) {
    updateProviderDesc();
    if (configModelHint && !configModelField?.hidden) {
      configModelHint.textContent = t("model.hint");
    }
  }
});
