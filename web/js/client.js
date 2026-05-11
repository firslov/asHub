import "./i18n.js";
import { cancelTurn } from "./composer.js";
import { setConfigOpen } from "./config-panel.js";
import "./prefs.js";
import "./links.js";
import "./version.js";
import "./sidebar.js";
import "./context-panel.js";
import "./files-panel.js";
import "./sse.js";
import "./session-switcher.js";

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const configOverlay = document.getElementById("config-overlay");
  if (configOverlay && !configOverlay.hidden) { setConfigOpen(false); return; }
  cancelTurn();
});
