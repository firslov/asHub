import { escape } from "./utils.js";

export const attachAutocomplete = ({ inputEl, listEl, fetcher, accept, shouldOpen }) => {
  const state = { open: false, items: [], index: 0, token: 0, timer: null };
  let lastSig = null;

  const sigOf = (items) =>
    items.map((it) => (it.name || "") + "\x1f" + (it.description || "")).join("\x1e");

  const updateActive = () => {
    const lis = listEl.children;
    for (let i = 0; i < lis.length; i++) {
      lis[i].classList.toggle("active", i === state.index);
    }
  };

  const render = () => {
    if (!state.open || state.items.length === 0) {
      if (lastSig !== null) {
        listEl.hidden = true;
        listEl.innerHTML = "";
        lastSig = null;
      }
      return;
    }
    const sig = sigOf(state.items);
    if (sig !== lastSig) {
      listEl.innerHTML = "";
      state.items.forEach((it, i) => {
        const li = document.createElement("li");
        li.className = "autocomplete-item";
        li.innerHTML =
          `<span class="ac-name">${escape(it.name)}</span>` +
          (it.description ? `<span class="ac-desc">${escape(it.description)}</span>` : "");
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          state.index = i;
          doAccept();
        });
        listEl.appendChild(li);
      });
      lastSig = sig;
      listEl.hidden = false;
    }
    updateActive();
  };

  const close = () => {
    state.open = false;
    state.items = [];
    state.index = 0;
    render();
  };

  const doAccept = () => {
    const it = state.items[state.index];
    if (!it) return;
    accept(it);
    close();
    request();
  };

  const request = () => {
    const buffer = inputEl.value;
    if (!shouldOpen(buffer)) { close(); return; }
    const my = ++state.token;
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      try {
        const items = await fetcher(buffer);
        if (my !== state.token) return;
        state.items = Array.isArray(items) ? items : [];
        state.index = 0;
        state.open = state.items.length > 0;
        render();
      } catch {}
    }, 60);
  };

  inputEl.addEventListener("input", request);
  inputEl.addEventListener("blur", () => setTimeout(close, 100));
  inputEl.addEventListener("keydown", (ev) => {
    if (!state.open) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      state.index = (state.index + 1) % state.items.length;
      updateActive();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      state.index = (state.index - 1 + state.items.length) % state.items.length;
      updateActive();
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      doAccept();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  });

  return {
    close,
    hasSelection: () => state.open && state.items[state.index] != null,
    acceptCurrent: doAccept,
  };
};
