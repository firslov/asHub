import { state } from "../state.js";
import { activeSession } from "../session-manager.js";

const sess = () => activeSession.peek();

const jumpToBottom = (streamEl) => {
  streamEl.scrollTo({ top: streamEl.scrollHeight, behavior: "instant" });
};

/** Force-scroll to bottom immediately (used after replay flush). */
export const forceScrollBottom = () => {
  const s = sess();
  if (!s?.streamEl) return;
  jumpToBottom(s.streamEl);
  s.scroll.stickToBottom = true;
  if (s.pillEl) s.pillEl.hidden = true;
};

export const maybeScroll = () => {
  if (state.replaying) return;
  const s = sess();
  if (!s) return;
  if (s.scroll.stickToBottom ?? true) {
    if (s.streamEl) jumpToBottom(s.streamEl);
  } else if (s.pillEl) {
    s.pillEl.hidden = false;
  }
};

export const hideEmptyState = () => {
  const el = sess()?.emptyStateEl;
  if (el && !el.hidden) el.hidden = true;
};
