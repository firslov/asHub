import { mdToHtml, highlightWithin, renderMathIn, stripAnsi } from "../utils.js";
import { append } from "./tool-group.js";
import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

const COPY_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-3A1.5 1.5 0 0 0 2 2.5v3A1.5 1.5 0 0 0 3.5 7H4"/></svg>';
const CHECK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 2"/></svg>';

export const addReplyCopyBtn = (el, text) => {
  if (el.querySelector(".reply-copy-btn")) return;
  const btn = document.createElement("button");
  btn.className = "reply-copy-btn";
  btn.title = t("copy");
  btn.innerHTML = COPY_ICON_SVG;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add("copied");
      btn.innerHTML = CHECK_ICON_SVG;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = COPY_ICON_SVG;
      }, 1200);
    } catch (e) { console.error("clipboard", e); }
  });
  el.appendChild(btn);
};

const HIGHLIGHT_DEBOUNCE_MS = 100; // re-highlight at most 10×/second during streaming

const flushReply = (session) => {
  const r = session?.reply;
  if (!r) return;
  r.pendingChunkRender = false;
  if (!r.current) return;

  // Full render is the source of truth — guarantees correct Markdown.
  // Skip if parsed recently — throttle full Markdown parse to at most
  // every 50ms during streaming to reduce main-thread pressure.
  const now = performance.now();
  if (r._lastParseTime && now - r._lastParseTime < 50) {
    // Still schedule one more flush after throttle window
    if (!r._throttleFlushScheduled) {
      r._throttleFlushScheduled = true;
      requestAnimationFrame(() => {
        r._throttleFlushScheduled = false;
        r._lastParseTime = 0; // force re-parse
        flushReply(session);
      });
    }
    return;
  }
  r._lastParseTime = now;
  // Skip if text hasn't changed since last parse (common during rapid chunks).
  if (r.text === r._lastParsedText) return;
  r._lastParsedText = r.text;

  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(r.text);

  const newBlocks = Array.from(tmp.children);
  const prevCount = r._renderedBlockCount ?? 0;
  const fullLen = r.text.length;

  if (prevCount === 0 || newBlocks.length < prevCount) {
    // First render, or block count decreased (e.g. unclosed code fence
    // turned into a real <pre> — structural change). Full replace.
    r.current.replaceChildren();
    while (tmp.firstChild) r.current.appendChild(tmp.firstChild);
  } else {
    // Remove the last previously-rendered block and anything beyond it
    // (the last block's type/content may have changed). Keep earlier
    // blocks as-is — they are Markdown-immutable.
    const keepCount = Math.max(0, prevCount - 1);
    while (r.current.children.length > keepCount) {
      r.current.lastChild?.remove();
    }
    // Append fresh blocks from keepCount to end.
    for (let i = keepCount; i < newBlocks.length; i++) {
      r.current.appendChild(newBlocks[i]);
    }
  }

  r._renderedBlockCount = newBlocks.length;
  r._renderedLen = fullLen;

  // Debounce syntax highlighting & math rendering during live streaming.
  const now = Date.now();
  if (!r._lastHighlightAt || now - r._lastHighlightAt >= HIGHLIGHT_DEBOUNCE_MS) {
    renderMathIn(r.current);
    highlightWithin(r.current);
    r._lastHighlightAt = now;
  }

  maybeScroll(session);
};

const scheduleReplyRender = (session) => {
  const r = session?.reply;
  if (!r || r.pendingChunkRender) return;
  r.pendingChunkRender = true;
  requestAnimationFrame(() => flushReply(session));
};

export const hasReply = (session) => (session?.reply.current ?? null) != null;
export const sawLiveSegment = (session) => session?.reply.liveSegment ?? false;
export const startNewSegment = (session) => { const r = session?.reply; if (r) r.liveSegment = false; };

export const appendReplyChunk = (session, delta) => {
  if (!delta || !session) return;
  const r = session.reply;
  if (!r.current) {
    r.current = document.createElement("div");
    r.current.className = "agent-reply streaming";
    r.current.dataset.turn = String(session.state.currentTurn);
    r._renderedLen = 0;
    r._renderedBlockCount = 0;
    append(session, r.current);
  }
  r.text += stripAnsi(delta);
  r.liveSegment = true;
  scheduleReplyRender(session);
};

export const fillFinalReply = (session, text) => {
  const r = session?.reply;
  if (!r?.current || !text) return;
  const full = stripAnsi(text);
  if (full === r.text) return;
  // Final payload wins over accumulated chunks — heals gaps from SSE reopens.
  r.text = full;
  r.current.replaceChildren();
  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(r.text);
  const blockCount = tmp.children.length;
  while (tmp.firstChild) r.current.appendChild(tmp.firstChild);
  r._renderedLen = full.length;
  r._renderedBlockCount = blockCount;
  renderMathIn(r.current);
};

export const closeReply = (session) => {
  const r = session?.reply;
  if (!r?.current) return;
  if (r.pendingChunkRender) flushReply(session);
  r.current.classList.remove("streaming");
  if (r.text === "") {
    r.current.remove();
  } else {
    if (!session.state.replaying) highlightWithin(r.current);
    addReplyCopyBtn(r.current, r.text);
  }
  r.current = null;
  r.text = "";
  r._renderedLen = 0;
  r._renderedBlockCount = 0;
};

export const cancelReply = (session) => {
  const r = session?.reply;
  if (r?.current) {
    r.current.classList.add("cancelled");
    const stamp = document.createElement("span");
    stamp.className = "cancelled-stamp";
    stamp.textContent = t("cancelled");
    r.current.appendChild(stamp);
  }
  closeReply(session);
};
