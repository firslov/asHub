import { hideEmptyState, maybeScroll } from "./scroll.js";
import { append, insertStreamNode } from "./tool-group.js";
import { t } from "../i18n.js";

let thinkingEl = null;
let thinkingBlock = null;

export const hasThinkingDots = () => thinkingEl != null;
export const hasThinkingBlock = () => thinkingBlock != null;

/** Save/restore for infinite-scroll replay processing */
export const getThinkingState = () => ({ thinkingEl, thinkingBlock });
export const setThinkingState = (s) => {
  thinkingEl = s.thinkingEl ?? null;
  thinkingBlock = s.thinkingBlock ?? null;
};

export const showThinking = () => {
  if (thinkingEl) return;
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML =
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-label">${t("thinking")}</span>`;
  hideEmptyState();
  insertStreamNode(thinkingEl);
  maybeScroll();
};

export const hideThinking = () => {
  if (!thinkingEl) return;
  thinkingEl.remove();
  thinkingEl = null;
};

// max-height needs an explicit pixel value to transition from/to 0.
const setThinkingCollapsed = (block, collapsed) => {
  const body = block.querySelector(".thinking-block-body");
  if (!body) return;
  const isCollapsed = block.classList.contains("collapsed");
  if (collapsed === isCollapsed) return;
  if (collapsed) {
    body.style.maxHeight = body.scrollHeight + "px";
    body.offsetHeight;
    block.classList.add("collapsed");
    body.style.maxHeight = "0";
  } else {
    body.style.maxHeight = "0";
    block.classList.remove("collapsed");
    body.offsetHeight;
    body.style.maxHeight = body.scrollHeight + "px";
    const onEnd = (ev) => {
      if (ev.propertyName !== "max-height") return;
      body.style.maxHeight = "";
      body.removeEventListener("transitionend", onEnd);
    };
    body.addEventListener("transitionend", onEnd);
  }
};

export const appendThinkingChunk = (text) => {
  if (!text) return;
  hideThinking();
  if (!thinkingBlock) {
    const block = document.createElement("div");
    block.className = "thinking-block";
    thinkingBlock = block;
    const head = document.createElement("div");
    head.className = "thinking-block-head";
    head.textContent = `💭 ${t("thinking")}`;
    head.addEventListener("click", () => {
      setThinkingCollapsed(block, !block.classList.contains("collapsed"));
    });
    const body = document.createElement("div");
    body.className = "thinking-block-body";
    const inner = document.createElement("div");
    inner.className = "thinking-block-inner";
    body.appendChild(inner);
    thinkingBlock.append(head, body);
    append(thinkingBlock);
  }
  const inner = thinkingBlock.querySelector(".thinking-block-inner");
  inner.textContent = (inner.textContent ?? "") + text;
  inner.scrollTop = inner.scrollHeight;
  maybeScroll();
};

export const finalizeThinking = () => {
  if (!thinkingBlock) return;
  const inner = thinkingBlock.querySelector(".thinking-block-inner");
  if (!inner || !inner.textContent?.trim()) {
    thinkingBlock.remove();
  } else {
    const head = thinkingBlock.querySelector(".thinking-block-head");
    if (head) head.textContent = `💭 ${t("thought")}`;
    setThinkingCollapsed(thinkingBlock, true);
  }
  thinkingBlock = null;
};

// Refresh translated labels on language change
document.addEventListener("langchange", () => {
  // Thinking block heads
  document.querySelectorAll(".thinking-block-head").forEach((head) => {
    const block = head.closest(".thinking-block");
    const isCollapsed = block?.classList?.contains("collapsed") ?? false;
    head.textContent = `💭 ${t(isCollapsed ? "thought" : "thinking")}`;
  });
  // Thinking dots label
  document.querySelectorAll(".thinking-label").forEach((label) => {
    label.textContent = t("thinking");
  });
});
