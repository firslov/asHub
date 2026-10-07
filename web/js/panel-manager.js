// Unified panel manager — ensures only one right-side panel is open.
// Each panel registers: name, toggleBtnId, panelId, open(), close().
// Optional `load` for lazy-loaded panels — called on first toggle click.

const panels = {};
const _hasListener = new Set();
let panelIntent = 0;

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

export const registerPanel = (name, { toggleBtnId, panelId, load, open, close }) => {
  if (!load) {
    // Direct registration (eager or from lazy-loaded module)
    panels[name] = { panelId, toggleBtnId, open, close };
  }

  if (_hasListener.has(name)) return; // Listener already set by first call
  _hasListener.add(name);

  const btn = document.getElementById(toggleBtnId);
  const panelEl = document.getElementById(panelId);
  btn?.setAttribute("aria-controls", panelId);
  const syncExpanded = () => btn?.setAttribute("aria-expanded", String(isPanelOpen(panelId)));
  syncExpanded();
  // Close buttons and programmatic panel switches also update accessible state.
  if (panelEl) new MutationObserver(syncExpanded).observe(panelEl, { attributes: true, attributeFilter: ["hidden"] });
  btn?.addEventListener("click", async () => {
    const intent = ++panelIntent;
    // Lazy-load on first click
    if (!panels[name]) {
      btn.disabled = true;
      try { await load(); } catch { /* panel failed to load */ }
      btn.disabled = false;
      if (!panels[name] || intent !== panelIntent) return;
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
  });
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
