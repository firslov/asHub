import "./i18n.js";
import { cancelTurn } from "./composer.js";
import { setConfigOpen } from "./config-panel.js";
import { switchTo, openTabs, activeSessionId, closeTab } from "./session-manager.js";
import "./prefs.js";
import "./links.js";
import "./version.js";
import "./sidebar.js";
import "./tabs.js";
import "./no-session.js";
import "./context-panel.js";
import "./files-panel.js";
import "./tree-panel.js";
import "./sse.js";
import "./session-view.js";
import "./terminal-view.js";

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    const configOverlay = document.getElementById("config-overlay");
    if (configOverlay && !configOverlay.hidden) { setConfigOpen(false); return; }
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
