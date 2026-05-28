import { append } from "./tool-group.js";
import { closeReply } from "./reply.js";
import { finalizeThinking } from "./thinking.js";
import { maybeScroll } from "./scroll.js";

// User-shell intent FIFO, keyed by session id.  Each composer.js shell
// submit pushes an intent before the /pty-input POST; the matching
// shell:command-start event consumes it.  Mirrors agent-sh#208 — without
// it, bash DEBUG-trap fires (history-recall echoes, completion edges,
// agent-tool shell calls) produce phantom user-shell blocks because the
// OSC 9997 body is whatever bash put there, not always empty.
const shellIntents = new Map();
export const pushUserShellIntent = (sessionId) => {
  if (!sessionId) return;
  let q = shellIntents.get(sessionId);
  if (!q) { q = []; shellIntents.set(sessionId, q); }
  q.push({});
};
const consumeUserShellIntent = (sessionId) => {
  const q = shellIntents.get(sessionId);
  if (!q?.length) return null;
  return q.shift();
};

const highlightBash = (s) => {
  if (!s) return "";
  if (window.hljs) {
    try { return window.hljs.highlight(s, { language: "bash" }).value; } catch {}
  }
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
};

const buildBlock = ({ command, state }) => {
  const el = document.createElement("div");
  el.className = "shell-block " + (state ?? "done");
  el.innerHTML = `
    <div class="shell-block-head">
      <span class="shell-block-prompt">$</span>
      <code class="shell-block-cmd hljs language-bash"></code>
    </div>
    <pre class="shell-block-output"></pre>
  `;
  el.querySelector(".shell-block-cmd").innerHTML = highlightBash(command ?? "");
  return el;
};

export const queueShellBlock = (session, payload) => {
  if (!session?.streamEl) return null;
  closeReply(session);
  finalizeThinking(session);
  const el = buildBlock({ command: payload?.command, state: "queued" });
  el.dataset.queuedCommand = payload?.command ?? "";
  append(session, el);
  return el;
};

export const startShellBlock = (session, payload) => {
  if (!session?.streamEl) return null;
  // Only materialize a block when a matching user-shell intent is pending.
  // Bash DEBUG-trap noise (history recall, completion echoes, agent-tool
  // shell calls) and the initial PROMPT_COMMAND emit OSC 9997 with bodies
  // that look like real commands — relying on the body alone produced
  // phantoms.  Mirrors agent-sh#208.
  if (!consumeUserShellIntent(session.id)) return null;
  closeReply(session);
  finalizeThinking(session);
  const pending = session.streamEl.querySelector(".shell-block.queued");
  if (pending) {
    pending.classList.remove("queued");
    pending.classList.add("running");
    delete pending.dataset.queuedCommand;
    const cmdEl = pending.querySelector(".shell-block-cmd");
    if (cmdEl) cmdEl.innerHTML = highlightBash(payload?.command ?? "");
    session.shellBlock = session.shellBlock ?? { current: null };
    session.shellBlock.current = pending;
    return pending;
  }
  const el = buildBlock({ command: payload?.command, state: "running" });
  append(session, el);
  session.shellBlock = session.shellBlock ?? { current: null };
  session.shellBlock.current = el;
  return el;
};

export const finishShellBlock = (session, payload) => {
  if (!session?.streamEl) return;
  const el = session.shellBlock?.current ?? null;
  // If the matching start was suppressed (no intent), drop the done event
  // entirely instead of materializing an orphan done block.
  if (!el) return;
  el.classList.remove("running");
  el.classList.add("done");
  const outEl = el.querySelector(".shell-block-output");
  if (outEl) outEl.textContent = payload?.output ?? "";
  const exitCode = payload?.exitCode;
  if (exitCode !== null && exitCode !== undefined) {
    const head = el.querySelector(".shell-block-head");
    if (head && !head.querySelector(".shell-block-exit")) {
      const exit = document.createElement("span");
      exit.className = "shell-block-exit " + (exitCode === 0 ? "ok" : "fail");
      exit.textContent = `exit ${exitCode}`;
      head.appendChild(exit);
    }
  }
  if (session.shellBlock) session.shellBlock.current = null;
  maybeScroll(session);
};
