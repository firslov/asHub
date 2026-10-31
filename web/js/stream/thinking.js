import { refreshActivity, setRequestActivity } from "./activity.js";
import { hideEmptyState, maybeScroll } from "./scroll.js";
import { append, insertStreamNode } from "./tool-group.js";
import { t } from "../i18n.js";
import { escape } from "../utils.js";

import "../conversation-presentation.js";
const { thinkingPreview, renderThinkingContent } = globalThis.AsHubConversationPresentation;
const thinkingSources = new WeakMap();

export const hasThinkingDots = (session) => (session?.thinking.el ?? null) != null;
export const hasThinkingBlock = (session) => (session?.thinking.block ?? null) != null;

export const showThinking = (session) => {
  if (!session || session.thinking.el) return;
  const el = document.createElement("div");
  el.className = "thinking";
  el.setAttribute("role", "status");
  el.innerHTML =
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-dot"></span>` +
    `<span class="thinking-status-label">${t("activity.thinking")}</span>`;
  hideEmptyState(session);
  // Route thinking dots into the active subagent if one is running.
  const subBody = session._subagent?.querySelector(".subagent-body");
  if (subBody) {
    subBody.appendChild(el);
    subBody.hidden = false;
  } else {
    insertStreamNode(session, el);
  }
  session.thinking.el = el;
  maybeScroll(session);
};

export const hideThinking = (session) => {
  const el = session?.thinking.el;
  if (!el) return;
  el.remove();
  session.thinking.el = null;
};

// Use the existing progress line/disclosure; never add a second activity card.
export const updateRequestStatus = (session, payload) => {
  const keys = { sending: "request.sending", waiting: "request.waiting", retrying: "request.retrying", clear: null };
  if (!Object.hasOwn(keys, payload?.phase) || !session?.state?.isProcessing) return;
  const key = keys[payload.phase];
  if (setRequestActivity(session, key)) { hideThinking(session); return; }
  if (key && !session.thinking?.el) showThinking(session);
  const label = session.thinking?.el?.querySelector(".thinking-status-label");
  if (label) {
    label.dataset.labelKey = key || "activity.thinking";
    label.textContent = t(label.dataset.labelKey);
  }
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

// Keep open content naturally sized even if a parent is hidden during a toggle.
const setThinkingCollapsed = (block, collapsed) => {
  const body = block.querySelector(".thinking-block-body");
  if (!body) return;
  const isCollapsed = block.classList.contains("collapsed");
  if (collapsed === isCollapsed) return;
  block.querySelector(".thinking-block-head")?.setAttribute("aria-expanded", String(!collapsed));
  body.inert = collapsed;
  block.classList.toggle("collapsed", collapsed);
};

// ── Thinking batching ─────────────────────────────────────────────
// Each thinking-chunk is just a few chars. On very long conversations,
// hundreds of individual DOM insertions per second cause layout
// thrashing and block the event loop. Batch chunks per animation frame.

const _thinkingBuf = new WeakMap();  // session -> pending text

// A view reset discards transient chunks; finalizing would render them into
// the fresh replay. Also cancel the scheduled frame before reusing the view.
export const discardPendingThinking = (session) => {
  if (!session) return;
  _thinkingBuf.delete(session);
  if (session._thinkingRaf != null) cancelAnimationFrame(session._thinkingRaf);
  session._thinkingRaf = null;
};

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
    const head = document.createElement("button");
    head.type = "button";
    head.className = "thinking-block-head";
    head.setAttribute("aria-expanded", "true");
    head.innerHTML = `<span class="thinking-label">${t("thinking")}</span>`;
    head.addEventListener("click", () => {
      setThinkingCollapsed(block, !block.classList.contains("collapsed"));
    });
    const body = document.createElement("div");
    body.className = "thinking-block-body";
    const inner = document.createElement("div");
    inner.className = "thinking-block-inner";
    body.appendChild(inner);
    block.append(head, body);
    // Route thinking block into the active subagent's body so the
    // user sees thinking→tool→thinking in the correct nesting order.
    const sub = session._subagent;
    const subBody = sub?.querySelector(".subagent-body");
    if (subBody) {
      subBody.appendChild(block);
      subBody.hidden = false;
    } else {
      append(session, block);
    }
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
  if (session.state?.replaying) {
    // During replay, all events fire synchronously — RAF never executes.
    // Flush immediately so the thinking block is created before tool-started.
    flushThinkingBuf(session);
  } else if (!session._thinkingRaf) {
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
  block.dataset.activityDone = "1";
  const inner = block.querySelector(".thinking-block-inner");
  if (!inner || !inner.textContent?.trim()) {
    block.remove();
  } else {
    const source = inner.textContent;
    thinkingSources.set(block, source);
    renderThinkingContent(inner, source);
    const head = block.querySelector(".thinking-block-head");
    if (head) {
      // Keep a one-line preview in the collapsed head so folded thinking
      // blocks stay informative instead of reading as empty "thought".
      const preview = thinkingPreview(source);
      head.innerHTML = `<span class="thinking-label">${t("thought")}</span>` +
        (preview ? `<span class="thinking-preview">${escape(preview)}</span>` : "");
    }
    setThinkingCollapsed(block, true);
  }
  refreshActivity(block);
  session.thinking.block = null;
};

// Refresh translated labels on language change
document.addEventListener("langchange", () => {
  document.querySelectorAll(".thinking-status-label").forEach((el) => { el.textContent = t(el.dataset.labelKey || "activity.thinking"); });
  document.querySelectorAll(".thinking-block-head").forEach((head) => {
    const block = head.closest(".thinking-block");
    // Keep the preview node even while expanded; CSS hides it until folded.
    const preview = thinkingPreview(thinkingSources.get(block) ?? block?.querySelector(".thinking-block-inner")?.textContent ?? "");
    const previewHtml = preview ? `<span class="thinking-preview">${escape(preview)}</span>` : "";
    head.innerHTML = `<span class="thinking-label">${t(block?.dataset.activityDone === "1" ? "thought" : "thinking")}</span>${previewHtml}`;
  });
});
