import { escape, stripAnsi, mdToHtml, highlightWithin, renderMathIn, blockToText } from "./utils.js";
import { sessionId, eventsUrl, state, setBusy, agentInfo } from "./state.js";
import { signal, effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";
import { maybeScroll, forceScrollBottom } from "./stream/scroll.js";
import { append, appendToGroup, bumpToolCount } from "./stream/tool-group.js";
import {
  renderUsage, hideUsage, renderTurnSep, renderPromptRow, renderErrorCard,
  renderDiffBlock, renderToolBody, buildToolRow,
} from "./stream/renderers.js";
import {
  showThinking, hideThinking, hasThinkingDots,
  appendThinkingChunk, finalizeThinking, hasThinkingBlock,
  sweepOrphanThinking,
} from "./stream/thinking.js";
import {
  appendReplyChunk, fillFinalReply, closeReply, cancelReply, hasReply,
  sawLiveSegment, startNewSegment,
} from "./stream/reply.js";
import {
  appendLiveOutputChunk, finalizeLiveOutput, resetCompletedTools,
  absorbAsToolBody, trackToolRow,
} from "./stream/live-output.js";
import { createUserBox } from "./actions.js";
import { updateSessionTitle, setCurrentSessionStatus } from "./sidebar.js";
import { refreshFilesIfOpen } from "./files-panel.js";
import { compactReasoning } from "./stream/compact.js";
import { bindHandlers, setTruncationState } from "./infinite-scroll.js";

const stream = document.getElementById("stream");
const conn = document.getElementById("conn");
const dot = document.querySelector(".live-dot");
const instanceLabel = document.getElementById("instance");
const pageLoader = document.getElementById("page-loader");
const loaderBar = document.getElementById("page-loader-bar");
const loaderBarFill = document.getElementById("page-loader-bar-fill");

// Progress bar: animate to 90% over 4s, leave 100% for actual connection
if (loaderBar) loaderBar.classList.add("visible");
if (loaderBarFill) {
  setTimeout(() => { loaderBarFill.style.width = "30%"; }, 100);
  setTimeout(() => { loaderBarFill.style.width = "65%"; }, 1200);
  setTimeout(() => { loaderBarFill.style.width = "90%"; }, 3000);
}

const hidePageLoader = () => {
  if (loaderBarFill) loaderBarFill.style.width = "100%";
  setTimeout(() => {
    if (pageLoader) pageLoader.classList.add("hidden");
  }, 200);
};

const connState = signal(/** @type {"connecting"|"connected"|"reconnecting"|"nosession"} */ ("connecting"));

effect(() => {
  switch (connState.value) {
    case "connected":     conn.textContent = ""; break;
    case "connecting":    conn.textContent = t("connecting"); break;
    case "reconnecting":  conn.textContent = t("reconnecting"); break;
    case "nosession":     conn.textContent = t("no.session"); break;
  }
});

// ── Replay batching ───────────────────────────────────────────────────
// When SSE connects it replays buffered frames synchronously.  We run
// expensive operations (scroll, compactReasoning, highlightWithin) only
// once at the end instead of for every frame during replay.

const REPLAY_FLUSH_DELAY = 12;  // ms — if no frames arrive within this window, replay is done

let replayFlushTimer = null;

const enterReplayMode = () => {
  state.replaying = true;
  // Safety fallback: if no frames arrive at all (empty session), exit
  // replay mode after 500ms so the UI doesn't stay in batching state.
  if (replayFlushTimer) clearTimeout(replayFlushTimer);
  replayFlushTimer = setTimeout(exitReplayMode, 500);
};

const scheduleReplayFlush = () => {
  if (!state.replaying) return;
  if (replayFlushTimer) clearTimeout(replayFlushTimer);
  replayFlushTimer = setTimeout(exitReplayMode, REPLAY_FLUSH_DELAY);
};

const exitReplayMode = () => {
  state.replaying = false;
  if (replayFlushTimer) { clearTimeout(replayFlushTimer); replayFlushTimer = null; }
  // Content is fully rendered — hide the page loader.
  hidePageLoader();
  // Run all deferred heavy work in one pass.
  sweepOrphanThinking(stream);
  compactReasoning(stream);
  highlightWithin(stream);  // cheap no-op if no code blocks exist
  renderMathIn(stream);     // cheap no-op if no math placeholders exist
  forceScrollBottom();
};

/** Cancel any pending replay-flush timer (used by infinite-scroll). */
export const cancelReplayFlush = () => {
  if (replayFlushTimer) { clearTimeout(replayFlushTimer); replayFlushTimer = null; }
};

// Merge non-empty fields so a partial replay event doesn't blank known values.
const handlers = {
  "agent:info": (p) => {
    if (p?.name === "web-renderer") return;
    if (p?.name) agentInfo.name = p.name;
    if (p?.model) agentInfo.model = p.model;
    if (p?.provider) agentInfo.provider = p.provider;
    const providerTag = agentInfo.provider ? `[${agentInfo.provider}]` : "";
    const modelTag = agentInfo.model ? `[${agentInfo.model}]` : "";
    const bits = [agentInfo.name, providerTag, modelTag].filter(Boolean);
    if (bits.length) instanceLabel.textContent = "agent-sh · " + bits.join(" ");
    if (typeof p?.contextWindow === "number" && p.contextWindow > 0) {
      state.contextWindow = p.contextWindow;
    }
  },

  "shell:cwd-change": (p) => {
    state.cwd = p?.cwd ?? "";
    refreshFilesIfOpen();
  },

  "agent:query": (p) => {
    closeReply();
    finalizeThinking();
    finalizeLiveOutput();
    resetCompletedTools();
    startNewSegment();
    const queryText = p?.query ?? "";
    let matched = null;
    for (const pb of stream.querySelectorAll(".agent-box.pending")) {
      if (pb._queryText === queryText) { matched = pb; break; }
    }
    if (matched) {
      state.currentTurn++;
      matched.dataset.turn = String(state.currentTurn);
      matched.classList.remove("pending");
      return;
    }
    state.currentTurn++;
    renderTurnSep();
    const box = createUserBox(queryText);
    box.dataset.turn = String(state.currentTurn);
    append(box);
  },

  "agent:processing-start": () => {
    state.lastUsage = null;
    hideUsage();
    setBusy(true);
    if (!state.replaying) setCurrentSessionStatus("session-streaming");
    hideThinking();
    sweepOrphanThinking(stream);
    finalizeThinking();
    finalizeLiveOutput();
    resetCompletedTools();
    startNewSegment();
    showThinking();
  },

  "agent:response-chunk": (p) => {
    const blocks = Array.isArray(p?.blocks) ? p.blocks : [];
    const delta = blocks.map(blockToText).join("");
    if (!delta) return;
    hideThinking();
    finalizeThinking();
    appendReplyChunk(delta);
  },

  // Replay-only: live chunks already covered the segment.
  "agent:response-segment": (p) => {
    if (hasReply() || sawLiveSegment()) return;
    if (!p?.text) return;
    hideThinking();
    finalizeThinking();
    const block = document.createElement("div");
    block.className = "agent-reply";
    block.dataset.turn = String(state.currentTurn);
    block.innerHTML = mdToHtml(stripAnsi(p.text));
    append(block);
    renderMathIn(block);
    // Defer highlighting during replay batching.
    if (!state.replaying) highlightWithin(block);
  },

  "agent:thinking-chunk": (p) => {
    appendThinkingChunk(stripAnsi(p?.text ?? ""));
  },

  "agent:response-done": (p) => {
    if (p?.response) fillFinalReply(p.response);
    closeReply();
  },

  "agent:processing-done": () => {
    closeReply();
    hideThinking();
    finalizeThinking();
    finalizeLiveOutput();
    renderUsage();
    setBusy(false);
    if (!state.replaying) setCurrentSessionStatus("");
    // Defer reasoning compaction during replay batching — the exit hook
    // runs compactReasoning once on the whole stream.
    if (!state.replaying) compactReasoning(stream);
    scheduleReplayFlush();
  },

  "agent:cancelled": () => {
    cancelReply();
    hideThinking();
    finalizeThinking();
    finalizeLiveOutput();
    stream.querySelectorAll(".agent-box.pending").forEach((el) => el.remove());
    setBusy(false);
    if (!state.replaying) setCurrentSessionStatus("");
    if (!state.replaying) compactReasoning(stream);
    scheduleReplayFlush();
  },

  "agent:error": (p) => {
    closeReply();
    hideThinking();
    finalizeThinking();
    finalizeLiveOutput();
    append(renderErrorCard(p?.message ?? "", p?.detail ?? p?.stack));
    setBusy(false);
    if (!state.replaying) setCurrentSessionStatus("");
    if (!state.replaying) compactReasoning(stream);
    scheduleReplayFlush();
  },

  "agent:usage": (p) => { state.lastUsage = p; },

  "session:title": (p) => {
    updateSessionTitle(sessionId, p?.title ?? "");
  },

  "agent:tool-started": (p) => {
    closeReply();
    hideThinking();
    finalizeThinking();
    finalizeLiveOutput();
    startNewSegment();
    const row = buildToolRow(p);
    appendToGroup(row);
    trackToolRow(row);  // cache for live-output to avoid DOM scan
    bumpToolCount();
    // Local "working…" hint for users scrolled past the bar spinner.
    if (state.isProcessing && !hasReply() && !hasThinkingBlock()) {
      showThinking();
    }
  },

  "agent:tool-completed": (p) => {
    const id = p?.toolCallId ?? "";
    const row = id ? stream.querySelector(`.tool-row[data-call-id="${CSS.escape(id)}"]`) : null;
    if (!row) return;
    const ok = p?.exitCode === 0 || p?.exitCode == null;
    row.classList.add(ok ? "ok" : "err");
    const summary = p?.resultDisplay?.summary ?? "";
    const mark = ok ? "✓" : `✗ exit ${p?.exitCode}`;
    const tail = document.createElement("span");
    tail.className = "tool-mark";
    tail.textContent = (summary ? ` ${summary} ` : "  ") + mark;
    row.appendChild(tail);

    if (!absorbAsToolBody(id)) {
      const body = p?.resultDisplay?.body;
      if (body?.kind === "lines" && Array.isArray(body.lines) && body.lines.length) {
        const block = renderToolBody(body.lines);
        row.parentNode.insertBefore(block, row.nextSibling);
      } else if (body?.kind === "diff" && body.diff) {
        // Reuse permission preview as the result diff if one was rendered.
        let preview = row.previousElementSibling;
        while (preview && !preview.classList.contains("diff-preview")) {
          preview = preview.previousElementSibling;
        }
        if (preview) {
          preview.classList.remove("diff-preview");
          row.parentNode.insertBefore(preview, row.nextSibling);
        } else {
          const block = renderDiffBlock(body.diff, body.filePath);
          row.parentNode.insertBefore(block, row.nextSibling);
        }
      }
    }
    maybeScroll();
  },

  "agent:tool-output-chunk": (p) => {
    appendLiveOutputChunk(p?.chunk ?? "");
  },

  "permission:request": (p) => {
    if (p?.kind === "file-write" && p?.metadata?.diff) {
      closeReply();
      const block = renderDiffBlock(p.metadata.diff, p.title ?? p.metadata.filePath ?? "");
      block.classList.add("diff-preview");
      appendToGroup(block);
    }
  },

  "ui:info": (p) => {
    const row = document.createElement("div");
    row.className = "ui-info";
    row.textContent = String(p?.message ?? "");
    append(row);
  },
  "ui:error": (p) => {
    append(renderErrorCard(p?.message || t("command.failed"), null));
  },

  "shell:command-start": (p) => {
    closeReply();
    state.cwd = p?.cwd ?? state.cwd;
    renderPromptRow();
    const row = document.createElement("div");
    row.className = "t-input";
    row.innerHTML = `<span class="t-prompt">&gt;</span>${escape(p?.command ?? "")}`;
    append(row);
  },

  "shell:command-done": (p) => {
    const text = stripAnsi(p?.output ?? "");
    const isErr = p?.exitCode != null && p.exitCode !== 0;
    if (isErr) {
      append(renderErrorCard(t("shell.failed", { code: p.exitCode }), text));
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const row = document.createElement("div");
      row.className = "t-out";
      row.textContent = line;
      append(row);
    }
  },

  // Hub sentinel: fired synchronously after the replay loop so the client
  // can exit batching mode deterministically, even when live events from
  // an active turn arrive immediately after replay.
  "hub:replay-done": () => {
    if (state.replaying) exitReplayMode();
  },

  // Hub sentinel: replay was truncated because the session is large.
  // The client will lazy-load older frames via infinite-scroll.
  "hub:replay-truncated": (p) => {
    setTruncationState(p?.beforeId ?? null, p?.total ?? 0);
  },
};

// Wire infinite-scroll to the handler table so it can process older frames.
bindHandlers(handlers);

const connect = (signal) => {
  const es = new EventSource(eventsUrl);
  signal?.addEventListener("abort", () => es.close(), { once: true });
  es.onopen = () => {
    connState.value = "connected";
    dot.classList.remove("stale");
    // Enter replay batching mode — the hub is about to replay buffered
    // frames.  We defer heavy work until replay finishes.
    enterReplayMode();
  };
  es.onerror = () => {
    hidePageLoader();
    connState.value = "reconnecting";
    dot.classList.add("stale");
    // If we lost connection mid-replay, flush any remaining deferred work.
    if (state.replaying) exitReplayMode();
  };
  es.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    const fn = handlers[frame?.meta?.name];
    if (fn) {
      try { fn(frame.payload); } catch (e) { console.error(frame.meta.name, e); }
    }
    // Each frame resets the debounce timer.  When no frame arrives for
    // REPLAY_FLUSH_DELAY ms, the replay batch is considered done.
    scheduleReplayFlush();
  };
};

export const bootSession = (signal) => {
  const timer = setTimeout(() => {
    if (pageLoader && !pageLoader.classList.contains("hidden")) {
      hidePageLoader();
    }
  }, 8000);
  signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });

  if (sessionId) {
    connect(signal);
  } else {
    hidePageLoader();
    connState.value = "nosession";
    dot.classList.add("stale");
  }
};
