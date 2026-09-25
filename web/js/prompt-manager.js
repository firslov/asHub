/**
 * Quick Prompts Manager
 * - Persists prompts in localStorage
 * - Manages prompt list panel (add / edit / delete)
 * - Attaches "#" autocomplete to the input
 */
import { t } from "./i18n.js";
import { attachAutocomplete } from "./autocomplete.js";

const LS_PROMPTS = "ash.prompts";

// ── localStorage helpers ──────────────────────────────────────────
const loadPrompts = () => {
  try {
    const raw = localStorage.getItem(LS_PROMPTS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

const savePrompts = (prompts) => {
  try { localStorage.setItem(LS_PROMPTS, JSON.stringify(prompts)); } catch {}
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
  setActiveTab("prompts");
  editingId = null;
  promptEditorName.value = "";
  promptEditorContent.value = "";
  promptEditorSave.textContent = t("prompts.add");
  promptEditor.removeAttribute("hidden");
  promptEditorName.focus();
};

const startEdit = (id) => {
  const p = prompts.find((x) => x.id === id);
  if (!p) return;
  editingId = id;
  promptEditorName.value = p.name;
  promptEditorContent.value = p.content;
  promptEditorSave.textContent = t("prompts.save");
  promptEditor.removeAttribute("hidden");
  promptEditorName.focus();
};

const cancelEdit = () => {
  editingId = null;
  promptEditorName.value = "";
  promptEditorContent.value = "";
  promptEditor.setAttribute("hidden", "");
};

const doSave = () => {
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

  if (editingId) {
    // Update existing
    const idx = prompts.findIndex((p) => p.id === editingId);
    if (idx !== -1) {
      prompts[idx] = { ...prompts[idx], name, content };
    }
  } else {
    // Add new
    prompts.push({ id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36), name, content });
  }

  savePrompts(prompts);
  cancelEdit();
  renderList();
};

const deletePrompt = (id) => {
  prompts = prompts.filter((p) => p.id !== id);
  savePrompts(prompts);
  // If editing the deleted prompt, cancel
  if (editingId === id) cancelEdit();
  renderList();
};

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

import { registerPanel, closeOtherPanels } from './panel-manager.js';

// Single toolbar button toggles the merged commands panel (default: prompts
// tab).  Tab switching happens inside via the .p-seg-item buttons.
const toggleCommands = () => {
  const open = promptOverlay && !promptOverlay.hasAttribute("hidden");
  if (open) {
    setPromptOpen(false);
  } else {
    closeOtherPanels("prompts");
    setPromptOpen(true, "prompts");
  }
};

promptToggle?.addEventListener("click", toggleCommands);

// Register the panel (no toggle button) so ESC-to-close and close-others
// still know about it; the toolbar toggle is wired above.
registerPanel('prompts', { toggleBtnId: null, panelId: 'prompt-overlay', open: () => setPromptOpen(true), close: () => setPromptOpen(false) });
