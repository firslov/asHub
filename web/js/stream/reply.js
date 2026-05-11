import { mdToHtml, highlightWithin, stripAnsi } from "../utils.js";
import { state } from "../state.js";
import { append } from "./tool-group.js";
import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

let currentReply = null;
let currentReplyText = "";
let pendingChunkRender = false;
let liveSegment = false;

const flushReply = () => {
  pendingChunkRender = false;
  if (!currentReply) return;
  currentReply.innerHTML = mdToHtml(currentReplyText);
  maybeScroll();
};

const scheduleReplyRender = () => {
  if (pendingChunkRender) return;
  pendingChunkRender = true;
  requestAnimationFrame(flushReply);
};

export const hasReply = () => currentReply != null;
export const sawLiveSegment = () => liveSegment;
export const startNewSegment = () => { liveSegment = false; };

/** Save/restore for infinite-scroll replay processing */
export const getReplyState = () => ({
  currentReply, currentReplyText, pendingChunkRender, liveSegment,
});
export const setReplyState = (s) => {
  currentReply = s.currentReply ?? null;
  currentReplyText = s.currentReplyText ?? "";
  pendingChunkRender = s.pendingChunkRender ?? false;
  liveSegment = s.liveSegment ?? false;
};

// RAF-coalesce: marked.parse on every chunk is O(N²) over chunk count.
export const appendReplyChunk = (delta) => {
  if (!delta) return;
  if (!currentReply) {
    currentReply = document.createElement("div");
    currentReply.className = "agent-reply streaming";
    currentReply.dataset.turn = String(state.currentTurn);
    append(currentReply);
  }
  currentReplyText += stripAnsi(delta);
  liveSegment = true;
  scheduleReplyRender();
};

// Replay-only: covers trailing text the response-segment events miss.
export const fillFinalReply = (text) => {
  if (!currentReply || currentReplyText !== "") return;
  currentReplyText = stripAnsi(text);
  currentReply.innerHTML = mdToHtml(currentReplyText);
};

export const closeReply = () => {
  if (!currentReply) return;
  if (pendingChunkRender) flushReply();
  currentReply.classList.remove("streaming");
  if (currentReplyText === "") {
    currentReply.remove();
  } else if (!state.replaying) {
    // Defer syntax highlighting during SSE replay batching — the replay
    // exit code runs highlightWithin once on the whole stream.
    highlightWithin(currentReply);
  }
  currentReply = null;
  currentReplyText = "";
};

export const resetReplyState = () => {
  currentReply = null;
  currentReplyText = "";
  pendingChunkRender = false;
  liveSegment = false;
};

export const cancelReply = () => {
  if (currentReply) {
    currentReply.classList.add("cancelled");
    const stamp = document.createElement("span");
    stamp.className = "cancelled-stamp";
    stamp.textContent = t("cancelled");
    currentReply.appendChild(stamp);
  }
  closeReply();
};
