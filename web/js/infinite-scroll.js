/**
 * Infinite-scroll loader for session history.
 *
 * When the SSE replay is truncated (hub:replay-truncated), we remember the
 * first rendered frame id.  Scrolling near the top of the stream fetches the
 * next page of older frames, processes them through the SSE handlers (with
 * state save/restore), and inserts the resulting DOM at the top — keeping the
 * visible viewport stable.
 */

import { sessionId, state } from "./state.js";
import { highlightWithin } from "./utils.js";
import { compactReasoning } from "./stream/compact.js";
import { getReplyState, setReplyState } from "./stream/reply.js";
import { getThinkingState, setThinkingState } from "./stream/thinking.js";
import { getToolGroupState, setToolGroupState } from "./stream/tool-group.js";
import { getLiveOutputState, setLiveOutputState } from "./stream/live-output.js";
import { getAgentInfoState, setAgentInfoState } from "./sse.js";

// ── Module-level pagination state ────────────────────────────────────
let firstContentId = null;   // frame id of the earliest rendered frame
let totalFrames = 0;
let loading = false;         // guard against concurrent fetches
let exhausted = false;       // true after the server returns no more frames
let loadGeneration = 0;      // bumped on reset to abort stale fetch completions

const SCROLL_THRESHOLD = 300; // px from top before fetch triggers

// ── State save/restore (avoid corrupting live state when processing older frames) ──

let _handlersRef = null;

/**
 * Called once by sse.js after its handlers object is ready so we can borrow
 * the handler functions without creating a circular dependency.
 */
export const bindHandlers = (handlers) => {
  _handlersRef = handlers;
};

/**
 * Called from sse.js when it receives hub:replay-truncated during SSE connection.
 */
export const setTruncationState = (beforeId, total) => {
  firstContentId = beforeId ?? null;
  totalFrames = total ?? 0;
  exhausted = !firstContentId;
};

/**
 * Reset pagination state — called on session switch so stale cursors
 * from the previous session don't trigger loads for the new one.
 */
export const resetPaginationState = () => {
  firstContentId = null;
  totalFrames = 0;
  exhausted = true;
  loading = false;
  loadGeneration++;
};

// ── Scroll detection ──────────────────────────────────────────────────

const stream = document.getElementById("stream");

const onScroll = () => {
  if (loading || exhausted || !firstContentId) return;
  if (stream.scrollTop > SCROLL_THRESHOLD) return;
  loadOlderFrames();
};

stream.addEventListener("scroll", onScroll, { passive: true });

// ── Fetch & process older frames ─────────────────────────────────────

const loadOlderFrames = async () => {
  if (loading || exhausted || !firstContentId || !sessionId) return;
  loading = true;
  const gen = loadGeneration;

  try {
    const url = `/${sessionId}/replay-before/${encodeURIComponent(firstContentId)}?turns=3`;
    const r = await fetch(url);
    // Abort if the session changed while we were fetching.
    if (gen !== loadGeneration) return;
    if (!r.ok) { exhausted = true; return; }
    const data = await r.json();
    if (gen !== loadGeneration) return;
    const rawFrames = data.frames ?? [];
    if (rawFrames.length === 0) { exhausted = true; return; }

    // Save current stream children so we can re-append them after processing
    // older frames into the (temporarily cleared) stream.
    const existingChildren = Array.from(stream.children);
    for (const c of existingChildren) c.remove();

    // Save critical state that handlers mutate
    const saved = {
      currentTurn: state.currentTurn,
      cwd: state.cwd,
      contextWindow: state.contextWindow,
      lastUsage: state.lastUsage,
      isProcessing: state.isProcessing,
    };

    // Save stream-module state so live events don't see stale refs
    const savedReply = getReplyState();
    const savedThinking = getThinkingState();
    const savedToolGroup = getToolGroupState();
    const savedLiveOutput = getLiveOutputState();

    // Save UI elements that handlers mutate directly
    const instanceLabel = document.getElementById("instance");
    const spinner = document.getElementById("spinner");
    const cancelBtn = document.getElementById("cancel-turn");
    const savedInstanceText = instanceLabel ? instanceLabel.textContent : "";
    const savedSpinnerHidden = spinner ? spinner.hidden : true;
    const savedCancelHidden = cancelBtn ? cancelBtn.hidden : true;
    const savedAgentInfo = getAgentInfoState();

    // Save sidebar status — agent:processing-done calls setCurrentSessionStatus("")
    // which would clear the streaming/unread indicator during older-frame processing.
    const sessionList = document.getElementById("sessions");
    let savedSessionStatus = "";
    if (sessionList) {
      const cur = sessionList.querySelector("li.current");
      if (cur) {
        savedSessionStatus = Array.from(cur.classList)
          .filter(c => c === "session-streaming" || c === "session-unread")
          .join(" ");
      }
    }

    // Reset state for processing older frames in isolation
    state.currentTurn = -1;
    state.cwd = "";
    state.contextWindow = 0;
    state.lastUsage = null;
    state.isProcessing = false;

    // Process each frame through the handlers
    for (const line of rawFrames) {
      let frame;
      try { frame = JSON.parse(line.replace(/^data:\s*/, "").trimEnd()); } catch { continue; }
      const fn = _handlersRef?.[frame?.meta?.name];
      if (fn) {
        try { fn(frame.payload); } catch (e) { console.error("infinite-scroll handler:", frame.meta?.name, e); }
      }
    }

    // Collect generated DOM
    const olderChildren = Array.from(stream.children);

    // Clear stream and restore original children
    for (const c of olderChildren) c.remove();
    for (const c of existingChildren) stream.appendChild(c);

    // Restore state
    state.currentTurn = saved.currentTurn;
    state.cwd = saved.cwd;
    state.contextWindow = saved.contextWindow;
    state.lastUsage = saved.lastUsage;
    state.isProcessing = saved.isProcessing;

    // Restore stream-module state
    setReplyState(savedReply);
    setThinkingState(savedThinking);
    setToolGroupState(savedToolGroup);
    setLiveOutputState(savedLiveOutput);

    // Restore UI elements
    if (instanceLabel) instanceLabel.textContent = savedInstanceText;
    if (spinner) spinner.hidden = savedSpinnerHidden;
    if (cancelBtn) cancelBtn.hidden = savedCancelHidden;
    setAgentInfoState(savedAgentInfo);

    // Restore sidebar status indicator
    if (sessionList && savedSessionStatus) {
      const cur = sessionList.querySelector("li.current");
      if (cur) {
        cur.classList.remove("session-streaming", "session-unread");
        for (const cls of savedSessionStatus.split(" ")) {
          if (cls) cur.classList.add(cls);
        }
      }
    }

    // Insert older children at the top, maintaining scroll position
    const oldScrollHeight = stream.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const c of olderChildren) frag.appendChild(c);
    stream.insertBefore(frag, stream.firstChild);

    // Compensate scroll offset so visible content doesn't jump
    const heightAdded = stream.scrollHeight - oldScrollHeight;
    stream.scrollTop += heightAdded;

    // Run deferred work on the newly inserted content
    compactReasoning(stream);
    highlightWithin(stream);

    // Update pagination cursor (only if the session hasn't changed).
    if (gen !== loadGeneration) return;
    if (data.firstContentId) {
      firstContentId = data.firstContentId;
    } else {
      exhausted = true;
    }
  } catch (e) {
    console.error("infinite-scroll fetch failed", e);
    if (gen === loadGeneration) exhausted = true;
  } finally {
    loading = false;
  }
};
