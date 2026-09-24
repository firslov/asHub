import { escape } from "./utils.js";

// Instances sharing one listEl (slash "/", prompt "#", at-mention "@" all
// render into #autocomplete) must never be open at the same time: they would
// overwrite each other's <li>s and every keydown handler would consume the
// same Tab/arrows.  When one instance opens it closes its peers.
const peersByList = new WeakMap();

export const attachAutocomplete = ({ inputEl, listEl, fetcher, accept, shouldOpen }) => {
  const state = { open: false, items: [], index: 0, token: 0, timer: null };
  let lastSig = null;

  let peers = peersByList.get(listEl);
  if (!peers) {
    peers = new Set();
    peersByList.set(listEl, peers);
  }
  const record = { close: () => close() };
  peers.add(record);

  const closePeers = () => {
    for (const peer of peers) {
      if (peer !== record) peer.close();
    }
  };

  const sigOf = (items) =>
    items.map((it) => (it.name || "") + "\x1f" + (it.description || "")).join("\x1e");

  const updateActive = () => {
    const lis = listEl.children;
    for (let i = 0; i < lis.length; i++) {
      lis[i].classList.toggle("active", i === state.index);
    }
    const active = lis[state.index];
    if (active) {
      active.scrollIntoView({ block: "nearest" });
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
    // Make close terminal.  A debounced or in-flight fetch that lands after
    // this would still pass its own `my === state.token` check and reopen the
    // list.  That matters more now that closePeers() closes an instance from a
    // peer's fetch callback: without invalidating, the closed peer reopens
    // itself and the two keep closing each other.
    state.token++;
    clearTimeout(state.timer);
    state.timer = null;
    if (state.abort) { state.abort.abort(); state.abort = null; }
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
    // During IME composition the buffer is in flux (pinyin, not a real
    // token) — skip the shouldOpen scan and fetch; compositionend re-runs it.
    if (composing) return;
    const buffer = inputEl.value;
    if (!shouldOpen(buffer)) { close(); return; }
    const my = ++state.token;
    clearTimeout(state.timer);
    // Cancel in-flight fetch to save bandwidth
    if (state.abort) { state.abort.abort(); state.abort = null; }
    state.abort = new AbortController();
    const signal = state.abort.signal;
    state.timer = setTimeout(async () => {
      try {
        const items = await fetcher(buffer, signal);
        if (my !== state.token) return;
        state.items = Array.isArray(items) ? items : [];
        state.index = 0;
        state.open = state.items.length > 0;
        if (state.open) closePeers();
        render();
      } catch {}
    }, 60);
  };

  inputEl.addEventListener("input", request);
  inputEl.addEventListener("blur", () => setTimeout(close, 100));
  let composing = false;
  inputEl.addEventListener("compositionstart", () => { composing = true; close(); });
  inputEl.addEventListener("compositionend", () => { composing = false; request(); });
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
