import { hideEmptyState, maybeScroll } from "./scroll.js";
import { append, insertStreamNode } from "./tool-group.js";
import { t } from "../i18n.js";

export const hasThinkingDots = (session) => (session?.thinking.el ?? null) != null;
export const hasThinkingBlock = (session) => (session?.thinking.block ?? null) != null;

export const showThinking = (session) => {
  if (!session || session.thinking.el) return;
  const el = document.createElement("div");
  el.className = "thinking";
  el.innerHTML =
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-label">${t("thinking")}</span>`;
  hideEmptyState(session);
  insertStreamNode(session, el);
  session.thinking.el = el;
  maybeScroll(session);
};

export const hideThinking = (session) => {
  const el = session?.thinking.el;
  if (!el) return;
  el.remove();
  session.thinking.el = null;
};

// Remove `.thinking` dots that aren't the live thinkingEl — orphans can be
// left when a server stream ends mid-turn, escaping hideThinking() cleanup.
export const sweepOrphanThinking = (session) => {
  const stream = session?.streamEl;
  if (!stream) return;
  const live = session.thinking.el ?? null;
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

// ── Thinking batching ─────────────────────────────────────────────
// Each thinking-chunk is just a few chars. On very long conversations,
// hundreds of individual DOM insertions per second cause layout
// thrashing and block the event loop. Batch chunks per animation frame.

const _thinkingBuf = new WeakMap();  // session -> pending text

const flushThinkingBuf = (session) => {
  const text = _thinkingBuf.get(session);
  if (!text) return;
  _thinkingBuf.delete(session);
  if (session._thinkingRaf) {
    cancelAnimationFrame(session._thinkingRaf);
    session._thinkingRaf = null;
  }
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
    append(session, block);
  }
  // Append batched text, preserving the single-container style.
  const inner = session.thinking.block.querySelector(".thinking-block-inner");
  const last = inner.lastElementChild;
  if (last && last.tagName === "DIV") {
    last.textContent += text;
  } else {
    const div = document.createElement("div");
    div.textContent = text;
    inner.appendChild(div);
  }
  inner.scrollTop = inner.scrollHeight;
  maybeScroll(session);
};

export const appendThinkingChunk = (session, text) => {
  if (!text || !session) return;
  const prev = _thinkingBuf.get(session) || "";
  _thinkingBuf.set(session, prev + text);
  if (!session._thinkingRaf) {
    session._thinkingRaf = requestAnimationFrame(() => {
      session._thinkingRaf = null;
      flushThinkingBuf(session);
    });
  }
};

export const finalizeThinking = (session) => {
  // Flush any remaining batched chunks.
  flushThinkingBuf(session);
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
  document.querySelectorAll(".thinking-block-head").forEach((head) => {
    const block = head.closest(".thinking-block");
    const isCollapsed = block?.classList?.contains("collapsed") ?? false;
    head.textContent = `💭 ${t(isCollapsed ? "thought" : "thinking")}`;
  });
  document.querySelectorAll(".thinking-label").forEach((label) => {
    label.textContent = t("thinking");
  });
});
