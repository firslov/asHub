import "./i18n.js";

// Platform detection
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
document.documentElement.classList.add(isMac ? "os-mac" : "os-other");

// Windows custom title bar controls
if (!isMac) {
  const winBar = document.getElementById("win-title-bar");
  if (winBar) winBar.removeAttribute("hidden");
  const minBtn = winBar?.querySelector(".minimize");
  const maxBtn = winBar?.querySelector(".maximize");
  const closeBtn = winBar?.querySelector(".close");
  minBtn?.addEventListener("click", () => window.electronAPI?.windowMinimize?.());
  maxBtn?.addEventListener("click", () => window.electronAPI?.windowMaximize?.());
  closeBtn?.addEventListener("click", () => window.electronAPI?.windowClose?.());
  // Show restore icon when maximized
  window.addEventListener("resize", () => {
    if (maxBtn) maxBtn.textContent = window.outerWidth >= screen.availWidth ? "❐" : "□";
  });
}

// Respect system reduced-motion preference
if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
  document.querySelector(".app")?.setAttribute("data-animations", "reduced");
}

import { cancelTurn } from "./composer.js";
import { setConfigOpen } from "./config-panel.js";
import { switchTo, openTabs, activeSessionId, closeTab } from "./session-manager.js";
import "./prefs.js";
import { registerPanel } from "./panel-manager.js";
import "./links.js";
import "./version.js";
import "./sidebar.js";
import "./tabs.js";
import "./no-session.js";
import "./sse.js";

// Lazy-loaded panels — loaded on first click
registerPanel("skills",    { toggleBtnId: "skills-toggle",    panelId: "skills-overlay",    load: () => import("./skills-panel.js") });
registerPanel("ctx",       { toggleBtnId: "ctx-toggle",       panelId: "ctx-panel",        load: () => import("./context-panel.js") });
registerPanel("files",     { toggleBtnId: "files-toggle",     panelId: "files-panel",      load: () => import("./files-panel.js") });
registerPanel("tree",      { toggleBtnId: "tree-toggle",      panelId: "tree-panel",       load: () => import("./tree-panel.js") });
registerPanel("subagent",  { toggleBtnId: "sa-toggle",        panelId: "subagent-panel",   load: () => import("./subagent-panel.js") });
import "./session-view.js";
import "./terminal-view.js";
import "./lifecycle.js";
import "./shortcuts.js";

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    // Panel ESC is handled by panel-manager.js
    cancelTurn();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && ev.key === "`") {
    ev.preventDefault();
    document.getElementById("sidebar-toggle")?.click();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && /^[1-9]$/.test(ev.key)) {
    const idx = parseInt(ev.key, 10) - 1;
    const tabsOn = document.querySelector(".app")?.dataset.uiTabsEnabled === "true";
    const id = tabsOn
      ? openTabs.value[idx] ?? null
      : document.querySelectorAll("#sessions li[data-session-id]")[idx]?.dataset.sessionId ?? null;
    if (id) {
      ev.preventDefault();
      switchTo(id);
    }
    return;
  }
  if (ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === "Tab") {
    const tabs = openTabs.value;
    if (tabs.length < 2) return;
    ev.preventDefault();
    const i = tabs.indexOf(activeSessionId.value);
    const next = ev.shiftKey ? (i - 1 + tabs.length) % tabs.length : (i + 1) % tabs.length;
    switchTo(tabs[next]);
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey) {
    const k = ev.key.toLowerCase();
    if (k === "n") { ev.preventDefault(); document.getElementById("new-session")?.click(); return; }
    if (k === "t") { ev.preventDefault(); document.getElementById("new-terminal")?.click(); return; }
    if (k === "w") {
      const id = activeSessionId.value;
      if (id) { ev.preventDefault(); closeTab(id); }
      return;
    }
  }
});



