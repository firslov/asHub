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

// asHub UI prefs live in ~/.agent-sh/settings.json under `asHub.ui.*`.
// Each pref attaches to the closest stable parent of what it affects, so the
// HTML self-documents what each option controls. Defaults are baked into HTML
// (data-ui-*) and CSS (var() fallbacks), so first paint matches the common
// case and the fetch only diff-applies overrides.
//
// To add a key: append an entry below, then either gate CSS on
// [data-ui-{attr}="value"] (kind: "attr") or read var(--ui-{name}) (kind: "var").
// `target` is a CSS selector for where the attr/var lands; omit for documentElement.
const UI_PREFS = {
  "conversation.center":      { kind: "attr", attr: "data-ui-conversation-center",      target: ".terminal-wrap" },
  "conversation.message-gap": { kind: "var",  prop: "--ui-conversation-message-gap",    target: ".terminal-wrap" },
  "conversation.turn-gap":    { kind: "var",  prop: "--ui-conversation-turn-gap",       target: ".terminal-wrap" },
  "reply.border.show":        { kind: "attr", attr: "data-ui-reply-border-show",        target: ".terminal-wrap" },
  "reply.border.gradient":    { kind: "attr", attr: "data-ui-reply-border-gradient",    target: ".terminal-wrap" },
  "reply.border.color":       { kind: "var",  prop: "--ui-reply-border-color",          target: ".terminal-wrap" },
  "reply.hover":              { kind: "attr", attr: "data-ui-reply-hover",              target: ".terminal-wrap" },
  "input.gradient":           { kind: "attr", attr: "data-ui-input-gradient",           target: ".live-input" },
  "input.focus-ring":         { kind: "attr", attr: "data-ui-input-focus-ring",         target: "#query" },
  "input.padding-y":          { kind: "var",  prop: "--ui-input-padding-y",             target: ".live-input" },
  "usage.align":              { kind: "attr", attr: "data-ui-usage-align",              target: ".terminal-wrap" },
  "usage.sticky":             { kind: "attr", attr: "data-ui-usage-sticky",             target: ".terminal-wrap" },
  "usage.git-branch":         { kind: "attr", attr: "data-ui-usage-git-branch",         target: ".terminal-wrap" },
  "cancel.show":              { kind: "attr", attr: "data-ui-cancel-show",              target: "#cancel-turn" },
  "balance.show":             { kind: "attr", attr: "data-ui-balance-show",             target: "#balance-display" },
  "sidebar.controls":         { kind: "attr", attr: "data-ui-sidebar-controls",         target: ".app" },
  "title-bar.height":         { kind: "var",  prop: "--ui-title-bar-height" },
  "title-bar.model-uppercase":{ kind: "attr", attr: "data-ui-model-uppercase",          target: "#instance" },
  "cwd.max-width":            { kind: "var",  prop: "--ui-cwd-max-width",               target: "#session-cwd-meta" },
};

const relocateSidebarControls = () => {
  if (app?.dataset.uiSidebarControls !== "titlebar") return;
  const titleBar = document.querySelector(".title-bar");
  const sessionHead = titleBar?.querySelector(".session-head");
  const newBtn = document.getElementById("new-session");
  const toggleBtn = document.getElementById("sidebar-toggle");
  if (!titleBar || !sessionHead || !newBtn || !toggleBtn) return;
  const group = document.createElement("span");
  group.className = "title-bar-controls";
  group.append(newBtn, toggleBtn);
  titleBar.insertBefore(group, sessionHead);
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

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    applyUiPrefs(cfg?.asHub?.ui);
    relocateSidebarControls();
  })
  .catch(() => {});
