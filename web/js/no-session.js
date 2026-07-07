import { effect } from "../vendor/signals-core.js";
import { activeSessionId } from "./session-manager.js";

const panel = document.getElementById("no-session-empty");
const cta = document.getElementById("no-session-cta");

cta?.addEventListener("click", () => {
  document.getElementById("new-session")?.click();
});

// Quick-start templates: create session and submit query in one click.
panel?.querySelectorAll(".stream-empty-prompt.template").forEach((btn) => {
  btn.addEventListener("click", () => {
    const query = btn.dataset.query;
    if (!query) return;
    document.getElementById("new-session")?.click();
    // Wait for session to appear, then submit
    const check = setInterval(() => {
      const input = document.getElementById("query");
      if (input && !input.disabled) {
        clearInterval(check);
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.form?.requestSubmit();
      }
    }, 100);
    setTimeout(() => clearInterval(check), 5000);
  });
});

effect(() => {
  if (!panel) return;
  panel.hidden = !!activeSessionId.value;
});
