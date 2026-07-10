import { currentSessionId, state, queryHistory } from "./state.js";
import { escape, toBlobUrl } from "./utils.js";
import { appendAfterPending } from "./stream/tool-group.js";
import { createUserBox } from "./actions.js";
import { attachAutocomplete } from "./autocomplete.js";
import { attachPromptAutocomplete } from "./prompt-manager.js";
import { attachAtMentionAutocomplete } from "./at-mention.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";

const form = document.getElementById("form");
const input = document.getElementById("query");
const cancelBtn = document.getElementById("cancel-turn");
const imagePreviews = document.getElementById("image-previews");
const visionIndicator = document.getElementById("vision-indicator");

// ── Image attachments ──────────────────────────────────────────────

let attachedImages = [];  // [{ data: "<base64>", mimeType: "image/png" }]

const MAX_IMAGE_PX = 1200; // max width/height in pixels

/** Compress image to max dimension, return base64 string. */
const compressImage = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const { width, height } = img;
    if (width <= MAX_IMAGE_PX && height <= MAX_IMAGE_PX) {
      // No resize needed — passthrough
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
      return;
    }
    // Scale down
    const scale = MAX_IMAGE_PX / Math.max(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("canvas toBlob failed")); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }, file.type || "image/png", 0.85);
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
  img.src = url;
});

const addImage = async (file) => {
  try {
    const data = await compressImage(file);
    attachedImages.push({ data, mimeType: file.type || "image/png" });
    renderImagePreviews();
  } catch (e) {
    console.error("Failed to attach image:", e);
  }
};

const removeImage = (index) => {
  attachedImages.splice(index, 1);
  renderImagePreviews();
};

const renderImagePreviews = () => {
  if (!imagePreviews) return;
  // Revoke old blob URLs before replacing
  imagePreviews.querySelectorAll("img").forEach((img) => {
    if (img.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
  });
  imagePreviews.innerHTML = "";
  imagePreviews.hidden = attachedImages.length === 0;
  for (let i = 0; i < attachedImages.length; i++) {
    const img = attachedImages[i];
    const wrap = document.createElement("div");
    wrap.className = "image-preview-item";
    const url = toBlobUrl(img.data, img.mimeType);
    wrap.innerHTML =
      `<img src="${url}" alt="preview">` +
      `<button type="button" class="image-preview-remove" data-i18n-title="remove" title="Remove">&times;</button>`;
    wrap.querySelector(".image-preview-remove").addEventListener("click", () => removeImage(i));
    imagePreviews.appendChild(wrap);
  }
};

// Paste handler for images
document.addEventListener("paste", (ev) => {
  const session = activeSession.peek();
  if (!session?.agentInfo?.modalities?.includes("image")) return;
  if (document.activeElement !== input) return;
  const items = ev.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      ev.preventDefault();
      addImage(item.getAsFile());
      break;
    }
  }
});

// Upload button
visionIndicator?.addEventListener("click", () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/png,image/jpeg,image/gif,image/webp";
  inp.multiple = true;
  inp.onchange = () => {
    for (const file of inp.files) addImage(file);
    inp.remove();
  };
  inp.click();
});

// Show/hide upload button based on model capabilities
effect(() => {
  const session = activeSession.value;
  const hasVision = !!session?.agentInfo?.modalities?.includes("image");
  if (visionIndicator) visionIndicator.hidden = !hasVision;
});

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
  fetcher: async (buffer, signal) => {
    const r = await fetch(`/${currentSessionId()}/autocomplete?buffer=${encodeURIComponent(buffer)}`, { signal });
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
  const sv = activeSession.peek();
  if (!sv || sv.state.isSubmitting) return;
  sv.state.lastQuery = query;
  queryHistory.push(query);
  sv.state.isSubmitting = true;
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
      (sv.state.cwd ? `<span class="turn-cwd">${escape(sv.state.cwd)}</span>` : "") +
      `<span class="turn-time">${new Date().toLocaleTimeString()}</span>` +
      `<span class="turn-line"></span>`;
    appendAfterPending(sv, optimisticSep);
    optimisticBox = createUserBox(query, attachedImages.length > 0 ? attachedImages : null);
    optimisticBox.classList.add("pending");
    optimisticBox.dataset.queued = query;
    appendAfterPending(sv, optimisticBox);
  }
  input.disabled = true;
  const sid = sv.id;
  try {
    if (query.startsWith("/")) {
      await submitSlash(query);
    } else if (attachedImages.length > 0) {
      // Upload images first, then submit with server IDs.
      let imageRefs = attachedImages;
      try {
        const uploaded = await Promise.all(
          attachedImages.map(async (img) => {
            const r = await fetch("/api/upload", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...img, sessionId: sid }),
            });
            if (!r.ok) throw new Error("upload failed");
            const { id } = await r.json();
            return { id, mimeType: img.mimeType };
          }),
        );
        imageRefs = uploaded;
      } catch {
        // Fallback: use base64 directly if upload fails
      }
      const body = JSON.stringify({ query, images: imageRefs });
      await fetch(`/${sid}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      attachedImages = [];
      renderImagePreviews();
    } else {
      await fetch(`/${sid}/submit`, {
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
    sv.state.isSubmitting = false;
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
  } else if (ev.key === "ArrowUp" && (!input.value || queryHistory._index !== -1) && queryHistory.hasItems) {
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
