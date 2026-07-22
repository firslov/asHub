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

/**
 * Adaptive throttle: longer text benefits from longer intervals since
 * each parse costs more.  50ms for short text keeps the rendering snappy;
 * stepping up for longer text keeps the main thread responsive.
 */
const throttleFor = (textLen) => {
  if (textLen < 5000) return 50;
  if (textLen < 10000) return 100;
  return 200;
};

const _structKey = (blocks) => {
  let s = String(blocks.length);
  for (const b of blocks) {
    s += "|" + b.tagName;
    // Distinguish code-block languages so Python→JavaScript IS structural.
    if (b.className && b.className.includes("language-")) s += ":" + b.className;
  }
  return s;
};

// Content comparison that ignores post-processing artifacts (hljs spans,
// code copy buttons, rendered KaTeX) so already-processed blocks are not
// rewritten — and re-highlighted — on every flush.
const _blockContentEqual = (live, fresh) => {
  if (live.tagName === "PRE") {
    // Highlighting only wraps text in spans and the copy button sits outside
    // <code>, so the raw code text is the stable thing to compare.
    const liveCode = live.querySelector("code");
    const freshCode = fresh.querySelector("code");
    return (liveCode?.textContent ?? "") === (freshCode?.textContent ?? "");
  }
  // Normalize rendered math placeholders back to their pristine form so
  // substituted KaTeX HTML doesn't count as a content change.
  const clone = live.cloneNode(true);
  for (const m of clone.querySelectorAll(".math-tex")) {
    m.innerHTML = "";
    m.classList.remove("math-error");
    delete m.dataset.rendered;
  }
  return clone.innerHTML === fresh.innerHTML;
};

const flushReply = (session) => {
  const r = session?.reply;
  if (!r) return;
  if (!r.current) { r.pendingChunkRender = false; return; }

  const throttleMs = throttleFor(r.text.length);
  const perfNow = performance.now();
  if (r._lastParseTime && perfNow - r._lastParseTime < throttleMs) {
    if (!r._throttleFlushScheduled) {
      r._throttleFlushScheduled = true;
      // Defer until the throttle window has actually elapsed rather than
      // forcing a parse on the next frame — keeps the 100/200ms tiers real.
      const waitMs = throttleMs - (perfNow - r._lastParseTime);
      setTimeout(() => {
        r._throttleFlushScheduled = false;
        flushReply(session);
      }, waitMs);
    }
    return; // pendingChunkRender stays true → closeReply will flush
  }
  r.pendingChunkRender = false;
  // Skip if text hasn't changed since last parse (common during rapid chunks).
  if (r.text === r._lastParsedText) return;

  r._lastParseTime = perfNow;
  r._lastParsedText = r.text;

  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(r.text);

  const newBlocks = Array.from(tmp.children);
  const prevCount = r._renderedBlockCount ?? 0;
  const newStructKey = _structKey(newBlocks);

  if (newStructKey === r._lastStructKey && prevCount > 0) {
    // ── Fast path: block structure unchanged ────────────────────────
    // The same blocks exist as before — only their inner content grew.
    // Update innerHTML of each block in-place, then append any new ones.
    // This avoids DOM node removal / creation during streaming.
    const existing = r.current.children;
    let codeChanged = false;
    for (let i = 0; i < newBlocks.length; i++) {
      if (i < existing.length) {
        if (!_blockContentEqual(existing[i], newBlocks[i])) {
          existing[i].innerHTML = newBlocks[i].innerHTML;
          if (existing[i].tagName === "PRE") codeChanged = true;
        }
        // When a code block's language is finally resolved by the parser
        // (e.g. ```python), propagate the class to the live block.
        if (newBlocks[i].className && newBlocks[i].className !== existing[i].className) {
          existing[i].className = newBlocks[i].className;
        }
      } else {
        r.current.appendChild(newBlocks[i]);
      }
    }
    // Setting innerHTML on a <pre> wipes hljs spans and the copy button.
    // Re-highlight immediately (via highlightWithin, which re-injects the
    // button) so the user never sees plain text during streaming.
    if (codeChanged) highlightWithin(r.current);
  } else {
    // ── Slow path: structure changed / first render ────────────────
    r._lastStructKey = newStructKey;

    if (prevCount === 0 || newBlocks.length < prevCount) {
      // First render, or block count decreased (e.g. unclosed code fence
      // turned into a real <pre> — structural change). Full replace
      // in a single operation to avoid layout thrashing.
      r.current.replaceChildren(...newBlocks);
    } else {
      // Block-level incremental: keep earlier blocks (Markdown-immutable),
      // replace only the trailing block(s) whose content may have changed.
      const keepCount = Math.max(0, prevCount - 1);
      while (r.current.children.length > keepCount) {
        r.current.lastChild?.remove();
      }
      for (let i = keepCount; i < newBlocks.length; i++) {
        r.current.appendChild(newBlocks[i]);
      }
    }
  }

  r._renderedBlockCount = newBlocks.length;
  r._renderedLen = r.text.length;

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
    r._lastStructKey = "";
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
  r._lastStructKey = "";
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
  // Guaranteed final parse — bypass throttle to render complete text
  r._throttleFlushScheduled = false;
  r._lastParseTime = 0;
  r._lastParsedText = "";
  flushReply(session);
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
