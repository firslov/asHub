import { currentSessionId, state, queryHistory } from "./state.js";
import { escape } from "./utils.js";
import { appendAfterPending } from "./stream/tool-group.js";
import { pushUserShellIntent } from "./stream/shell-block.js";
import { createUserBox } from "./actions.js";
import { attachAutocomplete } from "./autocomplete.js";
import { attachPromptAutocomplete } from "./prompt-manager.js";
import { attachAtMentionAutocomplete } from "./at-mention.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";

const form = document.getElementById("form");
const input = document.getElementById("query");
const cancelBtn = document.getElementById("cancel-turn");

effect(() => {
  const hasSession = !!activeSession.value;
  if (input) input.disabled = !hasSession;
  if (form) form.style.opacity = hasSession ? "" : "0.5";
});

let shellMode = false;
const setShellMode = (on) => {
  shellMode = !!on;
  form?.classList.toggle("shell-mode", shellMode);
};

input?.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (shellMode && ev.key === "Backspace" && input.value === "" && input.selectionStart === 0) {
    ev.preventDefault();
    setShellMode(false);
  }
});

const THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh"];
input?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Tab" || !ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const session = activeSession.peek();
  if (!session?.agentInfo?.thinkingSupported) return;
  ev.preventDefault();
  const cur = session.agentInfo.thinkingLevel || "off";
  const idx = THINKING_LEVELS.indexOf(cur);
  const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
  const sid = currentSessionId();
  if (!sid) return;
  fetch(`/${sid}/thinking`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level: next }),
  }).catch(() => {});
});

const shellSupported = !/win/i.test(navigator.platform || "");

// Also catches `!` from paste/IME, where keydown for the literal char never fires.
input?.addEventListener("input", () => {
  if (shellSupported && !shellMode && input.value.startsWith("!")) {
    setShellMode(true);
    input.value = input.value.slice(1);
  }
});

