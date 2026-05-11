import { hideEmptyState, maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";
import { activeSession } from "../session-manager.js";

const stream = document.getElementById("stream");

const TOOL_GROUP_COLLAPSE = 2;
const groupState = new WeakMap();
const sess = () => activeSession.peek();

/**
 * Insert a node into the stream, before any trailing pending user-boxes.
 * When the user sends messages while the agent is still streaming,
 * composer.js appends optimistic ".agent-box.pending" elements at the end.
 * New content from the current turn must be inserted BEFORE the first
 * pending box — otherwise auto-scroll keeps jumping past it and the
 * queued messages scroll out of view.
 *
 * We find the *first* pending box (not the last) so that when multiple
 * messages are queued, streaming content stays before all of them and the
 * pending boxes keep their relative submission order.
 */
export const insertStreamNode = (node) => {
  const firstPending = stream.querySelector(".agent-box.pending");
  if (firstPending) {
    stream.insertBefore(node, firstPending);
  } else {
    stream.appendChild(node);
  }
};

const toolCount = (g) => g.querySelectorAll(".tool-row").length;

const rebuildGroupState = (g) => {
  const head = g.querySelector(".tool-group-head");
  const body = g.querySelector(".tool-group-body");
  if (head && body) groupState.set(g, { head, body });
};

/** Save/restore for infinite-scroll replay processing */
export const getToolGroupState = () => ({ currentToolGroup: sess()?.toolGroup.current ?? null });
export const setToolGroupState = (s) => {
  const session = sess();
  if (session) session.toolGroup.current = s.currentToolGroup ?? null;
  // Rebuild WeakMap from DOM for restored tool-group elements
  document.querySelectorAll(".tool-group").forEach(rebuildGroupState);
};

const updateToolGroupHead = (g) => {
  const { head } = groupState.get(g);
  head.textContent = `🔧 ${t("n.tools", { n: toolCount(g) })}`;
};

const openToolGroup = () => {
  const session = sess();
  if (session?.toolGroup.current) return session.toolGroup.current;
  const g = document.createElement("div");
  g.className = "tool-group";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-group-head";
  head.hidden = true;
  head.addEventListener("click", () => {
    g.dataset.userToggled = "1";
    g.classList.toggle("collapsed");
    updateToolGroupHead(g);
  });
  const body = document.createElement("div");
  body.className = "tool-group-body";
  g.append(head, body);
  groupState.set(g, { head, body });
  hideEmptyState();
  insertStreamNode(g);
  if (session) session.toolGroup.current = g;
  maybeScroll();
  return g;
};

export const appendToGroup = (node) => {
  const g = openToolGroup();
  groupState.get(g).body.appendChild(node);
  maybeScroll();
};

export const bumpToolCount = () => {
  const g = openToolGroup();
  if (toolCount(g) >= TOOL_GROUP_COLLAPSE) {
    groupState.get(g).head.hidden = false;
    updateToolGroupHead(g);
  }
};

// Collapse here, not in bumpToolCount, so rows stay visible while running.
const closeToolGroup = () => {
  const session = sess();
  const g = session?.toolGroup.current;
  if (!g) return;
  session.toolGroup.current = null;
  if (groupState.get(g).body.children.length === 0) { g.remove(); return; }
  if (toolCount(g) >= TOOL_GROUP_COLLAPSE) {
    if (!g.dataset.userToggled) g.classList.add("collapsed");
    updateToolGroupHead(g);
  }
};

export const append = (node) => {
  closeToolGroup();
  hideEmptyState();
  insertStreamNode(node);
  maybeScroll();
};

/**
 * Append a node to the very end of the stream, after any pending boxes.
 * Used for optimistic queued-message boxes, which must appear after all
 * existing pending boxes to preserve submission order.
 */
export const appendAfterPending = (node) => {
  closeToolGroup();
  hideEmptyState();
  stream.appendChild(node);
  maybeScroll();
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
