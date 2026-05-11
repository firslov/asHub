/**
 * Infinite-scroll loader for session history.
 *
 * When the SSE replay is truncated (hub:replay-truncated), we remember the
 * first rendered frame id.  Scrolling near the top of the stream fetches the
 * next page of older frames, processes them through the SSE handlers (with
 * state save/restore), and inserts the resulting DOM at the top — keeping the
 * visible viewport stable.
 */

import { sessionId, state, getAgentInfoState, setAgentInfoState } from "./state.js";
import { highlightWithin } from "./utils.js";
import { compactReasoning } from "./stream/compact.js";
import { getReplyState, setReplyState } from "./stream/reply.js";
import { getThinkingState, setThinkingState, sweepOrphanThinking } from "./stream/thinking.js";
import { getToolGroupState, setToolGroupState } from "./stream/tool-group.js";
import { getLiveOutputState, setLiveOutputState } from "./stream/live-output.js";
import { getScrollState, setScrollState } from "./stream/scroll.js";
import { cancelReplayFlush } from "./sse.js";

// ── Module-level pagination state ────────────────────────────────────
// firstShown: index in the on-disk replay of the earliest rendered frame;
// 0 means the entire session is rendered.  The /replay-before/<n> endpoint
// returns the slice [startIdx, n) and the new firstShown for the next page.
let firstShown = 0;
let totalFrames = 0;
let loading = false;
let exhausted = false;
let loadGeneration = 0;

const SCROLL_THRESHOLD = 300;

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
export const setTruncationState = (firstShownIdx, total) => {
  firstShown = Number(firstShownIdx) || 0;
  totalFrames = total ?? 0;
  exhausted = firstShown <= 0;
};

/**
 * Reset pagination state — called on session switch so stale cursors
 * from the previous session don't trigger loads for the new one.
 */
export const resetPaginationState = () => {
  firstShown = 0;
  totalFrames = 0;
  exhausted = true;
  loading = false;
  loadGeneration++;
};

// ── Scroll detection ──────────────────────────────────────────────────

const stream = document.getElementById("stream");

const onScroll = () => {
  if (loading || exhausted) return;
  if (stream.scrollTop > SCROLL_THRESHOLD) return;
  loadOlderFrames();
};

stream.addEventListener("scroll", onScroll, { passive: true });

// If the rendered content doesn't overflow the viewport, no scroll event
// can ever fire and the loader stays idle — load older frames eagerly
// until the viewport overflows or pagination is exhausted.
export const maybeAutoLoadOlder = () => {
  if (loading || exhausted) return;
  if (stream.scrollHeight > stream.clientHeight + SCROLL_THRESHOLD) return;
  loadOlderFrames();
};

// ── Fetch & process older frames ─────────────────────────────────────

