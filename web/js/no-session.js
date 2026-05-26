import { effect } from "../vendor/signals-core.js";
import { activeSessionId } from "./session-manager.js";

const panel = document.getElementById("no-session-empty");
const cta = document.getElementById("no-session-cta");

cta?.addEventListener("click", () => {
  document.getElementById("new-session")?.click();
});

effect(() => {
  if (!panel) return;
  panel.hidden = !!activeSessionId.value;
});
