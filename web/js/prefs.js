import { lang, setLang } from "./i18n.js";

const LS_THEME = "ash-theme";
const LS_SIDEBAR = "ash.sidebar-collapsed";
const LS_SIDEBAR_W = "ash.sidebar-width";
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

const app = document.querySelector(".app");
const themeToggle = document.getElementById("theme-toggle");
const themeIcon = document.getElementById("theme-icon");

const SUN_PATHS = `
  <circle cx="12" cy="12" r="4"/>
  <line x1="12" y1="2" x2="12" y2="4"/>
  <line x1="12" y1="20" x2="12" y2="22"/>
  <line x1="2" y1="12" x2="4" y2="12"/>
  <line x1="20" y1="12" x2="22" y2="12"/>
  <line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/>
  <line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/>
  <line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/>
  <line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>`;

const MOON_PATHS = `
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
const hljsDark = document.getElementById("hljs-dark");
const hljsLight = document.getElementById("hljs-light");
const sidebarToggle = document.getElementById("sidebar-toggle");
const langToggle = document.getElementById("lang-toggle");

const setTheme = (theme) => {
  document.documentElement.setAttribute("data-theme", theme);
  if (hljsDark) hljsDark.disabled = theme === "light";
  if (hljsLight) hljsLight.disabled = theme === "dark";
  if (themeIcon) themeIcon.innerHTML = theme === "dark" ? MOON_PATHS : SUN_PATHS;
  try { localStorage.setItem(LS_THEME, theme); } catch {}
  // Sync native window chrome with theme
  if (window.electronAPI?.onThemeChange) {
    window.electronAPI.onThemeChange(theme);
  }
};

const toggleTheme = () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  setTheme(current === "light" ? "dark" : "light");
};

try {
  const stored = localStorage.getItem(LS_THEME);
  setTheme(stored === "dark" ? "dark" : "light");
} catch { setTheme("light"); }

themeToggle?.addEventListener("click", toggleTheme);

const setSidebarCollapsed = (on) => {
  app.classList.toggle("sidebar-collapsed", on);
  try { localStorage.setItem(LS_SIDEBAR, on ? "1" : "0"); } catch {}
};

try {
  if (localStorage.getItem(LS_SIDEBAR) === "1") setSidebarCollapsed(true);
} catch {}

sidebarToggle?.addEventListener("click", () => {
  setSidebarCollapsed(!app.classList.contains("sidebar-collapsed"));
});

const sidebarResize = document.getElementById("sidebar-resize");

const setSidebarWidth = (w) => {
  const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
  app.style.setProperty("--sidebar-w", `${clamped}px`);
  return clamped;
};

try {
  const stored = parseInt(localStorage.getItem(LS_SIDEBAR_W) ?? "", 10);
  if (Number.isFinite(stored)) setSidebarWidth(stored);
} catch {}

sidebarResize?.addEventListener("mousedown", (ev) => {
  if (app.classList.contains("sidebar-collapsed")) return;
  ev.preventDefault();
  app.classList.add("sidebar-resizing");
  const onMove = (e) => {
    setSidebarWidth(e.clientX);
  };
  const onUp = () => {
    app.classList.remove("sidebar-resizing");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    const cur = getComputedStyle(app).getPropertyValue("--sidebar-w").trim();
    const px = parseInt(cur, 10);
    if (Number.isFinite(px)) {
      try { localStorage.setItem(LS_SIDEBAR_W, String(px)); } catch {}
    }
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

sidebarResize?.addEventListener("dblclick", () => {
  app.style.removeProperty("--sidebar-w");
  try { localStorage.removeItem(LS_SIDEBAR_W); } catch {}
});

langToggle?.addEventListener("click", () => {
  setLang(lang.value === "zh" ? "en" : "zh");
});

// UI prefs under `asHub.ui.*`. Defaults baked into HTML (data-ui-*) and CSS (var()),
// so the fetch only diff-applies overrides.
const UI_PREFS = {
  "conversation.center":      { kind: "attr", attr: "data-ui-conversation-center",      target: ".terminal-wrap" },
  "conversation.message-gap": { kind: "var",  prop: "--ui-conversation-message-gap",    target: ".terminal-wrap" },
  "conversation.turn-gap":    { kind: "var",  prop: "--ui-conversation-turn-gap",       target: ".terminal-wrap" },
  "reply.border.show":        { kind: "attr", attr: "data-ui-reply-border-show",        target: ".terminal-wrap" },
  "reply.border.gradient":    { kind: "attr", attr: "data-ui-reply-border-gradient",    target: ".terminal-wrap" },
  "reply.border.color":       { kind: "var",  prop: "--ui-reply-border-color",          target: ".terminal-wrap" },
  "reply.hover":              { kind: "attr", attr: "data-ui-reply-hover",              target: ".terminal-wrap" },
  "reply.code.border":        { kind: "attr", attr: "data-ui-reply-code-border",        target: ".terminal-wrap" },
  "message.gradient":         { kind: "attr", attr: "data-ui-message-gradient",         target: ".terminal-wrap" },
  "message.bg.color":         { kind: "var",  prop: "--ui-message-bg-color",            target: ".terminal-wrap" },
  "input.gradient":           { kind: "attr", attr: "data-ui-input-gradient",           target: ".live-input" },
  "input.focus-ring":         { kind: "attr", attr: "data-ui-input-focus-ring",         target: "#query" },
  "input.padding-y":          { kind: "var",  prop: "--ui-input-padding-y",             target: ".live-input" },
  "turn.time.show":           { kind: "attr", attr: "data-ui-turn-time-show",           target: ".terminal-wrap" },
  "turn.sep.show":            { kind: "attr", attr: "data-ui-turn-sep-show",            target: ".terminal-wrap" },
  "usage.align":              { kind: "attr", attr: "data-ui-usage-align",              target: ".terminal-wrap" },
  "usage.sticky":             { kind: "attr", attr: "data-ui-usage-sticky",             target: ".terminal-wrap" },
  "usage.git-branch":         { kind: "attr", attr: "data-ui-usage-git-branch",         target: ".terminal-wrap" },
  "usage.cwd.show":           { kind: "attr", attr: "data-ui-usage-cwd-show",           target: ".terminal-wrap" },
  "usage.model.show":         { kind: "attr", attr: "data-ui-usage-model-show",         target: ".terminal-wrap" },
  "usage.cache.show":         { kind: "attr", attr: "data-ui-usage-cache-show",         target: ".terminal-wrap" },
  "usage.total.show":         { kind: "attr", attr: "data-ui-usage-total-show",         target: ".terminal-wrap" },
  "cancel.show":              { kind: "attr", attr: "data-ui-cancel-show",              target: "#cancel-turn" },
  "tabs.enabled":             { kind: "attr", attr: "data-ui-tabs-enabled",             target: ".app" },
  "title-bar.height":         { kind: "var",  prop: "--ui-title-bar-height" },
  "title-bar.model.show":     { kind: "attr", attr: "data-ui-model-show",              target: "#instance" },
  "title-bar.model.uppercase":{ kind: "attr", attr: "data-ui-model-uppercase",          target: "#instance" },
  "title-bar.version.show":   { kind: "attr", attr: "data-ui-version-show",             target: "#version-label" },
  "cwd.max-width":            { kind: "var",  prop: "--ui-cwd-max-width",               target: "#session-cwd-meta" },
};

// ── Baseline defaults (applied immediately, before any config loads) ──
// These replace the old CSS-level "normal" defaults so the minimal UI is
// the only built-in mode. Server / localStorage config can override.
const DEFAULT_UI = {
  "conversation.center": false,
  "conversation.message-gap": "0.9rem",
  "conversation.turn-gap": "1.2rem",
  "reply.border.show": false,
  "reply.hover": false,
  "reply.code.border": false,
  "message.gradient": true,
  "input.gradient": false,
  "input.focus-ring": false,
  "input.padding-y": "0.35rem",
  "turn.time.show": false,
  "turn.sep.show": false,
  "usage.align": "left",
  "usage.sticky": true,
  "usage.cwd.show": true,
  "usage.cache.show": true,
  "usage.total.show": false,
  "usage.model.show": true,
  "cancel.show": false,
  "title-bar.height": "40px",
  "title-bar.model.show": false,
  "title-bar.model.uppercase": false,
  "title-bar.version.show": false,
  "tabs.enabled": true,
};

const applyUiPrefs = (ui) => {
  if (!ui || typeof ui !== "object") return;
  for (const [key, spec] of Object.entries(UI_PREFS)) {
    const v = ui[key];
    if (v === undefined) continue;
    const el = spec.target ? document.querySelector(spec.target) : document.documentElement;
    if (!el) continue;
    if (spec.kind === "attr") {
      el.setAttribute(spec.attr, String(v));
    } else if (spec.kind === "var") {
      el.style.setProperty(spec.prop, String(v));
    }
  }
};

const clearUiPrefs = () => {
  for (const spec of Object.values(UI_PREFS)) {
    const el = spec.target ? document.querySelector(spec.target) : document.documentElement;
    if (!el) continue;
    if (spec.kind === "attr") {
      el.removeAttribute(spec.attr);
    } else if (spec.kind === "var") {
      el.style.removeProperty(spec.prop);
    }
  }
};

// Apply baseline defaults immediately before any config loads.
applyUiPrefs(DEFAULT_UI);

// ── Layered config: DEFAULT_UI base → settings.json overrides → localStorage fallback ──

const LS_UI = "ash.ui";

const readUiPrefsFromStorage = () => {
  try {
    const raw = localStorage.getItem(LS_UI);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const writeUiPrefsToStorage = (ui) => {
  try {
    if (ui && typeof ui === "object" && Object.keys(ui).length > 0) {
      localStorage.setItem(LS_UI, JSON.stringify(ui));
    } else {
      localStorage.removeItem(LS_UI);
    }
  } catch {}
};

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    const serverUi = cfg?.asHub?.ui;
    // Baseline defaults → server settings override. localStorage is just
    // a cache of the last applied state for offline fallback.
    const merged = { ...DEFAULT_UI, ...serverUi };
    applyUiPrefs(merged);
    writeUiPrefsToStorage(merged);
  })
  .catch(() => {
    const localUi = readUiPrefsFromStorage();
    applyUiPrefs({ ...DEFAULT_UI, ...localUi });
  });

export { applyUiPrefs, clearUiPrefs, writeUiPrefsToStorage };
