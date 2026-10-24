/** Native popover lifecycle with themed menu items and keyboard navigation. */
export function initSidebarViewPicker(onChange) {
  const trigger = document.getElementById("sidebar-view-select");
  const menu = document.getElementById("sidebar-view-menu");
  if (!trigger || !menu) return () => {};
  const options = [...menu.querySelectorAll("[data-view]")];
  const label = trigger.querySelector(".sidebar-view-label");
  const icon = trigger.querySelector(".sidebar-view-current-icon");
  let current = "sessions";
  const isOpen = () => menu.matches(":popover-open");
  const close = (restoreFocus = false) => {
    if (isOpen()) menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  };
  const position = () => {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 190), window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const height = menu.getBoundingClientRect().height;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8))}px`;
  };
  const open = (last = false) => {
    if (!isOpen()) menu.showPopover();
    position();
    trigger.setAttribute("aria-expanded", "true");
    (last ? options.at(-1) : options.find(o => o.dataset.view === current) || options[0])?.focus();
  };
  const update = view => {
    const selected = options.find(o => o.dataset.view === view);
    if (!selected) return;
    current = view;
    const text = selected.querySelector("span");
    label.textContent = text.textContent;
    label.dataset.i18n = text.dataset.i18n;
    icon.replaceChildren(selected.querySelector("svg").cloneNode(true));
    for (const option of options) option.setAttribute("aria-checked", String(option === selected));
  };
  trigger.addEventListener("click", ev => {
    ev.preventDefault(); // Handle focus ourselves; popovertarget identifies the invoker for light dismiss.
    isOpen() ? close() : open();
  });
  trigger.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault(); open(ev.key === "ArrowUp");
    } else if (ev.key === "Escape" && isOpen()) { ev.preventDefault(); close(true); }
  });
  for (const option of options) option.addEventListener("click", () => {
    update(option.dataset.view); onChange(option.dataset.view); close(true);
  });
  menu.addEventListener("keydown", ev => {
    ev.stopPropagation(); // Escape must never cancel the active conversation.
    const index = options.indexOf(document.activeElement);
    let next;
    if (ev.key === "ArrowDown") next = (index + 1) % options.length;
    else if (ev.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = options.length - 1;
    else if (ev.key === "Escape") { ev.preventDefault(); close(true); }
    else if (ev.key === "Tab") close(true);
    if (next !== undefined) { ev.preventDefault(); options[next].focus(); }
  });
  menu.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(isOpen())));
  document.addEventListener("langchange", () => update(current));
  window.addEventListener("resize", () => close());
  return update;
}
