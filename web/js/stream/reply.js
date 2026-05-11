import { mdToHtml, highlightWithin, stripAnsi } from "../utils.js";
import { state } from "../state.js";
import { append } from "./tool-group.js";
import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";
import { activeSession } from "../session-manager.js";

const sess = () => activeSession.peek();

const flushReply = () => {
  const session = sess();
  const r = session?.reply;
  if (!r) return;
  r.pendingChunkRender = false;
  if (!r.current) return;
  r.current.innerHTML = mdToHtml(r.text);
  maybeScroll();
};

const scheduleReplyRender = () => {
  const r = sess()?.reply;
  if (!r || r.pendingChunkRender) return;
  r.pendingChunkRender = true;
  requestAnimationFrame(flushReply);
};

export const hasReply = () => (sess()?.reply.current ?? null) != null;
export const sawLiveSegment = () => sess()?.reply.liveSegment ?? false;
export const startNewSegment = () => { const r = sess()?.reply; if (r) r.liveSegment = false; };

/** Save/restore for infinite-scroll replay processing */
export const getReplyState = () => {
  const r = sess()?.reply;
  return {
    currentReply: r?.current ?? null,
    currentReplyText: r?.text ?? "",
    pendingChunkRender: r?.pendingChunkRender ?? false,
    liveSegment: r?.liveSegment ?? false,
  };
};
export const setReplyState = (s) => {
  const r = sess()?.reply;
  if (!r) return;
  r.current = s.currentReply ?? null;
  r.text = s.currentReplyText ?? "";
  r.pendingChunkRender = s.pendingChunkRender ?? false;
  r.liveSegment = s.liveSegment ?? false;
};

export const appendReplyChunk = (delta) => {
  if (!delta) return;
  const session = sess();
  if (!session) return;
  const r = session.reply;
  if (!r.current) {
    r.current = document.createElement("div");
    r.current.className = "agent-reply streaming";
    r.current.dataset.turn = String(state.currentTurn);
    append(r.current);
  }
  r.text += stripAnsi(delta);
  r.liveSegment = true;
  scheduleReplyRender();
};

export const fillFinalReply = (text) => {
  const r = sess()?.reply;
  if (!r?.current || r.text !== "") return;
  r.text = stripAnsi(text);
  r.current.innerHTML = mdToHtml(r.text);
};

export const closeReply = () => {
  const session = sess();
  const r = session?.reply;
  if (!r?.current) return;
  if (r.pendingChunkRender) flushReply();
  r.current.classList.remove("streaming");
  if (r.text === "") {
    r.current.remove();
  } else if (!state.replaying) {
    highlightWithin(r.current);
  }
  r.current = null;
  r.text = "";
};

export const cancelReply = () => {
  const r = sess()?.reply;
  if (r?.current) {
    r.current.classList.add("cancelled");
    const stamp = document.createElement("span");
    stamp.className = "cancelled-stamp";
    stamp.textContent = t("cancelled");
    r.current.appendChild(stamp);
  }
  closeReply();
};
