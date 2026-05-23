import { effect } from "../vendor/signals-core.js";
import { activeSessionId, openTabs, openTab, closeTab } from "./session-manager.js";
import { sessionInfo, sessionsTick } from "./sidebar.js";
import { t } from "./i18n.js";
import { escape } from "./utils.js";

const strip = document.getElementById("session-tabs");
const app = document.querySelector(".app");

const labelFor = (id) => {
  const meta = sessionInfo.get(id);
  if (meta?.title && meta.title !== id) return meta.title;
  return t("untitled");
};

const render = () => {
  if (!strip) return;
  const tabs = openTabs.value;
  const active = activeSessionId.value;
  sessionsTick.value;  // signal subscription — re-render on title/cwd updates

  strip.hidden = tabs.length === 0 || app?.dataset.uiTabsEnabled !== "true";
  strip.innerHTML = "";
  for (const id of tabs) {
    const btn = document.createElement("button");
    btn.className = "session-tab";
    btn.type = "button";
    btn.role = "tab";
    btn.dataset.sessionId = id;
    if (id === active) btn.classList.add("active");
    const label = escape(labelFor(id));
    btn.innerHTML = `<span class="session-tab-label" title="${label}">${label}</span>`;

    const close = document.createElement("span");
    close.className = "session-tab-close";
    close.title = t("close");
    close.textContent = "×";
    close.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeTab(id);
    });
    btn.appendChild(close);

    btn.addEventListener("click", () => openTab(id));
    btn.addEventListener("mousedown", (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        closeTab(id);
      }
    });
    strip.appendChild(btn);
  }
};

effect(render);

// The pref attr lands after the /api/config fetch resolves, post-render.
new MutationObserver(render).observe(app, {
  attributes: true,
  attributeFilter: ["data-ui-tabs-enabled"],
});
