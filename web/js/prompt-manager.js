/**
 * Quick Prompts Manager
 * - Persists prompts in localStorage
 * - Manages prompt list panel (add / edit / delete)
 * - Attaches "#" autocomplete to the input
 */
import { t } from "./i18n.js";
import { toast } from "./toast.js";
import { attachAutocomplete } from "./autocomplete.js";

const LS_PROMPTS = "ash.prompts";
const LS_PROMPT_PREFIX = "ash.prompt.";

// ── localStorage helpers ──────────────────────────────────────────
const loadPrompts = (strict = false) => {
  try {
    const raw = localStorage.getItem(LS_PROMPTS);
    const arr = raw ? JSON.parse(raw) : [];
    const merged = new Map((Array.isArray(arr) ? arr : []).map(p => [p.id, p]));
    // Read the legacy array, then overlay per-id records. A delete marker
    // prevents a legacy entry from reappearing without rewriting that array.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LS_PROMPT_PREFIX)) continue;
      const id = key.slice(LS_PROMPT_PREFIX.length);
      const record = JSON.parse(localStorage.getItem(key));
      if (record === null) merged.delete(id);
      else merged.set(id, record);
    }
    return [...merged.values()];
  } catch (err) {
    if (strict) throw err;
    return [];
  }
};

// Reclaim legacy bodies only after their per-id replacement is committed.
// A deletion may also reclaim its own legacy body first when quota is full.
const compactLegacyPrompts = (deletedId = null) => {
  const raw = localStorage.getItem(LS_PROMPTS);
  if (!raw) return;
  const legacy = JSON.parse(raw);
  if (!Array.isArray(legacy)) return;
  const kept = legacy.filter(p => p.id !== deletedId && localStorage.getItem(LS_PROMPT_PREFIX + p.id) === null);
  if (kept.length !== legacy.length) localStorage.setItem(LS_PROMPTS, JSON.stringify(kept));
};

const savePrompts = async (change) => {
  const write = () => {
    const latest = loadPrompts(true);
    // Each action changes one id. Separate keys also protect unrelated
    // prompts in browsers/HTTP origins where Web Locks is unavailable.
    const previous = new Map(latest.map(p => [p.id, JSON.stringify(p)]));
    const next = change(latest);
    const remaining = new Set(next.map(p => p.id));
    for (const p of next) {
      const record = JSON.stringify(p);
      if (record !== previous.get(p.id)) localStorage.setItem(LS_PROMPT_PREFIX + p.id, record);
    }
    for (const id of previous.keys()) {
      if (!remaining.has(id)) {
        try { localStorage.setItem(LS_PROMPT_PREFIX + id, "null"); }
        catch (err) {
          // Shrinking the legacy array frees space without allocating a
          // second copy of the deleted body. Keep other legacy prompts.
          compactLegacyPrompts(id);
          localStorage.setItem(LS_PROMPT_PREFIX + id, "null");
        }
      }
    }
    // Cleanup is optional: a committed per-id record remains authoritative
    // even if legacy compaction is temporarily unavailable.
    try { compactLegacyPrompts(); } catch {}
    prompts = next;
  };
  // Web Locks serializes read/modify/write across same-origin windows.
  // Per-id writes remain independent when this API is unavailable.
  if (globalThis.navigator?.locks) await navigator.locks.request(LS_PROMPTS, write);
  else write();
};

let prompts = loadPrompts();

// ── DOM refs ──────────────────────────────────────────────────────
const promptToggle = document.getElementById("prompt-toggle");
const promptOverlay = document.getElementById("prompt-overlay");
const promptClose = document.getElementById("prompt-close");
const promptList = document.getElementById("prompt-list");
const promptAddBtn = document.getElementById("prompt-add-btn");
const promptEditor = document.getElementById("prompt-editor");
const promptEditorName = document.getElementById("prompt-editor-name");
const promptEditorContent = document.getElementById("prompt-editor-content");
const promptEditorSave = document.getElementById("prompt-editor-save");
const promptEditorCancel = document.getElementById("prompt-editor-cancel");
const promptEmpty = document.getElementById("prompt-empty");
const tabPrompts = document.getElementById("tab-prompts");
const tabShortcuts = document.getElementById("tab-shortcuts");

