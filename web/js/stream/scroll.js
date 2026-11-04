const jumpToBottom = (streamEl) => {
  // Use scrollTop property (CSSOM) instead of scrollTo() — the property
  // assignment batches with DOM mutations in the same frame, avoiding a
  // visible 1-frame flicker when content height changes during streaming.
  streamEl.scrollTop = streamEl.scrollHeight;
};

/** Follow the latest output now, or on reveal if the chat has no layout. */
export const forceScrollBottom = (session) => {
  if (!session?.streamEl) return;
  session.scroll.pendingBottom = !!session.hidden;
  if (!session.hidden) jumpToBottom(session.streamEl);
  session.scroll.stickToBottom = true;
  if (session.pillEl) session.pillEl.hidden = true;
};

export const maybeScroll = (session) => {
  if (!session || session.state.replaying) return;
  if (session.scroll.stickToBottom ?? true) {
    forceScrollBottom(session);
  } else if (session.pillEl) {
    session.pillEl.hidden = false;
  }
};

export const hideEmptyState = (session) => {
  const el = session?.emptyStateEl;
  if (el && !el.hidden) el.hidden = true;
};
