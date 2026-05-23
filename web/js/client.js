import "./i18n.js";
import { cancelTurn } from "./composer.js";
import { setConfigOpen } from "./config-panel.js";
import { switchTo, openTabs } from "./session-manager.js";
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
  }
});
