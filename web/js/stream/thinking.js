import { hideEmptyState, maybeScroll } from "./scroll.js";
import { append, insertStreamNode } from "./tool-group.js";
import { t } from "../i18n.js";
import { activeSession } from "../session-manager.js";

const sess = () => activeSession.peek();

export const hasThinkingDots = () => (sess()?.thinking.el ?? null) != null;
export const hasThinkingBlock = () => (sess()?.thinking.block ?? null) != null;

/** Save/restore for infinite-scroll replay processing */
export const getThinkingState = () => {
  const t = sess()?.thinking;
  return { thinkingEl: t?.el ?? null, thinkingBlock: t?.block ?? null };
};
export const setThinkingState = (s) => {
  const t = sess()?.thinking;
  if (!t) return;
  t.el = s.thinkingEl ?? null;
  t.block = s.thinkingBlock ?? null;
};

export const showThinking = () => {
  const session = sess();
  if (!session || session.thinking.el) return;
  const el = document.createElement("div");
  el.className = "thinking";
  el.innerHTML =
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-label">${t("thinking")}</span>`;
  hideEmptyState();
  insertStreamNode(el);
  session.thinking.el = el;
  maybeScroll();
};

export const hideThinking = () => {
  const session = sess();
  const el = session?.thinking.el;
  if (!el) return;
  el.remove();
  session.thinking.el = null;
};

/**
 * Remove any `.thinking` dots in the stream that aren't the live `thinkingEl`.
 * Orphans can be left by infinite-scroll's older-frame replay or by a server
 * stream that ended mid-turn — both routes can leave DOM nodes that no module
 * reference points to, so hideThinking() can no longer clean them.
 */
export const sweepOrphanThinking = (stream) => {
  if (!stream) return;
  const live = sess()?.thinking.el ?? null;
  for (const el of stream.querySelectorAll(".thinking")) {
    if (el !== live) el.remove();
  }
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
  const session = sess();
  if (!session) return;
  hideThinking();
  if (!session.thinking.block) {
    const block = document.createElement("div");
    block.className = "thinking-block";
    session.thinking.block = block;
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
    block.append(head, body);
    append(block);
  }
  const inner = session.thinking.block.querySelector(".thinking-block-inner");
  inner.textContent = (inner.textContent ?? "") + text;
  inner.scrollTop = inner.scrollHeight;
  maybeScroll();
};

export const finalizeThinking = () => {
  const session = sess();
  const block = session?.thinking.block;
  if (!block) return;
  const inner = block.querySelector(".thinking-block-inner");
  if (!inner || !inner.textContent?.trim()) {
    block.remove();
  } else {
    const head = block.querySelector(".thinking-block-head");
    if (head) head.textContent = `💭 ${t("thought")}`;
    setThinkingCollapsed(block, true);
  }
  session.thinking.block = null;
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
