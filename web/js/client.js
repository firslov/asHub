import "./i18n.js";
import { cancelTurn } from "./composer.js";
import { setConfigOpen } from "./config-panel.js";
import { switchTo } from "./session-manager.js";
import "./prefs.js";
import "./links.js";
import "./version.js";
import "./sidebar.js";
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
  // Cmd/Ctrl + 1..9 → switch to the Nth session in the sidebar.
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && /^[1-9]$/.test(ev.key)) {
    const items = document.querySelectorAll("#sessions li[data-session-id]");
    const target = items[parseInt(ev.key, 10) - 1];
    if (target?.dataset.sessionId) {
      ev.preventDefault();
      switchTo(target.dataset.sessionId);
    }
  }
});
