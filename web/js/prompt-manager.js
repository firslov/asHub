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
    li.className = "prompt-item";

    const info = document.createElement("div");
    info.className = "prompt-item-info";

    const name = document.createElement("span");
    name.className = "prompt-item-name";
    name.textContent = p.name;

    const preview = document.createElement("span");
    preview.className = "prompt-item-preview";
    preview.textContent = p.content.length > 60 ? p.content.slice(0, 60) + "…" : p.content;

    info.appendChild(name);
    info.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "prompt-item-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "prompt-item-btn";
    editBtn.title = t("prompts.edit");
    editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.5a1.4 1.4 0 1 1 2 2l-7 7-2.7.7.7-2.7 7-7z"/></svg>`;
    editBtn.addEventListener("click", () => startEdit(p.id));

    const delBtn = document.createElement("button");
    delBtn.className = "prompt-item-btn prompt-item-del";
    delBtn.title = t("prompts.delete");
    delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>`;
    delBtn.addEventListener("click", () => deletePrompt(p.id));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    li.appendChild(info);
    li.appendChild(actions);
    promptList.appendChild(li);
  });
};

// ── Editor ────────────────────────────────────────────────────────
const startAdd = () => {
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

// ── Panel open / close ────────────────────────────────────────────
export const setPromptOpen = (on) => {
  if (on) {
    // Close other panels via DOM — avoids circular import issues
    const ctxPanel = document.getElementById("ctx-panel");
    const filesPanel = document.getElementById("files-panel");
    const configOverlay = document.getElementById("config-overlay");

    if (ctxPanel && !ctxPanel.hasAttribute("hidden")) {
      ctxPanel.setAttribute("hidden", "");
      document.getElementById("ctx-toggle")?.classList.remove("active");
    }
    if (filesPanel && !filesPanel.hasAttribute("hidden")) {
      filesPanel.setAttribute("hidden", "");
      document.getElementById("files-toggle")?.classList.remove("active");
    }
    if (configOverlay && !configOverlay.hasAttribute("hidden")) {
      configOverlay.setAttribute("hidden", "");
      configOverlay.classList.remove("open");
      document.getElementById("config-toggle")?.classList.remove("active");
    }

    promptOverlay.removeAttribute("hidden");
    promptOverlay.classList.add("open");
    promptToggle?.classList.add("active");
    renderList();
  } else {
    promptOverlay.setAttribute("hidden", "");
    promptOverlay.classList.remove("open");
    promptToggle?.classList.remove("active");
    cancelEdit();
  }
};

// ── Event listeners ───────────────────────────────────────────────
promptToggle?.addEventListener("click", () => setPromptOpen(promptOverlay.hasAttribute("hidden")));
promptClose?.addEventListener("click", () => setPromptOpen(false));
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
    },
  });

  return promptAc;
};

// ── Refresh labels on language change ─────────────────────────────
document.addEventListener("langchange", () => {
  if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
    const addLabel = promptAddBtn?.querySelector("span");
    if (addLabel) addLabel.textContent = t("prompts.add.prompt");
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
