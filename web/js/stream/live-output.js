import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

const LIVE_OUTPUT_MAX_LINES = 2000;

const flushLiveOutput = (session) => {
  const lo = session?.liveOutput.output;
  if (!lo) return;
  lo.rafPending = false;
  const el = lo.blockEl;
  if (lo.truncated && lo.lines.length > LIVE_OUTPUT_MAX_LINES) {
    lo.lines = lo.lines.slice(-LIVE_OUTPUT_MAX_LINES);
  }
  el.textContent = lo.lines.join("\n");
  el.scrollTop = el.scrollHeight;
  maybeScroll(session);
};

const scheduleLiveOutput = (session) => {
  const lo = session?.liveOutput.output;
  if (!lo || lo.rafPending) return;
  lo.rafPending = true;
  requestAnimationFrame(() => flushLiveOutput(session));
};

export const finalizeLiveOutput = (session) => {
  const lo = session?.liveOutput.output;
  if (!lo) return;
  if (lo.rafPending) flushLiveOutput(session);
  lo.blockEl.classList.add("final");
  session.liveOutput.output = null;
};

export const resetCompletedTools = (session) => {
  session?.liveOutput.completed.clear();
};

// Output-chunk events have no toolCallId; attach to the latest tool-row.
export const appendLiveOutputChunk = (session, chunk) => {
  if (!chunk || !session) return;
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
  // Cap live output buffer — prevents freeze from huge tool output
  if (!lo.truncated && lo.lines.length > LIVE_OUTPUT_MAX_LINES) {
    lo.truncated = true;
    lo.lines = [`... (output truncated to last ${LIVE_OUTPUT_MAX_LINES} lines)`].concat(
      lo.lines.slice(-LIVE_OUTPUT_MAX_LINES));
    lo.blockEl.style.opacity = "0.8";
  }
  // Keep buffer bounded after truncation
  if (lo.truncated && lo.lines.length > LIVE_OUTPUT_MAX_LINES + 1) {
    lo.lines = lo.lines.slice(-(LIVE_OUTPUT_MAX_LINES + 1));
  }
  scheduleLiveOutput(session);
};

export const absorbAsToolBody = (session, callId) => {
  if (!session) return false;
  if (callId) session.liveOutput.completed.add(callId);
  const lo = session.liveOutput.output;
  if (!lo || lo.callId !== callId) return false;
  if (lo.rafPending) flushLiveOutput(session);
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

  const copyBtn = document.createElement("button");
  copyBtn.className = "tool-body-btn copy-btn";
  copyBtn.textContent = t("copy");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(all);
      copyBtn.classList.add("copied");
      copyBtn.textContent = t("copied");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.textContent = t("copy");
      }, 1200);
    } catch (e) { console.error("clipboard", e); }
  });
  actions.appendChild(copyBtn);

  blockEl.appendChild(actions);
  session.liveOutput.output = null;
  return true;
};

/**
 * Called by sse.js when agent:tool-started fires so appendLiveOutputChunk
 * can use a cached reference instead of scanning the entire stream DOM.
 */
export const trackToolRow = (session, row) => {
  if (session && row) session.liveOutput.lastRow = row;
};
