import { append } from "./tool-group.js";
import { closeReply } from "./reply.js";
import { finalizeThinking } from "./thinking.js";
import { ansiToHtml } from "../utils.js";
import { maybeScroll } from "./scroll.js";

const highlightBash = (s) => {
  if (!s) return "";
  if (window.hljs) {
    try { return window.hljs.highlight(s, { language: "bash" }).value; } catch {}
  }
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
};

const buildBlock = ({ command, running }) => {
  const el = document.createElement("div");
  el.className = "shell-block" + (running ? " running" : " done");
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

export const startShellBlock = (session, payload) => {
  if (!session?.streamEl) return null;
  closeReply(session);
  finalizeThinking(session);
  const el = buildBlock({ command: payload?.command, running: true });
  append(session, el);
  session.shellBlock = session.shellBlock ?? { current: null };
  session.shellBlock.current = el;
  return el;
};

export const finishShellBlock = (session, payload) => {
  if (!session?.streamEl) return;
  let el = session.shellBlock?.current ?? null;
  if (!el) {
    el = buildBlock({ command: payload?.command, running: false });
    append(session, el);
  }
  el.classList.remove("running");
  el.classList.add("done");
  const outEl = el.querySelector(".shell-block-output");
  if (outEl) outEl.innerHTML = ansiToHtml(payload?.output ?? "");
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
