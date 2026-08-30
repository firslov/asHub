// The shortcuts view now lives inside the merged commands panel
// (prompt-overlay) as a tab, alongside Quick Prompts.  This module only
// wires the toolbar toggle to open that panel on the shortcuts tab.
import { toggleCommands } from "./prompt-manager.js";

document.getElementById("shortcuts-toggle")?.addEventListener("click", () => {
  toggleCommands("shortcuts");
});
