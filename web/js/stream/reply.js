import { mdToHtml, highlightWithin, renderMathIn, stripAnsi } from "../utils.js";
import { append } from "./tool-group.js";
import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

const flushReply = (session) => {
  const r = session?.reply;
  if (!r) return;
  r.pendingChunkRender = false;
  if (!r.current) return;
  r.current.innerHTML = mdToHtml(r.text);
  renderMathIn(r.current);
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
  r.current.innerHTML = mdToHtml(r.text);
  renderMathIn(r.current);
};

export const closeReply = (session) => {
  const r = session?.reply;
  if (!r?.current) return;
  if (r.pendingChunkRender) flushReply(session);
  r.current.classList.remove("streaming");
  if (r.text === "") {
    r.current.remove();
  } else if (!session.state.replaying) {
    highlightWithin(r.current);
  }
  r.current = null;
  r.text = "";
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
