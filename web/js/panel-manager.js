// Unified panel manager — ensures only one right-side panel is open.
// Each panel registers: name, toggleBtnId, panelId, open(), close().
// Optional `load` for lazy-loaded panels — called on first toggle click.

const panels = {};
const _hasListener = new Set();
const guards = new Map();
const cleanups = new Map();
const observers = new Map();
let panelIntent = 0;
let loadingPanel = null;

const isPanelOpen = (panelId) => {
  const el = document.getElementById(panelId);
  return panelId.includes("overlay")
    ? !(el?.hasAttribute("hidden") || el?.hidden)
    : !!(el && !el.hidden);
};

const closeOthers = (except) => {
  for (const [name, p] of Object.entries(panels)) {
    if (name === except) continue;
    if (isPanelOpen(p.panelId)) {
      try { p.close(); } catch {}
    }
  }
};

export const closeOtherPanels = (except) => { ++panelIntent; closeOthers(except); };

export const closePanel = (name) => {
  if (loadingPanel?.name === name) { ++panelIntent; loadingPanel = null; }
  const panel = panels[name];
  if (panel && isPanelOpen(panel.panelId)) { try { panel.close(); } catch {} }
  if (panel) document.getElementById(panel.toggleBtnId)?.classList.remove('active');
};

export const unregisterPanel = (name) => {
  closePanel(name); cleanups.get(name)?.(); cleanups.delete(name);
  delete panels[name]; guards.delete(name); _hasListener.delete(name);
};

export const registerPanel = (name, { toggleBtnId, panelId, load, open, close, enabled }) => {
  if (enabled) guards.set(name, enabled);
  if (!load) {
    // Direct registration (eager or from lazy-loaded module)
    panels[name] = { panelId, toggleBtnId, open, close };
  }

  const btn = document.getElementById(toggleBtnId);
  const panelEl = document.getElementById(panelId);
  btn?.setAttribute("aria-controls", panelId);
  const syncExpanded = () => btn?.setAttribute("aria-expanded", String(isPanelOpen(panelId)));
  syncExpanded();
  // Close buttons and programmatic panel switches also update accessible state.
  // A lazy feature may create its drawer only after the first registration.
  if (panelEl && !observers.has(name)) {
    const observer = new MutationObserver(syncExpanded);
    observer.observe(panelEl, { attributes: true, attributeFilter: ["hidden"] }); observers.set(name, observer);
  }
  if (_hasListener.has(name)) return; // Listener already set by first call
  _hasListener.add(name);
  const onClick = async () => {
    if (guards.get(name)?.() === false) return;
    const intent = ++panelIntent;
    // Lazy-load on first click
    if (!panels[name]) {
      loadingPanel = { name, intent };
      btn.disabled = true;
      try { await load(); } catch { /* panel failed to load */ }
      if (loadingPanel?.intent === intent) loadingPanel = null;
      btn.disabled = guards.get(name)?.() === false;
      if (!panels[name] || intent !== panelIntent || guards.get(name)?.() === false) return;
    }

    if (isPanelOpen(panelId)) {
      try { panels[name].close(); } catch {}
      btn?.classList.remove("active");
    } else {
      closeOthers(name);
      document.dispatchEvent(new Event("ash:panel-opening"));
      const result = panels[name].open();
      if (result?.catch) result.catch(() => {});
      btn?.classList.add("active");
    }
  };
  btn?.addEventListener("click", onClick);
  cleanups.set(name, () => { observers.get(name)?.disconnect(); observers.delete(name); btn?.removeEventListener('click', onClick); });
};

// ESC closes any open panel.  Bubble phase (not capture) so a target-phase
// Escape handler that consumes the event — e.g. autocomplete.js closing the
// completion list with stopPropagation — runs first and keeps the panel
// open.  This module evaluates before client.js's body (module imports
// hoist), so this handler is registered ahead of client.js's Esc-to-cancel
// and stopImmediatePropagation below still suppresses it.
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  ++panelIntent; // Also cancel a first-open request still importing its module.
  for (const [name, p] of Object.entries(panels)) {
    const el = document.getElementById(p.panelId);
    const isOpen = p.panelId.includes("overlay")
      ? !(el?.hasAttribute("hidden") || el?.hidden)
      : el && !el.hidden;
    if (isOpen && el) {
      try { p.close(); } catch {}
      document.getElementById(p.toggleBtnId)?.focus();
      ev.stopImmediatePropagation();
      return; // only close one
    }
  }
});
