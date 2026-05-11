import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";
import { activeSession } from "../session-manager.js";

const sess = () => activeSession.peek();

const flushLiveOutput = () => {
  const session = sess();
  const lo = session?.liveOutput.output;
  if (!lo) return;
  lo.rafPending = false;
  const el = lo.blockEl;
  el.textContent = lo.lines.join("\n");
  el.scrollTop = el.scrollHeight;
  maybeScroll();
};

const scheduleLiveOutput = () => {
  const lo = sess()?.liveOutput.output;
  if (!lo || lo.rafPending) return;
  lo.rafPending = true;
  requestAnimationFrame(flushLiveOutput);
};

export const finalizeLiveOutput = () => {
  const session = sess();
  const lo = session?.liveOutput.output;
  if (!lo) return;
  if (lo.rafPending) flushLiveOutput();
  lo.blockEl.classList.add("final");
  session.liveOutput.output = null;
};

export const resetCompletedTools = () => {
  sess()?.liveOutput.completed.clear();
};

// Output-chunk events have no toolCallId; attach to the latest tool-row.
export const appendLiveOutputChunk = (chunk) => {
  if (!chunk) return;
  const session = sess();
  if (!session) return;
  const row = session.liveOutput.lastRow;
  const callId = row?.dataset.callId ?? "";

  if (callId && session.liveOutput.completed.has(callId)) return;

  let lo = session.liveOutput.output;
  if (!lo || lo.callId !== callId) {
    const block = document.createElement("pre");
    block.className = "tool-body tool-body-live";
    lo = { callId, lines: [], blockEl: block, rafPending: false };
    session.liveOutput.output = lo;
    const parent = row ? row.parentNode : null;
    if (parent && row) {
      parent.insertBefore(block, row.nextSibling);
    }
  }

  const parts = chunk.split("\n");
  if (lo.lines.length > 0) {
    lo.lines[lo.lines.length - 1] += parts[0];
  } else {
    lo.lines.push(parts[0]);
  }
  for (let i = 1; i < parts.length; i++) {
    lo.lines.push(parts[i]);
  }
  scheduleLiveOutput();
};

export const absorbAsToolBody = (callId) => {
  const session = sess();
  if (!session) return false;
  if (callId) session.liveOutput.completed.add(callId);
  const lo = session.liveOutput.output;
  if (!lo || lo.callId !== callId) return false;
  if (lo.rafPending) flushLiveOutput();
  const blockEl = lo.blockEl;
  blockEl.classList.add("final");
  const lines = lo.lines;
  const all = lines.join("\n");
  const LIMIT = 6;

  const textEl = document.createElement("span");
  textEl.className = "tool-body-text";
  textEl.textContent = all;
  blockEl.textContent = "";
  blockEl.appendChild(textEl);

  const actions = document.createElement("div");
  actions.className = "tool-body-actions";

  if (lines.length > LIMIT) {
    textEl.textContent = lines.slice(0, LIMIT).join("\n");
    const toggle = document.createElement("button");
    toggle.className = "tool-body-btn";
    toggle.textContent = t("show.n.more", { n: lines.length - LIMIT });
    let expanded = false;
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      textEl.textContent = expanded ? all : lines.slice(0, LIMIT).join("\n");
      toggle.textContent = expanded
        ? t("show.less")
        : t("show.n.more", { n: lines.length - LIMIT });
      blockEl.classList.toggle("expanded", expanded);
    });
    actions.appendChild(toggle);
  }
  if (actions.children.length > 0) {
    blockEl.appendChild(actions);
  }
  session.liveOutput.output = null;
  return true;
};

/**
 * Called by sse.js when agent:tool-started fires so appendLiveOutputChunk
 * can use a cached reference instead of scanning the entire stream DOM.
 */
export const trackToolRow = (row) => {
  const session = sess();
  if (session && row) session.liveOutput.lastRow = row;
};

/** Save/restore for infinite-scroll replay processing */
export const getLiveOutputState = () => {
  const session = sess();
  if (!session) return { lastToolRow: null, liveToolOutput: null, completedTools: new Set() };
  return {
    lastToolRow: session.liveOutput.lastRow,
    liveToolOutput: session.liveOutput.output,
    completedTools: new Set(session.liveOutput.completed),
  };
};
export const setLiveOutputState = (s) => {
  const session = sess();
  if (!session) return;
  session.liveOutput.lastRow = s.lastToolRow ?? null;
  session.liveOutput.output = s.liveToolOutput ?? null;
  session.liveOutput.completed.clear();
  if (s.completedTools) for (const id of s.completedTools) session.liveOutput.completed.add(id);
};