let editingId = null; // null = adding new, string = editing existing
let editingOriginal = null;
let saving = false;
let editorVersion = 0;

// ── Render prompt list ────────────────────────────────────────────
const renderList = () => {
  if (!promptList) return;
  promptList.innerHTML = "";

  if (prompts.length === 0) {
    promptEmpty?.removeAttribute("hidden");
    promptList.appendChild(promptEmpty);
    return;
  }

  promptEmpty?.setAttribute("hidden", "");

  prompts.forEach((p) => {
    const li = document.createElement("li");
    li.className = "p-row";

    const name = document.createElement("span");
    name.className = "p-row-main prompt-name";
    name.textContent = p.name;

    const preview = document.createElement("span");
    preview.className = "prompt-preview";
    preview.textContent = p.content.length > 60 ? p.content.slice(0, 60) + "…" : p.content;

    const actions = document.createElement("div");
    actions.className = "prompt-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "p-icon-btn";
    editBtn.title = t("prompts.edit");
    editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5a1.65 1.65 0 1 1 2.33 2.33l-8.16 8.16-3.67.84.84-3.67 8.16-8.16z"/></svg>`;
    editBtn.addEventListener("click", () => startEdit(p.id));

    const delBtn = document.createElement("button");
    delBtn.className = "p-icon-btn danger";
    delBtn.title = t("prompts.delete");
    delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>`;
    delBtn.addEventListener("click", () => deletePrompt(p.id));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(name);
    li.appendChild(preview);
    li.appendChild(actions);
    promptList.appendChild(li);
  });
};

// ── Editor ────────────────────────────────────────────────────────
const startAdd = () => {
  ++editorVersion;
  editingOriginal = null;
  setActiveTab("prompts");
  editingId = null;
  promptEditorName.value = "";
  promptEditorContent.value = "";
  promptEditorSave.textContent = t("prompts.add");
  promptEditor.removeAttribute("hidden");
  promptEditorName.focus();
};

const startEdit = (id) => {
  prompts = loadPrompts();
  const p = prompts.find((x) => x.id === id);
  if (!p) return;
  ++editorVersion;
  editingId = id;
  editingOriginal = JSON.stringify(p);
  promptEditorName.value = p.name;
  promptEditorContent.value = p.content;
  promptEditorSave.textContent = t("prompts.save");
  promptEditor.removeAttribute("hidden");
  promptEditorName.focus();
};

const cancelEdit = () => {
  ++editorVersion;
  editingOriginal = null;
  editingId = null;
  promptEditorName.value = "";
  promptEditorContent.value = "";
  promptEditor.setAttribute("hidden", "");
};

const doSave = async () => {
  if (saving) return;
  const name = promptEditorName.value.trim();
  const content = promptEditorContent.value.trim();
  if (!name) {
    promptEditorName.focus();
    return;
  }
  if (!content) {
    promptEditorContent.focus();
    return;
  }

  const id = editingId;
  const original = editingOriginal;
  const version = editorVersion;
  let committed;
  saving = true;
  promptEditorSave.disabled = true;
  try {
    await savePrompts((latest) => {
      if (id) {
        const idx = latest.findIndex(p => p.id === id);
        if (idx < 0 || JSON.stringify(latest[idx]) !== original) throw new Error("prompts.conflict");
        committed = { ...latest[idx], name, content };
        latest[idx] = committed;
      } else {
        committed = { id: crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join(""), name, content };
        latest.push(committed);
      }
      return latest;
    });
    if (editorVersion === version) {
      // The draft may have advanced while waiting for the lock. Associate
      // it with the committed id/snapshot without replacing newer text.
      editingId = committed.id;
      editingOriginal = JSON.stringify(committed);
      promptEditorSave.textContent = t("prompts.save");
      if (promptEditorName.value.trim() === name && promptEditorContent.value.trim() === content) cancelEdit();
    }
    renderList();
  } catch (err) {
    toast(t(err?.message === "prompts.conflict" ? "prompts.conflict" : "prompts.save.failed"), { type: "error" });
  } finally {
    saving = false;
    promptEditorSave.disabled = false;
  }
};

const deletePrompt = async (id) => {
  try {
    await savePrompts(latest => latest.filter(p => p.id !== id));
    if (editingId === id) cancelEdit();
    renderList();
  } catch {
    toast(t("prompts.save.failed"), { type: "error" });
  }
};

// Refresh lists/autocomplete without replacing a draft in the editor.
window.addEventListener("storage", (event) => {
  if (event.key !== LS_PROMPTS && event.key !== null && !event.key?.startsWith(LS_PROMPT_PREFIX)) return;
  prompts = loadPrompts();
  renderList();
});

// ── Tab switching ─────────────────────────────────────────────────
export const setActiveTab = (tab) => {
  tabPrompts?.classList.toggle("active", tab === "prompts");
  tabShortcuts?.classList.toggle("active", tab === "shortcuts");
  for (const p of promptOverlay?.querySelectorAll("[data-panel]") ?? []) {
    if (p.dataset.panel === tab) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  }
};

// ── Panel open / close ────────────────────────────────────────────
export const setPromptOpen = (on, tab = "prompts") => {
  if (on) {
    prompts = loadPrompts();
    promptOverlay.removeAttribute("hidden");
    promptToggle?.classList.add("active");
    setActiveTab(tab);
    if (tab === "prompts") renderList();
  } else {
    promptOverlay.setAttribute("hidden", "");
    promptToggle?.classList.remove("active");
    cancelEdit();
  }
};

// ── Event listeners ───────────────────────────────────────────────
promptClose?.addEventListener("click", () => setPromptOpen(false));
tabPrompts?.addEventListener("click", () => setActiveTab("prompts"));
tabShortcuts?.addEventListener("click", () => setActiveTab("shortcuts"));
promptAddBtn?.addEventListener("click", startAdd);
promptEditorSave?.addEventListener("click", doSave);
promptEditorCancel?.addEventListener("click", cancelEdit);

promptEditorName?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    promptEditorContent?.focus();
  }
});

promptEditorContent?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    doSave();
  }
});

// ── "#" autocomplete integration ──────────────────────────────────
/**
 * Attach the "#" quick-prompt autocomplete to the input element.
 * Call this from composer.js after the existing slash autocomplete is set up.
 */
export const attachPromptAutocomplete = (inputEl) => {
  const promptAc = attachAutocomplete({
    inputEl,
    listEl: document.getElementById("autocomplete"),
    shouldOpen: (b) => {
      const trimmed = b.trimStart();
      return trimmed.startsWith("#") && prompts.length > 0;
    },
    fetcher: async (buffer) => {
      const trimmed = buffer.trimStart();
      // Show all prompts that match what user typed after "#"
      const query = trimmed.slice(1).toLowerCase();
      return prompts
        .filter((p) => p.name.toLowerCase().includes(query) || p.content.toLowerCase().includes(query))
        .map((p) => ({
          name: p.name,
          description: p.content.length > 50 ? p.content.slice(0, 50) + "…" : p.content,
          content: p.content,
        }));
    },
    accept: (it) => {
      inputEl.value = it.content;
      // Match the slash accept in composer.js: notify listeners so shell
      // mode detection ("!" quick prompts) and autocomplete re-evaluation
      // run on the accepted content.
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });

  return promptAc;
};

// ── Refresh labels on language change ─────────────────────────────
document.addEventListener("langchange", () => {
  if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
    if (promptEditorSave) {
      promptEditorSave.textContent = editingId ? t("prompts.save") : t("prompts.add");
    }
    if (promptEditorCancel) {
      promptEditorCancel.textContent = t("cancel");
    }
    if (promptEditorName) {
      promptEditorName.placeholder = t("prompts.name.placeholder");
    }
    if (promptEditorContent) {
      promptEditorContent.placeholder = t("prompts.content.placeholder");
    }
  }
});

import { registerPanel } from './panel-manager.js';

// Use the same toggle, accessible state and Escape focus handling as other drawers.
registerPanel('prompts', {
  toggleBtnId: 'prompt-toggle',
  panelId: 'prompt-overlay',
  open: () => setPromptOpen(true, 'prompts'),
  close: () => setPromptOpen(false),
});