const doShellSubmit = async (raw) => {
  const sid = currentSessionId();
  if (!sid) return;
  input.value = "";
  input.style.height = "";
  // Tell the stream renderer this PTY write is user-initiated so the
  // resulting shell:command-start gets a block; bash DEBUG-trap and
  // agent-tool echoes don't push an intent and stay invisible.
  pushUserShellIntent(sid);
  try {
    await fetch(`/${sid}/pty-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: raw + "\n" }),
    });
  } catch (e) {
    console.error("pty-input failed", e);
  }
};

const submitSlash = async (raw) => {
  const trimmed = raw.trim();
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const args = space === -1 ? "" : trimmed.slice(space + 1);
  await fetch(`/${currentSessionId()}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
};

const slashAc = attachAutocomplete({
  inputEl: input,
  listEl: document.getElementById("autocomplete"),
  shouldOpen: (b) => {
    const t = b.trimStart();
    return t.startsWith("/") && !t.startsWith("//");
  },
  fetcher: async (buffer) => {
    const r = await fetch(`/${currentSessionId()}/autocomplete?buffer=${encodeURIComponent(buffer)}`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.items;
  },
  accept: (it) => {
    const trailing = it.name.includes(" ") ? "" : " ";
    input.value = it.name + trailing;
    // Trigger input so autocomplete re-evaluates for sub-command completions
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
});

const promptAc = attachPromptAutocomplete(input);
const atAc = attachAtMentionAutocomplete(input);

const hasAcSelection = () => slashAc.hasSelection() || promptAc.hasSelection() || atAc.hasSelection();
const acceptAc = () => {
  if (atAc.hasSelection()) { atAc.acceptCurrent(); return true; }
  if (promptAc.hasSelection()) { promptAc.acceptCurrent(); return true; }
  if (slashAc.hasSelection()) { slashAc.acceptCurrent(); return true; }
  return false;
};

const doSubmit = async (query) => {
  if (!query) return;
  if (shellMode || (shellSupported && query.startsWith("!"))) {
    await doShellSubmit(query.startsWith("!") ? query.slice(1) : query);
    return;
  }
  if (state.isSubmitting) return;
  state.lastQuery = query;
  queryHistory.push(query);
  state.isSubmitting = true;
  input.value = "";
  input.style.height = "";
  slashAc.close();
  promptAc.close();
  atAc.close();
  let optimisticBox = null;
  let optimisticSep = null;
  if (!query.startsWith("/")) {
    optimisticSep = document.createElement("div");
    optimisticSep.className = "turn-sep";
    optimisticSep.innerHTML =
      `<span class="turn-line"></span>` +
      (state.cwd ? `<span class="turn-cwd">${escape(state.cwd)}</span>` : "") +
      `<span class="turn-time">${new Date().toLocaleTimeString()}</span>` +
      `<span class="turn-line"></span>`;
    const sv = activeSession.peek();
    appendAfterPending(sv, optimisticSep);
    optimisticBox = createUserBox(query);
    optimisticBox.classList.add("pending");
    optimisticBox.dataset.queued = query;
    appendAfterPending(sv, optimisticBox);
  }
  input.disabled = true;
  try {
    if (query.startsWith("/")) {
      await submitSlash(query);
    } else {
      await fetch(`/${currentSessionId()}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
    }
  } catch (e) {
    console.error("submit failed", e);
    optimisticBox?.remove();
    optimisticSep?.remove();
  } finally {
    state.isSubmitting = false;
    input.disabled = false;
    input.focus();
  }
};

form?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (acceptAc()) return;
  const query = input.value.trim();
  await doSubmit(query);
});

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

const killRange = (start, end) => {
  if (start === end) return;
  input.setSelectionRange(start, end);
  if (document.execCommand && document.execCommand("delete")) return;
  const v = input.value;
  input.value = v.slice(0, start) + v.slice(end);
  input.setSelectionRange(start, start);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

input?.addEventListener("keydown", (ev) => {
  // Reset history navigation when user starts modifying the recalled text
  if (queryHistory._index !== -1 && ev.key !== "ArrowUp" && ev.key !== "ArrowDown"
      && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    queryHistory.reset();
  }
  if (isMac && ev.altKey && !ev.metaKey && !ev.ctrlKey && (ev.code === "KeyB" || ev.code === "KeyF")) {
    ev.preventDefault();
    const forward = ev.code === "KeyF";
    const v = input.value;
    const dir = input.selectionDirection;
    const active = dir === "backward" ? input.selectionStart : input.selectionEnd;
    let i = ev.shiftKey ? active : (forward ? input.selectionEnd : input.selectionStart);
    if (forward) {
      while (i < v.length && /\s/.test(v[i])) i++;
      while (i < v.length && /\S/.test(v[i])) i++;
    } else {
      while (i > 0 && /\s/.test(v[i - 1])) i--;
      while (i > 0 && /\S/.test(v[i - 1])) i--;
    }
    if (!ev.shiftKey) { input.setSelectionRange(i, i); return; }
    const anchor = dir === "backward" ? input.selectionEnd : input.selectionStart;
    if (i < anchor) input.setSelectionRange(i, anchor, "backward");
    else input.setSelectionRange(anchor, i, "forward");
    return;
  }
  if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey) {
    const k = ev.key.toLowerCase();
    const isKill = k === "k" || (isMac && (k === "u" || k === "w"));
    if (isKill) {
      ev.preventDefault();
      const v = input.value;
      const s = input.selectionStart, e = input.selectionEnd;
      if (s !== e) { killRange(s, e); return; }
      if (k === "k") {
        let lineEnd = v.indexOf("\n", s);
        if (lineEnd === -1) lineEnd = v.length;
        const target = lineEnd === s && lineEnd < v.length ? lineEnd + 1 : lineEnd;
        killRange(s, target);
      } else if (k === "u") {
        const lineStart = v.lastIndexOf("\n", s - 1) + 1;
        killRange(lineStart, s);
      } else {
        let i = s;
        while (i > 0 && /\s/.test(v[i - 1])) i--;
        while (i > 0 && /\S/.test(v[i - 1])) i--;
        killRange(i, s);
      }
      return;
    }
  }
  if (ev.shiftKey) return;
  if (ev.key === "Enter") {
    // Shift+Enter = newline. Enter always submits directly,
    // bypassing autocomplete accept — Tab is for selecting items.
    ev.preventDefault();
    const query = input.value.trim();
    if (query) doSubmit(query);
  } else if (ev.key === "ArrowUp" && !input.value && queryHistory.hasItems) {
    ev.preventDefault();
    const recalled = queryHistory.recallUp(input.value);
    if (recalled !== null) {
      input.value = recalled;
      input.setSelectionRange(input.value.length, input.value.length);
    }
  } else if (ev.key === "ArrowDown" && queryHistory._index !== -1) {
    ev.preventDefault();
    const recalled = queryHistory.recallDown();
    if (recalled !== null) {
      input.value = recalled;
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

input?.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 12 * 16) + "px";
});

document.addEventListener("keydown", (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  if (meta && (ev.key === "k" || ev.key === "K")) {
    if (document.activeElement === input) return;
    ev.preventDefault();
    input?.focus();
  }
});

export const setComposerText = (text) => {
  if (!input) return;
  input.value = text ?? "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};

export const cancelTurn = () => {
  const sid = currentSessionId();
  if (!sid) return;
  if (!state.isProcessing) return;
  if (cancelBtn && !cancelBtn.hidden) {
    cancelBtn.classList.add("flash");
    setTimeout(() => cancelBtn.classList.remove("flash"), 200);
  }
  fetch(`/${sid}/cancel`, { method: "POST" }).catch(() => {});
};

cancelBtn?.addEventListener("click", cancelTurn);
