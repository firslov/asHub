import { escape, stripAnsi, mdToHtml, highlightWithin, blockToText } from "./utils.js";
import { sessionId, eventsUrl, state, setBusy } from "./state.js";
import { maybeScroll } from "./stream/scroll.js";
import { append, appendToGroup, bumpToolCount } from "./stream/tool-group.js";
import {
  renderUsage, hideUsage, renderTurnSep, renderPromptRow, renderErrorCard,
  renderDiffBlock, renderToolBody, buildToolRow,
} from "./stream/renderers.js";
import {
  showThinking, hideThinking, hasThinkingDots,
  appendThinkingChunk, finalizeThinking, hasThinkingBlock,
} from "./stream/thinking.js";
import {
  appendReplyChunk, fillFinalReply, closeReply, cancelReply, hasReply,
  sawLiveSegment, startNewSegment,
} from "./stream/reply.js";
import {
  appendLiveOutputChunk, finalizeLiveOutput, resetCompletedTools, absorbAsToolBody,
} from "./stream/live-output.js";
import { createUserBox } from "./actions.js";
import { updateSessionTitle } from "./sidebar.js";
import { refreshFilesIfOpen } from "./files-panel.js";
import { compactReasoning } from "./stream/compact.js";

const stream = document.getElementById("stream");
const conn = document.getElementById("conn");
const dot = document.querySelector(".live-dot");
const instanceLabel = document.getElementById("instance");

// Merge non-empty fields so a partial replay event doesn't blank known values.
const agentInfo = { name: "", model: "" };

const handlers = {
  "agent:info": (p) => {
    if (p?.name === "web-renderer") return;
    if (p?.name) agentInfo.name = p.name;
    if (p?.model) agentInfo.model = p.model;
    const bits = [agentInfo.name, agentInfo.model && `[${agentInfo.model}]`].filter(Boolean);
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
    stream.querySelectorAll(".queued-hint").forEach((el) => el.remove());
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
    finalizeThinking();
    finalizeLiveOutput();
    resetCompletedTools();
    startNewSegment();
    showThinking();
  },

  "agent:queued": (p) => {
    const row = document.createElement("div");
    row.className = "ui-info queued-hint";
    const q = p?.query ?? "";
    row.textContent = q
      ? `queued: "${q.length > 60 ? q.slice(0, 57) + "…" : q}"`
      : "queued — will send after current response";
    append(row);
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
    highlightWithin(block);
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
    compactReasoning(stream);
  },

  "agent:cancelled": () => {
    cancelReply();
    hideThinking();
    finalizeThinking();
    finalizeLiveOutput();
    stream.querySelectorAll(".agent-box.pending").forEach((el) => el.remove());
    stream.querySelectorAll(".queued-hint").forEach((el) => el.remove());
    setBusy(false);
    compactReasoning(stream);
  },

  "agent:error": (p) => {
    closeReply();
    hideThinking();
    finalizeThinking();
    finalizeLiveOutput();
    append(renderErrorCard(p?.message ?? "", p?.detail ?? p?.stack));
    setBusy(false);
    compactReasoning(stream);
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
    appendToGroup(buildToolRow(p));
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
    append(renderErrorCard(p?.message ?? "command failed", null));
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
      append(renderErrorCard(`shell command failed (exit ${p.exitCode})`, text));
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
};

const connect = () => {
  const es = new EventSource(eventsUrl);
  es.onopen = () => { conn.textContent = ""; dot.classList.remove("stale"); };
  es.onerror = () => { conn.textContent = "reconnecting…"; dot.classList.add("stale"); };
  es.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    const fn = handlers[frame?.meta?.name];
    if (fn) {
      try { fn(frame.payload); } catch (e) { console.error(frame.meta.name, e); }
    }
  };
};

if (sessionId) {
  connect();
} else {
  conn.textContent = "no session — click + to create";
  dot.classList.add("stale");
}
