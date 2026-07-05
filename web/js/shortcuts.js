import { registerPanel } from "./panel-manager.js";

const shortcutsOpen = () => {
  const overlay = document.getElementById("shortcuts-overlay");
  if (overlay) { overlay.removeAttribute("hidden"); overlay.classList.add("open"); }
  document.querySelector(".app")?.classList.add("shortcuts-open");
};
const shortcutsClose = () => {
  const overlay = document.getElementById("shortcuts-overlay");
  if (overlay) { overlay.setAttribute("hidden", ""); overlay.classList.remove("open"); }
  document.getElementById("shortcuts-toggle")?.classList.remove("active");
  document.querySelector(".app")?.classList.remove("shortcuts-open");
};

document.getElementById("shortcuts-close")?.addEventListener("click", shortcutsClose);

registerPanel("shortcuts", {
  toggleBtnId: "shortcuts-toggle",
  panelId: "shortcuts-overlay",
  open: shortcutsOpen,
  close: shortcutsClose,
});
