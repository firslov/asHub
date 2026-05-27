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

// Threshold (characters) above which we switch from full re-render
// to incremental DOM append.  Full re-render is fast for short text;
// incremental avoids blocking the main thread when r.text grows large
// (e.g. long code generation, background-tab catch-up).
const INCREMENTAL_THRESHOLD = 2000;

const flushReply = (session) => {
  const r = session?.reply;
  if (!r) return;
  r.pendingChunkRender = false;
  if (!r.current) return;

  const fullLen = r.text.length;
  if (fullLen < INCREMENTAL_THRESHOLD) {
    // Short — full re-render is cheap and guarantees correctness.
    r.current.innerHTML = mdToHtml(r.text);
    r._renderedLen = fullLen;
  } else {
    // Long — only render the new tail to avoid O(n²) mdToHtml cost.
    const prevLen = r._renderedLen ?? 0;
    const delta = r.text.slice(prevLen);
    if (!delta) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = mdToHtml(delta);
    while (tmp.firstChild) {
      r.current.appendChild(tmp.firstChild);
    }
    r._renderedLen = fullLen;
  }
  renderMathIn(r.current);
  highlightWithin(r.current);
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
  // Final payload wins over accumulated chunks — heals gaps from SSE reopens
  // and any incremental-render artefacts (e.g. cross-chunk markdown breaks).
  r.text = full;
  r.current.innerHTML = mdToHtml(r.text);
  r._renderedLen = full.length;
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
