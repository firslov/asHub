// Unified panel manager — ensures only one right-side panel is open.
// Each panel registers: name, toggleBtnId, panelId, open(), close().
// Optional `load` for lazy-loaded panels — called on first toggle click.

const panels = {};
const _hasListener = new Set();

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

export const registerPanel = (name, { toggleBtnId, panelId, load, open, close }) => {
  if (!load) {
    // Direct registration (eager or from lazy-loaded module)
    panels[name] = { panelId, open, close };
  }

  if (_hasListener.has(name)) return; // Listener already set by first call
  _hasListener.add(name);

  const btn = document.getElementById(toggleBtnId);
  btn?.addEventListener("click", async () => {
    // Lazy-load on first click
    if (!panels[name]) {
      btn.disabled = true;
      try { await load(); } catch { /* panel failed to load */ }
      btn.disabled = false;
      if (!panels[name]) return; // load failed silently
    }

    if (isPanelOpen(panelId)) {
      try { panels[name].close(); } catch {}
      btn?.classList.remove("active");
    } else {
      closeOthers(name);
      const result = panels[name].open();
      if (result?.catch) result.catch(() => {});
      btn?.classList.add("active");
    }
  });
};

// ESC closes any open panel (capture phase — runs before client.js ESC)
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  for (const [name, p] of Object.entries(panels)) {
    const el = document.getElementById(p.panelId);
    const isOpen = p.panelId.includes("overlay")
      ? !(el?.hasAttribute("hidden") || el?.hidden)
      : el && !el.hidden;
    if (isOpen && el) {
      try { p.close(); } catch {}
      ev.stopImmediatePropagation();
      return; // only close one
    }
  }
}, true);
