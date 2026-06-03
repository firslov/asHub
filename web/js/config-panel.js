import { setFilesOpen } from "./files-panel.js";
import { setCtxOpen } from "./context-panel.js";
import { setTreeOpen } from "./tree-panel.js";
import { t } from "./i18n.js";
import { invalidateModelCache, setModelCache } from "./sse.js";

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

let providerCatalog = null;
let providerCatalogPromise = null;

const PROVIDER_LABELS = {
  deepseek: "DeepSeek",
  zhipu: "Z.AI",
  openrouter: "OpenRouter",
};

const providerLabel = (id) => PROVIDER_LABELS[id] ?? id;

const providerEntry = (id) =>
  providerCatalog?.providers?.find((p) => p.name === id) ?? null;

const providerDescription = (id) => {
  const key = `provider.desc.${id}`;
  const text = t(key);
  if (text && text !== key) return text;
  const p = providerEntry(id);
  return p?.defaultModel ? `default: ${p.defaultModel}` : "";
};

const loadProviderCatalog = async ({ force = false } = {}) => {
  if (providerCatalog && !force) return providerCatalog;
  if (providerCatalogPromise && !force) return providerCatalogPromise;

  configModelRefresh?.classList.add("loading");
  providerCatalogPromise = (async () => {
    try {
      const r = await fetch("/api/models");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      providerCatalog = await r.json();
      return providerCatalog;
    } catch (err) {
      console.error("[providers] catalog fetch failed:", err);
      if (configModelHint) configModelHint.textContent = t("model.load.failed");
      return null;
    } finally {
      configModelRefresh?.classList.remove("loading");
      providerCatalogPromise = null;
    }
  })();
  return providerCatalogPromise;
};

const populateProviderSelect = () => {
  if (!configProvider || !providerCatalog) return;
  const ids = (providerCatalog.providers ?? []).map((p) => p.name);
  const current = configProvider.value;
  configProvider.innerHTML = ids
    .map((id) => `<option value="${id}">${providerLabel(id)}</option>`)
    .join("");
  if (current && ids.includes(current)) configProvider.value = current;
};

const renderModelDatalist = (providerId) => {
  if (!configModelList) return;
  const entry = providerEntry(providerId);
  const models = entry?.models ?? [];
  configModelList.innerHTML = models
    .map((m) => `<option value="${m.id}"></option>`)
    .join("");
};

const buildConfig = () => {
  const providerId = configProvider.value;
  const apiKey = configApikey.value.trim();
  if (!providerEntry(providerId)) return null;

  let existing = {};
  try { existing = JSON.parse(originalConfig || "{}"); } catch {}

  const existingProvider =
    existing.providers && typeof existing.providers === "object"
      ? existing.providers[providerId]
      : null;
  const prev = existingProvider && typeof existingProvider === "object"
    ? existingProvider
    : {};

  const providerCfg = { ...prev };
  delete providerCfg.apiKey;
  // Models are managed by provider backends dynamically — remove
  // any stale explicit model lists from previous config versions.
  delete providerCfg.models;
  delete providerCfg.defaultModel;

  if (apiKey) {
    providerCfg.apiKey = apiKey;
  } else if (typeof prev.apiKey === "string" && prev.apiKey) {
    providerCfg.apiKey = prev.apiKey;
  }

  const config = {
    providers: { [providerId]: providerCfg },
    defaultProvider: existing.defaultProvider || providerId,
  };

  for (const [key, val] of Object.entries(existing)) {
    if (key !== "providers" && key !== "defaultProvider") {
      config[key] = val;
    }
  }

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
  const known = (providerCatalog?.providers ?? []).reduce((acc, p) => {
    acc[p.name] = p;
    return acc;
  }, {});
  const knownIds = Object.keys(known);
  const fallback = knownIds[0] ?? "";

  if (!config || typeof config !== "object" || Object.keys(config).length === 0) {
    configProvider.value = fallback;
    configApikey.value = "";
    return;
  }

  const dp = config.defaultProvider;
  let detectedProvider = null;
  let detectedApiKey = "";

  if (dp && known[dp]) {
    detectedProvider = dp;
  } else if (config.providers && typeof config.providers === "object") {
    for (const key of Object.keys(config.providers)) {
      if (known[key]) { detectedProvider = key; break; }
    }
  }

  if (detectedProvider) {
    configProvider.value = detectedProvider;
    if (config.providers && config.providers[detectedProvider]) {
      const p = config.providers[detectedProvider];
      if (typeof p.apiKey === "string") {
        detectedApiKey = p.apiKey;
      }
    }
  } else {
    configProvider.value = fallback;
  }

  configApikey.value = detectedApiKey;
};

const updateProviderDesc = () => {
  if (!configProviderDesc) return;
  configProviderDesc.textContent = providerDescription(configProvider.value);
};

const updateModelField = () => {
  // Model catalog is managed automatically by each provider backend.
  // No manual model selection is needed in the settings panel.
  if (configModelField) configModelField.hidden = true;
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
  try {
    const cfg = JSON.parse(originalConfig || serverConfig || "{}");
    if (cfg.providers && cfg.providers[configProvider.value]) {
      const pk = cfg.providers[configProvider.value].apiKey;
      const key = typeof pk === "string" ? pk : "";
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
    setFilesOpen(false);
    setCtxOpen(false);
    setTreeOpen(false);
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
    configOverlay.removeAttribute("hidden");
    configOverlay.classList.add("open");
    configToggle?.classList.add("active");

    await loadProviderCatalog();
    populateProviderSelect();

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
      if (typeof pk === "string") {
        originalApiKey = pk;
      }
    }

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

let doSave = async (jsonStr) => {
  try {
    const r = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: jsonStr,
    });
    if (!r.ok) throw new Error(await r.text());
    originalConfig = jsonStr;
    invalidateModelCache();
    // OpenRouter fetches models asynchronously after re-registration.
    // Poll for up to 12 seconds, then cache whatever is available.
    let attempts = 0;
    const pollModels = async () => {
      if (attempts++ > 12) {
        // Final fetch to pick up current state
        try {
          const r = await fetch("/api/models");
          if (r.ok) setModelCache(await r.json());
        } catch { /* ignore */ }
        return;
      }
      try {
        const r = await fetch("/api/models");
        if (!r.ok) return;
        const data = await r.json();
        const hasOpenRouter = (data.providers || []).some((p) => p.name === "openrouter" && (p.models?.length || 0) > 1);
        if (hasOpenRouter) { setModelCache(data); return; }
      } catch { /* ignore */ }
      setTimeout(pollModels, 1000);
    };
    setTimeout(pollModels, 1500);
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
    originalConfig = serverConfig;
    configEditor.value = serverConfig;
    parseConfigToSimple(JSON.parse(serverConfig || "{}"));
  }
});

configToggle?.addEventListener("click", () => setConfigOpen(configOverlay.hasAttribute("hidden")));
configClose?.addEventListener("click", () => setConfigOpen(false));

configModelRefresh?.addEventListener("click", async () => {
  await loadProviderCatalog({ force: true });
  populateProviderSelect();
  updateModelField();
});

document.addEventListener("langchange", () => {
  if (configOverlay && !configOverlay.hasAttribute("hidden")) {
    updateProviderDesc();
    if (configModelHint && !configModelField?.hidden) {
      configModelHint.textContent = t("model.hint");
    }
  }
});
