const jumpToBottom = (streamEl) => {
  // Use scrollTop property (CSSOM) instead of scrollTo() — the property
  // assignment batches with DOM mutations in the same frame, avoiding a
  // visible 1-frame flicker when content height changes during streaming.
  streamEl.scrollTop = streamEl.scrollHeight;
};

/** Force-scroll to bottom immediately (used after replay flush). */
export const forceScrollBottom = (session) => {
  if (!session?.streamEl) return;
  jumpToBottom(session.streamEl);
  session.scroll.stickToBottom = true;
  if (session.pillEl) session.pillEl.hidden = true;
};

export const maybeScroll = (session) => {
  if (!session || session.state.replaying) return;
  if (session.scroll.stickToBottom ?? true) {
    if (session.streamEl) jumpToBottom(session.streamEl);
  } else if (session.pillEl) {
    session.pillEl.hidden = false;
  }
};

export const hideEmptyState = (session) => {
  const el = session?.emptyStateEl;
  if (el && !el.hidden) el.hidden = true;
};
