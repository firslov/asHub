// Toast notifications — top-right slide-in, auto-dismiss, stacked.
// The container is created lazily and appended to <body>; no markup needed.

import { t } from "./i18n.js";

const DEFAULT_DURATION = { success: 3000, error: 6000, info: 4000 };
const ICONS = { success: "✓", error: "✕", info: "ℹ" };
const MAX_TOASTS = 5;
const EXIT_MS = 200;

let container = null;

const getContainer = () => {
  if (!container || !container.isConnected) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
};

const dismiss = (el) => {
  if (!el.isConnected || el.classList.contains("toast-exit")) return;
  el.classList.add("toast-exit");
  setTimeout(() => el.remove(), EXIT_MS);
};

/**
 * Show a toast notification.
 * @param {string} message
 * @param {{ type?: "success"|"error"|"info", duration?: number, detail?: string }} opts
 *   type: visual style (default "info")
 *   duration: ms before auto-dismiss (defaults: success 3s, error 6s, info 4s)
 *   detail: optional long error text, hidden behind an expandable section
 *           with a copy button
 */
export const toast = (message, { type = "info", duration, detail } = {}) => {
  if (!DEFAULT_DURATION[type]) type = "info";
  const ms = duration ?? DEFAULT_DURATION[type];

  const host = getContainer();
  // Cap the stack — drop the oldest toast when full.
  while (host.children.length >= MAX_TOASTS) host.firstElementChild?.remove();

  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = ICONS[type];

  const body = document.createElement("div");
  body.className = "toast-body";

  const msg = document.createElement("div");
  msg.className = "toast-message";
  msg.textContent = String(message ?? "");
  body.appendChild(msg);

  if (detail) {
    const toggle = document.createElement("button");
    toggle.className = "toast-detail-toggle";
    toggle.textContent = t("toast.details");

    const pre = document.createElement("pre");
    pre.className = "toast-detail";
    pre.hidden = true;

    const code = document.createElement("code");
    code.textContent = String(detail);
    pre.appendChild(code);

    const copyBtn = document.createElement("button");
    copyBtn.className = "toast-detail-copy";
    copyBtn.textContent = t("copy");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(detail));
        copyBtn.textContent = t("copied");
        setTimeout(() => { copyBtn.textContent = t("copy"); }, 1200);
      } catch (e) { console.error("clipboard", e); }
    });
    pre.appendChild(copyBtn);

    toggle.addEventListener("click", () => {
      pre.hidden = !pre.hidden;
      toggle.classList.toggle("open", !pre.hidden);
    });

    body.appendChild(toggle);
    body.appendChild(pre);
  }

  const close = document.createElement("button");
  close.className = "toast-close";
  close.textContent = "×";
  close.title = t("close");
  close.addEventListener("click", () => dismiss(el));

  el.appendChild(icon);
  el.appendChild(body);
  el.appendChild(close);
  host.appendChild(el);

  const timer = setTimeout(() => dismiss(el), ms);
  // Pause auto-dismiss while hovered so the user can read/copy details.
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => setTimeout(() => dismiss(el), 1500));

  return el;
};