const loadOlderFrames = async () => {
  if (loading || exhausted || !sessionId) return;
  loading = true;
  const gen = loadGeneration;

  // Declared outside try so catch block can access it to restore the
  // replaying flag on error (let inside try is block-scoped to try).
  let wasReplaying = false;

  try {
    const url = `/${sessionId}/replay-before/${firstShown}?turns=3`;
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

    // Save scroll state BEFORE removing children — removing children triggers
    // scroll events that corrupt stickToBottom and pill.hidden, and the
    // browser clamps scrollTop to 0 on an empty container.
    const savedScroll = getScrollState();
    const savedScrollTop = stream.scrollTop;

    // Suppress maybeScroll / sidebar-status changes during handler processing
    // by reusing the replaying flag.  MUST be restored in catch/finally so a
    // thrown error doesn't leave streaming permanently broken.
		wasReplaying = state.replaying;
    state.replaying = true;

    for (const c of existingChildren) c.remove();
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
    // Also save the current title text — older session:title frames would revert it
    // to the initial 6-digit id.
    const sessionList = document.getElementById("sessions");
    let savedSessionStatus = "";
    let savedSessionTitle = "";
    // Also save the page-level session topic — session:title handler calls
    // setSessionTopic() which updates #session-topic, but we only restore the
    // sidebar list item below.
    const sessionTopic = document.getElementById("session-topic");
    const savedSessionTopicText = sessionTopic ? sessionTopic.textContent : "";
    if (sessionList) {
      const cur = sessionList.querySelector("li.current");
      if (cur) {
        savedSessionStatus = Array.from(cur.classList)
          .filter(c => c === "session-streaming" || c === "session-unread")
          .join(" ");
        const titleSpan = cur.querySelector(".session-title");
        if (titleSpan) savedSessionTitle = titleSpan.textContent;
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

    // Cancel any replay-flush timer that handlers scheduled — the 12ms
    // delayed exitReplayMode() would force-scroll to bottom otherwise.
    // Always cancel: even when wasReplaying=true, the live replay timer
    // was already cleared and replaced by our handlers' scheduleReplayFlush
    // calls. Live SSE frames or hub:replay-done will restart/re-trigger
    // exit normally after this load completes.
    cancelReplayFlush();

    // Collect generated DOM
    const olderChildren = Array.from(stream.children);

    // Clear stream and restore original children
    for (const c of olderChildren) c.remove();
    for (const c of existingChildren) stream.appendChild(c);

    // Capture scrollHeight before inserting older content (used for
    // compensation after compactReasoning ran on the inserted content).
    const oldScrollHeight = stream.scrollHeight;

    // Restore state
    state.currentTurn = saved.currentTurn;
    state.cwd = saved.cwd;
    state.contextWindow = saved.contextWindow;
    state.lastUsage = saved.lastUsage;
    state.isProcessing = saved.isProcessing;

    // Restore stream-module state (except tool-group — defer until after
    // older children are inserted so the WeakMap includes their elements).
    setReplyState(savedReply);
    setThinkingState(savedThinking);
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

    // Restore sidebar title — processing older frames replays the initial
    // session:title frame which would revert to the 6-digit id.
    if (sessionList && savedSessionTitle) {
      const cur = sessionList.querySelector("li.current");
      if (cur) {
        const titleSpan = cur.querySelector(".session-title");
        if (titleSpan) titleSpan.textContent = savedSessionTitle;
      }
    }

    // Restore page-level session topic — the session:title handler also calls
    // setSessionTopic() which updates #session-topic (not just the sidebar).
    if (sessionTopic) sessionTopic.textContent = savedSessionTopicText;

    // Insert older children at the top, maintaining scroll position.
    // Run compactReasoning first so height compensation accounts for
    // any collapsed reasoning phases.
    const frag = document.createDocumentFragment();
    for (const c of olderChildren) frag.appendChild(c);
    stream.insertBefore(frag, stream.firstChild);

    // Restore tool-group state now that older DOM is in place (WeakMap
    // rebuild scans all .tool-group including newly-inserted elements).
    setToolGroupState(savedToolGroup);

    // Compact reasoning phases in the newly-inserted content BEFORE
    // measuring height delta — otherwise the compensation is wrong.
    sweepOrphanThinking(stream);
    compactReasoning(stream);
    highlightWithin(stream);

    // Restore scroll module state (pill.hidden, stickToBottom baseline)
    // BEFORE the scrollTop assignment so the synchronous scroll event
    // from that assignment can recompute stickToBottom from the real
    // final position — we don't want to overwrite that with a stale value.
    setScrollState(savedScroll);

    // Restore replaying flag so the scroll event from scrollTop below
    // is handled in the normal (non-replay) code path.
    state.replaying = wasReplaying;

    // Compensate scroll offset so visible content doesn't jump.
    // Use the saved scrollTop (not the current one, which was clamped
    // to 0 when children were removed) as the baseline offset.
    const heightAdded = stream.scrollHeight - oldScrollHeight;
    stream.scrollTop = savedScrollTop + heightAdded;
    // ↑ This assignment triggers a synchronous 'scroll' event that
    //   recomputes stickToBottom based on the real final position.

    // Update pagination cursor (only if the session hasn't changed).
    if (gen !== loadGeneration) return;
    const next = Number(data.firstShown);
    if (Number.isFinite(next) && next > 0) {
      firstShown = next;
    } else {
      firstShown = 0;
      exhausted = true;
    }
  } catch (e) {
    console.error("infinite-scroll fetch failed", e);
    if (gen === loadGeneration) exhausted = true;
    // Restore replaying flag even on error, otherwise streaming stays
    // permanently broken (maybeScroll suppressed, sidebar dead).
    state.replaying = wasReplaying;
  } finally {
    loading = false;
  }
  maybeAutoLoadOlder();
};
