import { hideEmptyState, maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

const TOOL_GROUP_COLLAPSE = 2;
const groupState = new WeakMap();

/**
 * Insert a node into the stream, before any trailing pending user-boxes.
 * When the user sends messages while the agent is still streaming,
 * composer.js appends optimistic ".agent-box.pending" elements at the end.
 * New content from the current turn must be inserted BEFORE the first
 * pending box — otherwise auto-scroll keeps jumping past it and the
 * queued messages scroll out of view.
 *
 * Each queued message is a pair: a .turn-sep followed by a .agent-box.pending.
 * We walk back from the first pending box past any preceding turn-seps so
 * that reply chunks are inserted before the entire queued-message group,
 * keeping the timestamp and user message together.
 */
export const insertStreamNode = (session, node) => {
  // During replay, batch all nodes into a DocumentFragment for
  // single-pass DOM insertion — eliminates 1000+ reflows.
  // Also skip querySelector entirely: no pending/thinking elements exist
  // during replay since they're live-streaming concepts.
  const replaying = session?.state.replaying;
  const target = (replaying && session._replayFrag)
    ? session._replayFrag
    : session?.streamEl;
  if (!target) return;

  if (replaying) {
    // Replay path: sequential frames in order — no pending boxes or
    // thinking dots to work around. Just append in chronological order.
    target.appendChild(node);
    return;
  }

  // ── Live-streaming path ──────────────────────────────────────
  if (node.classList?.contains("thinking")) {
    target.appendChild(node);
    return;
  }
  const thinking = target.querySelector(".thinking");
  if (thinking) {
    target.insertBefore(node, thinking);
    return;
  }
  const firstPending = target.querySelector(".agent-box.pending");
  if (firstPending) {
    let insertBefore = firstPending;
    let prev = firstPending.previousElementSibling;
    while (prev && prev.classList.contains("turn-sep")) {
      insertBefore = prev;
      prev = prev.previousElementSibling;
    }
    target.insertBefore(node, insertBefore);
  } else {
    target.appendChild(node);
  }
};

const toolCount = (g) => g.querySelectorAll(".tool-row").length;

const updateToolGroupHead = (g) => {
  const { head } = groupState.get(g);
  head.textContent = `🔧 ${t("n.tools", { n: toolCount(g) })}`;
};

const setToolGroupCollapsed = (g, collapsed) => {
  const { body } = groupState.get(g);
  if (collapsed === g.classList.contains("collapsed")) return;
  if (collapsed) {
    body.style.maxHeight = body.scrollHeight + "px";
    body.offsetHeight;
    g.classList.add("collapsed");
    body.style.maxHeight = "0";
  } else {
    body.style.maxHeight = "0";
    g.classList.remove("collapsed");
    body.offsetHeight;
    body.style.maxHeight = body.scrollHeight + "px";
    const onEnd = (ev) => {
      if (ev.propertyName !== "max-height") return;
      body.style.maxHeight = "";
      body.removeEventListener("transitionend", onEnd);
    };
    body.addEventListener("transitionend", onEnd);
  }
};

const openToolGroup = (session) => {
  if (session?.toolGroup.current) return session.toolGroup.current;
  const g = document.createElement("div");
  g.className = "tool-group";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-group-head";
  head.hidden = true;
  head.addEventListener("click", () => {
    g.dataset.userToggled = "1";
    setToolGroupCollapsed(g, !g.classList.contains("collapsed"));
    updateToolGroupHead(g);
  });
  const body = document.createElement("div");
  body.className = "tool-group-body";
  g.append(head, body);
  groupState.set(g, { head, body });
  hideEmptyState(session);
  insertStreamNode(session, g);
  if (session) session.toolGroup.current = g;
  maybeScroll(session);
  return g;
};

export const appendToGroup = (session, node) => {
  const g = openToolGroup(session);
  groupState.get(g).body.appendChild(node);
  maybeScroll(session);
};

export const bumpToolCount = (session) => {
  const g = openToolGroup(session);
  if (toolCount(g) >= TOOL_GROUP_COLLAPSE) {
    groupState.get(g).head.hidden = false;
    updateToolGroupHead(g);
  }
};

// Collapse here, not in bumpToolCount, so rows stay visible while running.
const closeToolGroup = (session) => {
  const g = session?.toolGroup.current;
  if (!g) return;
  session.toolGroup.current = null;
  if (groupState.get(g).body.children.length === 0) { g.remove(); return; }
  if (toolCount(g) >= TOOL_GROUP_COLLAPSE) {
    if (!g.dataset.userToggled) setToolGroupCollapsed(g, true);
    updateToolGroupHead(g);
  }
};

export const append = (session, node) => {
  closeToolGroup(session);
  hideEmptyState(session);
  insertStreamNode(session, node);
  maybeScroll(session);
};

/**
 * Append a node to the very end of the stream, after any pending boxes.
 * Used for optimistic queued-message boxes, which must appear after all
 * existing pending boxes to preserve submission order.
 */
export const appendAfterPending = (session, node) => {
  closeToolGroup(session);
  hideEmptyState(session);
  session?.streamEl?.appendChild(node);
  maybeScroll(session);
};

// Refresh translated labels on language change
document.addEventListener("langchange", () => {
  document.querySelectorAll(".tool-group-head").forEach((head) => {
    const g = head.closest(".tool-group");
    if (!g) return;
    const n = g.querySelectorAll(".tool-row").length;
    head.textContent = `🔧 ${t("n.tools", { n })}`;
  });
});
