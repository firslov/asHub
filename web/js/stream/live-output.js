import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

let lastToolRow = null;  // cached ref to the most recent tool-row, avoids DOM scan
let liveToolOutput = null;  // { callId, lines, blockEl, rafPending }
const completedTools = new Set();

const flushLiveOutput = () => {
  if (!liveToolOutput) return;
  liveToolOutput.rafPending = false;
  const el = liveToolOutput.blockEl;
  el.textContent = liveToolOutput.lines.join("\n");
  el.scrollTop = el.scrollHeight;
  maybeScroll();
};

const scheduleLiveOutput = () => {
  if (!liveToolOutput || liveToolOutput.rafPending) return;
  liveToolOutput.rafPending = true;
  requestAnimationFrame(flushLiveOutput);
};

export const finalizeLiveOutput = () => {
  if (!liveToolOutput) return;
  if (liveToolOutput.rafPending) flushLiveOutput();
  liveToolOutput.blockEl.classList.add("final");
  liveToolOutput = null;
};

export const resetCompletedTools = () => {
  completedTools.clear();
};

// Output-chunk events have no toolCallId; attach to the latest tool-row.
// Uses a cached row reference (set by sse.js on agent:tool-started) so we
// never scan the growing DOM tree.
export const appendLiveOutputChunk = (chunk) => {
  if (!chunk) return;
  const row = lastToolRow;
  const callId = row?.dataset.callId ?? "";

  if (callId && completedTools.has(callId)) return;

  if (!liveToolOutput || liveToolOutput.callId !== callId) {
    const block = document.createElement("pre");
    block.className = "tool-body tool-body-live";
    liveToolOutput = { callId, lines: [], blockEl: block, rafPending: false };
    const parent = row ? row.parentNode : null;
    if (parent && row) {
      parent.insertBefore(block, row.nextSibling);
    }
  }

  const parts = chunk.split("\n");
  if (liveToolOutput.lines.length > 0) {
    liveToolOutput.lines[liveToolOutput.lines.length - 1] += parts[0];
  } else {
    liveToolOutput.lines.push(parts[0]);
  }
  for (let i = 1; i < parts.length; i++) {
    liveToolOutput.lines.push(parts[i]);
  }
  scheduleLiveOutput();
};

export const absorbAsToolBody = (callId) => {
  if (callId) completedTools.add(callId);
  if (!liveToolOutput || liveToolOutput.callId !== callId) return false;
  if (liveToolOutput.rafPending) flushLiveOutput();
  const blockEl = liveToolOutput.blockEl;
  blockEl.classList.add("final");
  const lines = liveToolOutput.lines;
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
  liveToolOutput = null;
  return true;
};

/**
 * Called by sse.js when agent:tool-started fires so appendLiveOutputChunk
 * can use a cached reference instead of scanning the entire stream DOM.
 */
export const trackToolRow = (row) => {
  if (row) lastToolRow = row;
};

/** Save/restore for infinite-scroll replay processing */
export const getLiveOutputState = () => ({
  lastToolRow, liveToolOutput, completedTools: new Set(completedTools),
});
export const setLiveOutputState = (s) => {
  lastToolRow = s.lastToolRow ?? null;
  liveToolOutput = s.liveToolOutput ?? null;
  completedTools.clear();
  if (s.completedTools) for (const id of s.completedTools) completedTools.add(id);
};

export const resetLiveOutputState = () => {
  lastToolRow = null;
  liveToolOutput = null;
  completedTools.clear();
};
