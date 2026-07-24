import { escape } from "../utils.js";
import { t } from "../i18n.js";
import { hideEmptyState, maybeScroll } from "./scroll.js";
import { insertStreamNode } from "./tool-group.js";

const VALID_STATUS = new Set(["pending", "in_progress", "done"]);

// One card per session view. The reference must still live in the current
// render root (replay fragment or streamEl) — after a resync/branch reset
// it points at detached DOM and must be treated as missing.
const liveBlock = (session) => {
  const block = session?._todoBlock;
  if (!block) return null;
  const root = (session.state.replaying && session._replayFrag) || session.streamEl;
  return root?.contains(block) ? block : null;
};

// Same max-height collapse animation as tool-group.js.
const setTodoCollapsed = (block, collapsed) => {
  const body = block.querySelector(".todo-body");
  const head = block.querySelector(".todo-head");
  if (!body || collapsed === block.classList.contains("collapsed")) return;
  if (collapsed) {
    body.style.maxHeight = body.scrollHeight + "px";
    body.offsetHeight;
    block.classList.add("collapsed");
    body.style.maxHeight = "0";
  } else {
    body.style.maxHeight = "0";
    block.classList.remove("collapsed");
    body.offsetHeight;
    body.style.maxHeight = body.scrollHeight + "px";
    const onEnd = (ev) => {
      if (ev.propertyName !== "max-height") return;
      body.style.maxHeight = "";
      body.removeEventListener("transitionend", onEnd);
    };
    body.addEventListener("transitionend", onEnd);
  }
  if (head) {
    head.setAttribute("aria-expanded", String(!collapsed));
    head.title = collapsed ? t("todo.expand") : t("todo.collapse");
  }
};

// Sticky-state watcher: a zero-height sentinel marks the card's natural
// position in the stream. Once it scrolls out of the scroller's viewport
// the card is in its sticky (stuck) state and gets the floating style.
const ensureStickyWatch = (session, block) => {
  if (block._stickyWatch) return;
  if (!block.isConnected) {
    // During replay the card lives in a detached fragment — retry on
    // upcoming frames until it gets attached (or replaced by a resync).
    if (block._stickyPending) return;
    block._stickyPending = true;
    const check = () => {
      if (block._stickyWatch || session._todoBlock !== block) return;
      if (!block.isConnected) { requestAnimationFrame(check); return; }
      block._stickyPending = false;
      ensureStickyWatch(session, block);
    };
    requestAnimationFrame(check);
    return;
  }
  const scroller = session.streamEl;
  if (!scroller) return;
  const sentinel = document.createElement("div");
  sentinel.className = "todo-sticky-sentinel";
  sentinel.setAttribute("aria-hidden", "true");
  block.before(sentinel);
  const obs = new IntersectionObserver(
    ([entry]) => {
      if (!block.isConnected) { obs.disconnect(); return; }
      block.classList.toggle("stuck", !entry.isIntersecting);
    },
    { root: scroller, threshold: 0 },
  );
  obs.observe(sentinel);
  block._stickyWatch = obs;
};

/**
 * Create the TODO card on the first agent:todo event and pin it at that
 * position in the stream. No-op when a live card already exists — later
 * events update it in place via updateTodoBlock.
 */
export const createTodoBlock = (session) => {
  const existing = liveBlock(session);
  if (existing) return existing;
  const block = document.createElement("div");
  block.className = "todo-block";
  block.innerHTML =
    `<button type="button" class="todo-head" aria-expanded="true">` +
      `<span class="todo-icon">✓</span>` +
      `<span class="todo-title">${escape(t("todo.tasks"))}</span>` +
      `<span class="todo-progress"></span>` +
    `</button>` +
    `<div class="todo-bar"><div class="todo-bar-fill"></div></div>` +
    `<div class="todo-body"><div class="todo-list"></div></div>`;
  const head = block.querySelector(".todo-head");
  head.title = t("todo.collapse");
  head.addEventListener("click", () => {
    // Mark manual toggles so nothing force-expands the card later.
    block.dataset.userToggled = "1";
    setTodoCollapsed(block, !block.classList.contains("collapsed"));
  });
  hideEmptyState(session);
  insertStreamNode(session, block);
  session._todoBlock = block;
  ensureStickyWatch(session, block);
  return block;
};

// Settle the card after the turn ends: unstick it from the top of the
// scroller and collapse the list (unless the user toggled it manually),
// so completed work doesn't keep a floating card on the page.  The next
// agent:todo event (new work) re-sticks it via updateTodoBlock.
export const settleTodoBlock = (session) => {
  const block = liveBlock(session);
  if (!block) return;
  block.classList.add("settled");
  if (!block.dataset.userToggled) setTodoCollapsed(block, true);
};

/** Re-render the task list, progress counter and bar from the latest call. */
export const updateTodoBlock = (session, todos) => {
  const block = liveBlock(session);
  if (!block) return;
  // New todo activity means work is underway again — re-stick the card.
  block.classList.remove("settled");
  ensureStickyWatch(session, block);
  const list = block.querySelector(".todo-list");
  const progress = block.querySelector(".todo-progress");
  const fill = block.querySelector(".todo-bar-fill");
  if (!list) return;

  const items = (Array.isArray(todos) ? todos : [])
    .filter((it) => it && typeof it.title === "string" && it.title.trim());
  const total = items.length;
  const done = items.filter((it) => it.status === "done").length;

  if (progress) progress.textContent = total > 0 ? `${done}/${total}` : "";
  if (fill) fill.style.width = total > 0 ? `${(done / total) * 100}%` : "0%";

  // Cleared list: keep the card as a quiet "all clear" note rather than
  // removing it — no layout jump, position stays at the first call.
  if (total === 0) {
    list.innerHTML = `<div class="todo-empty">${escape(t("todo.clear"))}</div>`;
    maybeScroll(session);
    return;
  }

  list.innerHTML = items.map((it) => {
    const status = VALID_STATUS.has(it.status) ? it.status : "pending";
    const cls = status === "done" ? "is-done" : status === "in_progress" ? "is-active" : "is-pending";
    return `<div class="todo-row ${cls}">` +
      `<span class="todo-status"></span>` +
      `<span class="todo-text">${escape(it.title)}</span>` +
    `</div>`;
  }).join("");
  maybeScroll(session);
};

// Refresh translated labels on language change
document.addEventListener("langchange", () => {
  document.querySelectorAll(".todo-block").forEach((block) => {
    const title = block.querySelector(".todo-title");
    if (title) title.textContent = t("todo.tasks");
    const head = block.querySelector(".todo-head");
    if (head) head.title = block.classList.contains("collapsed") ? t("todo.expand") : t("todo.collapse");
    const empty = block.querySelector(".todo-empty");
    if (empty) empty.textContent = t("todo.clear");
  });
});
