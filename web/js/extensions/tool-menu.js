// Sidebar placement belongs to the desktop host; plugin manifests only supply panel entries.
import { t } from '../i18n.js';
import { toast } from '../toast.js';

const storageKey = 'ash.toolbar.unpinned';
let temporaryPlacement;
function unpinnedTools() {
  if (temporaryPlacement) return new Set(temporaryPlacement);
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch { return new Set(); }
}
export const isToolPinned = id => !unpinnedTools().has(id);
export function setToolPinned(id, pinned) {
  const values = unpinnedTools();
  if (pinned) values.delete(id); else values.add(id);
  try {
    localStorage.setItem(storageKey, JSON.stringify([...values]));
    temporaryPlacement = undefined;
  } catch {
    temporaryPlacement = values;
    toast(t('plugins.temporaryPlacement'));
  }
  document.dispatchEvent(new Event('ash:tool-placement'));
}
export function onToolPlacementChange(refresh) {
  const storage = event => {
    if (event.key !== storageKey && event.key !== null) return;
    temporaryPlacement = undefined;
    refresh();
  };
  document.addEventListener('ash:tool-placement', refresh);
  window.addEventListener('storage', storage);
  return () => {
    document.removeEventListener('ash:tool-placement', refresh);
    window.removeEventListener('storage', storage);
  };
}
export function mountToolMenu(rail) {
  if (!rail || rail.querySelector('.rail-more')) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'toolbar-btn rail-more';
  trigger.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="9" r="1.25"/><circle cx="9" cy="9" r="1.25"/><circle cx="14" cy="9" r="1.25"/></svg><span></span>';
  const menu = document.createElement('div');
  menu.popover = 'auto';
  menu.id = 'rail-tool-menu';
  menu.className = 'rail-tool-menu';
  trigger.setAttribute('popovertarget', menu.id);
  trigger.setAttribute('aria-controls', menu.id);
  const prompts = rail.querySelector('#prompt-toggle'),
    agents = rail.querySelector('#sa-toggle');
  if (prompts && agents) rail.insertBefore(agents, prompts);
  rail.insertBefore(trigger, rail.querySelector('#plugins-toggle'));
  document.body.append(menu);
  const controls = () =>
    [...rail.children].filter(
      (el) =>
        el !== trigger &&
        el.matches('.extension-menu,#prompt-toggle,#skills-toggle') &&
        !el.hidden &&
        !el.disabled,
    );
  let unpinned = new Set(),
    launched = null;
  function read() {
    unpinned = unpinnedTools();
  }
  function sync() {
    const buttons = controls();
    for (const btn of buttons) btn.classList.toggle('rail-unpinned', unpinned.has(btn.id));
    trigger.hidden = !buttons.length;
    trigger.title = trigger.ariaLabel = t('rail.tools');
    trigger.lastElementChild.textContent = t('rail.more');
    trigger.classList.toggle(
      'active',
      buttons.some((b) => unpinned.has(b.id) && b.getAttribute('aria-expanded') === 'true'),
    );
  }
  function position() {
    const rect = trigger.getBoundingClientRect();
    menu.style.right = innerWidth - rect.left + 6 + 'px';
    menu.style.top = Math.max(8, Math.min(rect.top, innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  function renderMenu(focusId, focusPin = true) {
    const previous = document.activeElement;
    if (!focusId && menu.contains(previous)) {
      focusId = previous.closest('[data-tool]')?.dataset.tool;
      focusPin = previous.hasAttribute('aria-pressed');
    }
    menu.replaceChildren();
    for (const btn of controls()) {
      const row = document.createElement('div');
      row.dataset.tool = btn.id;
      const open = document.createElement('button'),
        pin = document.createElement('button');
      open.type = pin.type = 'button';
      const name = btn.getAttribute('aria-label') || btn.title;
      open.textContent = name;
      const icon = btn.querySelector('svg')?.cloneNode(true);
      if (icon) open.prepend(icon);
      open.classList.toggle('active', btn.getAttribute('aria-expanded') === 'true');
      open.onclick = () => {
        launched = btn;
        menu.hidePopover();
        btn.click();
      };
      const pinned = !unpinned.has(btn.id);
      pin.setAttribute('aria-label', t('rail.pin') + ' · ' + name);
      pin.setAttribute('aria-pressed', String(pinned));
      pin.textContent = t(pinned ? 'rail.pinned' : 'rail.pin');
      pin.onclick = () => {
        setToolPinned(btn.id, !pinned);
        renderMenu(btn.id);
        position();
      };
      row.append(open, pin);
      menu.append(row);
      if (focusId === btn.id) (focusPin ? pin : open).focus();
    }
    if (focusId && !menu.contains(document.activeElement)) menu.querySelector('button')?.focus();
  }
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') renderMenu();
  });
  menu.addEventListener('toggle', () => {
    const open = menu.matches(':popover-open');
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      position();
      menu.querySelector('button')?.focus();
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      menu.hidePopover();
      trigger.focus();
    }
  });
  const refresh = () => {
    sync();
    if (menu.matches(':popover-open')) {
      if (trigger.hidden) menu.hidePopover();
      else {
        renderMenu();
        position();
      }
    }
  };
  const observe = new MutationObserver((records) => {
    if (
      launched &&
      records.some((r) => r.target === launched && r.attributeName === 'aria-expanded') &&
      launched.getAttribute('aria-expanded') === 'false'
    ) {
      launched = null;
      if (document.activeElement === document.body || document.activeElement?.closest('[hidden]'))
        trigger.focus();
    }
    if (records.some((r) => !trigger.contains(r.target))) refresh();
  });
  observe.observe(rail, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'aria-expanded', 'title', 'aria-label'],
  });
  onToolPlacementChange(() => { read(); refresh(); });
  window.addEventListener('resize', () => {
    if (menu.matches(':popover-open')) position();
  });
  document.addEventListener('langchange', refresh);
  read();
  sync();
}
