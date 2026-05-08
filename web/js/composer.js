import { sessionId, submitUrl, state } from "./state.js";
import { escape } from "./utils.js";
import { appendAfterPending } from "./stream/tool-group.js";
import { createUserBox } from "./actions.js";
import { attachAutocomplete } from "./autocomplete.js";
import { attachPromptAutocomplete } from "./prompt-manager.js";
import { attachAtMentionAutocomplete } from "./at-mention.js";

const form = document.getElementById("form");
const input = document.getElementById("query");
const cancelBtn = document.getElementById("cancel-turn");

if (!sessionId) {
  if (input) input.disabled = true;
  if (form) form.style.opacity = "0.5";
}

const submitSlash = async (raw) => {
  const trimmed = raw.trim();
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const args = space === -1 ? "" : trimmed.slice(space + 1);
  await fetch(`/${sessionId}/command`, {
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
    const r = await fetch(`/${sessionId}/autocomplete?buffer=${encodeURIComponent(buffer)}`);
    if (!r.ok) return [];
    const data = await r.json();
    return data.items;
  },
  accept: (it) => {
    const trailing = it.name.includes(" ") ? "" : " ";
    input.value = it.name + trailing;
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

form?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (acceptAc()) return;

  const query = input.value.trim();
  if (!query) return;
  if (state.isSubmitting) return;
  state.lastQuery = query;
  state.isSubmitting = true;
  input.value = "";
  input.style.height = "";
  slashAc.close();
  promptAc.close();
  atAc.close();
  let optimisticBox = null;
  let optimisticSep = null;
  if (!query.startsWith("/")) {
    // Build turn separator (same as renderTurnSep in renderers.js),
    // but appendAfterPending so it goes after any existing pending
    // boxes — preserving queued-message submission order.
    optimisticSep = document.createElement("div");
    optimisticSep.className = "turn-sep";
    optimisticSep.innerHTML =
      `<span class="turn-line"></span>` +
      (state.cwd ? `<span class="turn-cwd">${escape(state.cwd)}</span>` : "") +
      `<span class="turn-time">${new Date().toLocaleTimeString()}</span>` +
      `<span class="turn-line"></span>`;
    appendAfterPending(optimisticSep);
    optimisticBox = createUserBox(query);
    optimisticBox.classList.add("pending");
    appendAfterPending(optimisticBox);
  }
  input.disabled = true;
  try {
    if (query.startsWith("/")) {
      await submitSlash(query);
    } else {
      await fetch(submitUrl, {
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
});

input?.addEventListener("keydown", (ev) => {
  if (ev.shiftKey) return;
  if (ev.key === "Enter" && !hasAcSelection()) {
    ev.preventDefault();
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  } else if (ev.key === "ArrowUp" && !input.value && state.lastQuery) {
    ev.preventDefault();
    input.value = state.lastQuery;
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

input?.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 12 * 16) + "px";
});

document.addEventListener("keydown", (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  if (meta && (ev.key === "k" || ev.key === "K")) {
    ev.preventDefault();
    input?.focus();
  }
});

export const cancelTurn = () => {
  if (!sessionId) return;
  if (!state.isProcessing) return;
  if (cancelBtn && !cancelBtn.hidden) {
    cancelBtn.classList.add("flash");
    setTimeout(() => cancelBtn.classList.remove("flash"), 200);
  }
  fetch(`/${sessionId}/cancel`, { method: "POST" }).catch(() => {});
};

cancelBtn?.addEventListener("click", cancelTurn);
