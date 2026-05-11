import { state } from "../state.js";
import { activeSession } from "../session-manager.js";

const stream = document.getElementById("stream");
const pill = document.getElementById("scroll-pill");
const emptyState = document.getElementById("stream-empty");

const SCROLL_SLOP = 40;
const sess = () => activeSession.peek();

const isAtBottom = () =>
  stream.scrollHeight - stream.scrollTop - stream.clientHeight <= SCROLL_SLOP;

const jumpToBottom = () => {
  stream.scrollTo({ top: stream.scrollHeight, behavior: "instant" });
};

const scrollToBottom = () => {
  stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
  const s = sess(); if (s) s.scroll.stickToBottom = true;
  if (pill) pill.hidden = true;
};

/** Force-scroll to bottom immediately (used after replay flush). */
export const forceScrollBottom = () => {
  jumpToBottom();
  const s = sess(); if (s) s.scroll.stickToBottom = true;
  if (pill) pill.hidden = true;
};

stream.addEventListener("scroll", () => {
  const s = sess();
  const stick = isAtBottom();
  if (s) s.scroll.stickToBottom = stick;
  if (pill && stick) pill.hidden = true;
});
pill?.addEventListener("click", scrollToBottom);

/** Save/restore for infinite-scroll replay (prevents scroll-state corruption). */
export const getScrollState = () => ({
  stickToBottom: sess()?.scroll.stickToBottom ?? true,
  pillHidden: pill?.hidden ?? true,
});
export const setScrollState = (s) => {
  const session = sess();
  if (session) session.scroll.stickToBottom = s.stickToBottom ?? true;
  if (pill) pill.hidden = s.pillHidden ?? true;
};

export const maybeScroll = () => {
  if (state.replaying) return;
  if (sess()?.scroll.stickToBottom ?? true) {
    jumpToBottom();
  } else if (pill) {
    pill.hidden = false;
  }
};

export const hideEmptyState = () => {
  if (emptyState && !emptyState.hidden) emptyState.hidden = true;
};

document.getElementById("stream-empty-prompt")?.addEventListener("click", () => {
  document.getElementById("query")?.focus();
});
