import { mountFeatureControls } from './extensions/feature-controls.js';
import { refreshFeatures } from './extensions/feature-state.js';
import { initPluginInstall } from './plugin-install.js';
import { t } from './i18n.js';
import { registerPanel } from './panel-manager.js';
const panel = document.getElementById('plugins-overlay');
const list = document.getElementById('plugins-list');
const message = document.getElementById('plugins-message');
const refresh = document.getElementById('plugins-refresh');
const featureSection = document.createElement('section'); featureSection.id = 'features-list';
list.before(featureSection);
const { refresh: refreshFeatureRows } = mountFeatureControls(featureSection, id =>
  panel.querySelector(`.plugin-bound-features[data-plugin-id="${CSS.escape(id)}"]`));
const restoreActions = document.createElement('span');
restoreActions.style.display = 'contents';
panel.querySelector('.plugins-actions').append(restoreActions);
let builtinsOpen = false;
let generation = 0, saving = false;
let renderedCatalog, catalogRead = 0, refreshAfterSave = false;
const node = (tag, className, text) => {
  const el = document.createElement(tag); el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
async function request(options, url = '/api/plugins') {
  const response = await fetch(url, options);
  if (!response.ok) { const error = new Error(await response.text() || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return response.json();
}
function restoreSwitchFocus(id, wasFocused) {
  if (wasFocused && document.activeElement === document.body) document.getElementById(id)?.focus();
}
function render(plugins, restorable = []) {
  const focused = document.activeElement;
  renderedCatalog = JSON.stringify([plugins, restorable]);
  restoreActions.replaceChildren();
  for (const app of restorable) {
    const button = node('button', 'p-btn', t('plugins.restoreIncluded', { name: app.name }));
    button.type = 'button'; button.id = 'plugins-restore-'+app.id; button.dataset.restore = app.id;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await request({ method: 'POST', headers: { 'Content-Type':'application/json' }, body:JSON.stringify({id:app.id}) }, '/api/plugins/install?action=restore');
        if (!panel.hidden) await load({keepList:true});
      } catch (error) { button.disabled = false; message.textContent = error.message; }
    };
    restoreActions.append(button);
  }
  // A switch request can finish while the user is already editing another field.
  const field = panel.contains(focused) && focused.matches('.plugin-config-editor, .plugin-namespace')
    ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd,
        direction: focused.selectionDirection, scrollTop: focused.scrollTop }
    : null;
  list.replaceChildren();
  if (!plugins.length) { list.append(node('p', 'p-empty', t('plugins.empty'))); refreshFeatureRows(); return; }
  let builtinSection;
  let group;
  for (const plugin of plugins) {
    const nextGroup = plugin.builtin ? 'plugins.builtins' : 'plugins.local';
    if (nextGroup !== group) {
      group = nextGroup;
      if (plugin.builtin && !builtinSection) {
        builtinSection = node('details', 'builtin-components');
        builtinSection.open = builtinsOpen;
        builtinSection.append(node('summary', 'plugin-group-title', t(group)), node('p', 'plugins-note', t('plugins.registrationHint')));
        builtinSection.ontoggle = () => { if (builtinSection.isConnected) builtinsOpen = builtinSection.open; };
        list.append(builtinSection);
      } else if (!plugin.builtin) list.append(node('h3', 'plugin-group-title', t(group)));
    }
    const item = node('section', 'plugin-item');
    const head = node('div', 'plugin-heading');
    const title = node('div', 'plugin-name', plugin.name);
    const toggle = node('button', 'p-btn plugin-toggle', t('plugins.enablePlugin'));
    toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(plugin.enabled));
    toggle.setAttribute('aria-label', `${t('plugins.enablePlugin')} · ${plugin.name}`);
    toggle.id = 'plugin-toggle-' + plugin.id;
    const unavailable = plugin.includedApp && plugin.compatibilityError && !plugin.enabled;
    if (unavailable) toggle.dataset.unavailable = 'true';
    toggle.disabled = saving || !!unavailable;
    toggle.addEventListener('click', async () => {
      if (saving) return;
      let restoreFocus = document.activeElement === toggle;
      saving = true; const mine = ++generation;
      panel.querySelectorAll('.plugin-toggle, .plugin-approval-toggle').forEach(b => { b.disabled = true; }); refresh.disabled = true;
      message.textContent = t('plugins.saving');
      try {
        const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: plugin.id, enabled: !plugin.enabled }) });
        if (mine !== generation) return;
        restoreFocus &&= document.activeElement === document.body || document.activeElement === toggle;
        render(result.plugins, result.restorable); message.textContent = t('plugins.saved');
      } catch (e) {
        if (mine === generation) message.textContent = `${t('plugins.failed')} · ${e.message}`;
      } finally {
        finishSaving();
        if (mine === generation) { panel.querySelectorAll('.plugin-toggle, .plugin-approval-toggle').forEach(b => { b.disabled = b.dataset.unavailable === 'true'; }); refresh.disabled = false; restoreSwitchFocus(toggle.id, restoreFocus); }
        else if (!panel.hidden) void load({ keepList: true });
      }
    });
    const configure = node('button', 'p-btn plugin-configure', t('plugins.configure'));
    configure.type = 'button'; configure.id = 'plugin-configure-'+plugin.id;
    const editor = !plugin.builtin || plugin.configNamespace ? pluginEditor(plugin, configure) : null;
    head.append(title);
    if (plugin.version) head.append(node('span', 'plugin-badge', plugin.version));
    if (!plugin.builtin || plugin.configNamespace) head.append(configure);
    if (plugin.builtin) {
      item.dataset.builtin = 'true';
      head.append(node('span', 'plugin-badge', t(plugin.required ? 'plugins.required' : 'plugins.builtin')));
    } else head.append(toggle);
    const source = node('div', 'plugin-description', plugin.builtin ? t(plugin.description) : plugin.description);
    const sessions = plugin.sessions || [];
    const loaded = sessions.filter(s => s.state === 'loaded').length;
    const failed = sessions.filter(s => s.state === 'error').length;
    const summary = node('div', 'plugin-status', sessions.length
      ? `${t('plugins.loadedCount')} ${loaded}${failed ? ` · ${t('plugins.errors')} ${failed}` : ''}${sessions.some(s => s.state === 'loading') ? ` · ${t('loading')}` : ''}`
      : t('plugins.inactiveSession'));
    if (plugin.builtin) {
      const counts = new Map();
      for (const session of sessions) counts.set(session.state, (counts.get(session.state) || 0) + 1);
      summary.textContent = sessions.length
        ? [...counts].map(([state, count]) => `${t(`plugins.${state}`)} ${count}`).join(' · ')
        : t('plugins.bundledHint');
      if (plugin.enabled === false) summary.textContent = `${t('plugins.disabled')} · ${summary.textContent}`;
    }
    if (plugin.includedApp && plugin.compatibilityError) summary.textContent = plugin.compatibilityError;
    if (plugin.bundled) summary.textContent = sessions.length || plugin.compatibilityError
      ? `${t('plugins.includedSource')} · ${summary.textContent}` : t('plugins.includedSource');
    item.append(head); if (source.textContent) item.append(source); item.append(summary);
    if (sessions.length) {
      const details = node('details', 'plugin-details');
      details.append(node('summary', '', t('plugins.sessionState')));
      for (const session of sessions) {
        const row = node('div', 'plugin-session');
        row.append(node('span', '', session.title), node('span', 'plugin-status', t(`plugins.${session.state}`)));
        if (session.error) row.append(node('pre', 'plugin-error', session.error));
        details.append(row);
      }
      item.append(details);
    }
    if (editor) item.append(editor);
    (plugin.builtin ? builtinSection : list).append(item);
  }
  refreshFeatureRows();
  if (field) {
    const input = document.getElementById(field.id);
    if (input && !input.disabled && input.getClientRects().length) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(field.start, field.end, field.direction);
      input.scrollTop = field.scrollTop;
    }
  } else if (focused && focused !== document.body && document.activeElement === document.body) {
    const target = focused.isConnected ? focused : document.getElementById(focused.id);
    target?.focus({ preventScroll: true });
  }
}
async function syncOpenCatalog() {
  if (panel.hidden) return;
  if (saving) { refreshAfterSave = true; return; }
  const read = ++catalogRead, view = generation;
  try {
    const { plugins, restorable = [] } = await request();
    if (panel.hidden || saving || read !== catalogRead || view !== generation) return;
    if (JSON.stringify([plugins, restorable]) !== renderedCatalog) render(plugins, restorable);
  } catch { /* Keep the last catalog; manual refresh and reconnect can retry. */ }
}
function finishSaving() {
  saving = false;
  if (refreshAfterSave) { refreshAfterSave = false; void syncOpenCatalog(); }
}
document.addEventListener('ash:host-state-changed', event => {
  if (!event.detail?.domains || event.detail.domains.includes('extensions')) void syncOpenCatalog();
});
async function load({ keepList = false } = {}) {
  void refreshFeatures();
  const mine = ++generation;
  refresh.disabled = true; message.textContent = t('loading');
  // A request from before the panel reopened can refresh while a newer editor has focus.
  if (!keepList) { renderedCatalog = undefined; list.replaceChildren(); restoreActions.replaceChildren(); }
  try {
    const result = await request();
    if (mine !== generation) return;
    render(result.plugins, result.restorable); message.textContent = '';
  } catch (e) { if (mine === generation) message.textContent = `${t('plugins.failed')} · ${e.message}`; }
  finally { if (mine === generation) refresh.disabled = saving; }
}
function close() {
  const hadFocus = panel.contains(document.activeElement);
  ++generation; panel.hidden = true; document.getElementById('plugins-toggle')?.classList.remove('active');
  if (hadFocus) document.getElementById('plugins-toggle')?.focus();
}
registerPanel('plugins', { toggleBtnId: 'plugins-toggle', panelId: 'plugins-overlay', open: () => { panel.hidden = false; document.getElementById('plugins-close').focus(); return load(); }, close });
document.getElementById('plugins-close').addEventListener('click', close);
refresh.addEventListener('click', () => { if (!saving) void load(); });
document.addEventListener('langchange', () => { if (!panel.hidden && !saving) void load(); });


// Keep drafts through refresh, panel switches and language changes. They are
// memory-only and never stored in localStorage, which may include credentials.
const editors = new Map();
function pluginApprovalControl(plugin) {
  const section = node('div', 'plugin-approval');
  const row = node('div', 'plugin-approval-row');
  const label = node('span', '', t('plugins.autoApprove'));
  const toggle = node('button', 'p-btn plugin-approval-toggle', t(plugin.autoApprove ? 'plugins.on' : 'plugins.off'));
  toggle.type = 'button'; toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(!!plugin.autoApprove));
  toggle.setAttribute('aria-label', `${t('plugins.autoApprove')} · ${plugin.name}`);
  toggle.id = 'plugin-approval-toggle-' + plugin.id;
  toggle.disabled = saving;
  const hint = node('p', 'plugins-note', t('plugins.futureConsent'));
  const permissions = plugin.manifest?.permissions || [];
  if (plugin.manifest?.requires?.capabilities?.includes('browser-pages')) hint.textContent = t('plugins.browserConsent');
  if (permissions.length) {
    const declared = node('details', 'permission-declared');
    declared.append(node('summary', '', t('plugins.declared')), node('span', '', permissions.join(' ')));
    section.append(declared);
  }
  hint.id = `plugin-approval-${plugin.id}`;
  toggle.setAttribute('aria-describedby', hint.id);
  toggle.addEventListener('click', async () => {
    if (saving) return;
    let restoreFocus = document.activeElement === toggle;
    saving = true;
    const mine = ++generation;
    panel.querySelectorAll('.plugin-toggle, .plugin-approval-toggle').forEach(button => { button.disabled = true; });
    refresh.disabled = true; message.textContent = t('plugins.saving');
    try {
      const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id, autoApprove: !plugin.autoApprove }) });
      if (mine !== generation) return;
      restoreFocus &&= document.activeElement === document.body || document.activeElement === toggle;
      render(result.plugins, result.restorable); message.textContent = t('plugins.autoApproveSaved');
    } catch (error) {
      if (mine === generation) message.textContent = `${t('plugins.failed')} · ${error.message}`;
    } finally {
      finishSaving();
      if (mine === generation) {
        panel.querySelectorAll('.plugin-toggle, .plugin-approval-toggle').forEach(button => { button.disabled = button.dataset.unavailable === 'true'; });
        refresh.disabled = false;
        restoreSwitchFocus(toggle.id, restoreFocus);
      } else if (!panel.hidden) void load({ keepList: true });
    }
  });
  const track = node('span', 'plugin-switch-track');
  track.setAttribute('aria-hidden', 'true'); toggle.prepend(track);
  row.append(label, toggle); section.prepend(row, hint);
  return section;
}
function pluginUninstallControl(plugin) {
  const section = node('div', 'plugin-uninstall');
  const open = node('button', 'p-btn plugin-uninstall-open', t('plugins.uninstall'));
  const confirmation = node('div', 'plugin-uninstall-confirm');
  const note = node('p', 'plugins-note', t('plugins.uninstallHint').replace('{name}', plugin.name));
  const cancel = node('button', 'p-btn', t('plugins.keepPlugin'));
  const confirm = node('button', 'p-btn plugin-uninstall-submit', t('plugins.confirmUninstall'));
  const feedback = node('p', 'plugins-message');
  feedback.setAttribute('role', 'status');
  open.type = cancel.type = confirm.type = 'button';
  confirmation.append(note, cancel, confirm, feedback); confirmation.hidden = true;
  open.onclick = () => { open.hidden = true; confirmation.hidden = false; cancel.focus(); };
  cancel.onclick = () => { confirmation.hidden = true; open.hidden = false; feedback.textContent = ''; open.focus(); };
  confirm.onclick = async () => {
    if (saving) return;
    saving = true;
    const mine = ++generation;
    confirm.disabled = cancel.disabled = refresh.disabled = true;
    try {
      const result = await request({ method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: plugin.id }) });
      editors.delete(plugin.id);
      document.dispatchEvent(new CustomEvent('ash:extensions-changed'));
      if (mine === generation) { render(result.plugins, result.restorable); message.textContent = t('plugins.uninstalled'); refresh.focus(); }
    } catch (error) {
      if (mine === generation) feedback.textContent = error.message;
    } finally {
      finishSaving(); confirm.disabled = cancel.disabled = false;
      if (mine === generation) {
        refresh.disabled = false;
        panel.querySelectorAll('.plugin-toggle, .plugin-approval-toggle').forEach(button => { button.disabled = button.dataset.unavailable === 'true'; });
      } else if (!panel.hidden) void load({ keepList: true });
    }
  };
  section.append(open, confirmation);
  return section;
}
function pluginEditor(plugin, trigger) {
  let state = editors.get(plugin.id);
  if (!state) {
    const known = [...new Set([...(plugin.configNamespaces || []), ...(plugin.sessions || []).flatMap(s => s.configNamespaces || [])])];
    state = { namespace: plugin.configNamespace || known[0] || plugin.name, loadedNamespace: '', text: '', savedText: '', revision: '', opened: false, busy: false, message: '', confirmReload: false };
    editors.set(plugin.id, state);
  }
  const box = node('section', 'plugin-config');
  box.id = `plugin-config-${plugin.id}`;
  if (!plugin.builtin) {
    const features = node('div', 'plugin-bound-features');
    features.dataset.pluginId = plugin.id;
    box.append(features, pluginApprovalControl(plugin));
  }
  const advanced = node('details', 'plugin-advanced');
  advanced.open = !!state.advanced;
  advanced.append(node('summary', '', t('plugins.advanced')));
  if (!plugin.builtin && plugin.source) {
    const path = node('code', 'plugin-source', plugin.source);
    const copy = node('button', 'p-btn', t('plugins.copyPath')); copy.type = 'button';
    const copyStatus = node('span', 'plugins-note');
    copyStatus.setAttribute('role', 'status');
    copy.onclick = async () => {
      const focus = document.activeElement;
      const selection = window.getSelection();
      const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
      let copied = false;
      try {
        await navigator.clipboard.writeText(plugin.source);
        copied = true;
      } catch {
        // Permission can be denied after the drawer closed or a different selection was made.
        if (!copy.getClientRects().length || focus !== document.activeElement ||
            selection.anchorNode !== anchorNode || selection.anchorOffset !== anchorOffset ||
            selection.focusNode !== focusNode || selection.focusOffset !== focusOffset) return;
        const range = document.createRange();
        range.selectNodeContents(path);
        selection.removeAllRanges();
        selection.addRange(range);
        try { copied = document.execCommand('copy'); } catch {}
      }
      copyStatus.textContent = t(copied ? 'copied' : 'plugins.copyManually');
    };
    advanced.append(path, copy, copyStatus);
  }
  box.append(advanced);
  if (!plugin.builtin) {
    const management = pluginUninstallControl(plugin);
    management.prepend(node('div','plugin-config-label',t('plugins.management')));
    box.append(management);
  }
  const namespaceLabel = node('label', 'plugin-config-label', t('plugins.namespace'));
  const namespace = node('input', 'p-input plugin-namespace');
  namespace.id = `${box.id}-namespace`; namespaceLabel.htmlFor = namespace.id;
  namespace.readOnly = !!plugin.builtin;
  namespace.autocomplete = 'off'; namespace.spellcheck = false; namespace.value = state.namespace;
  const read = node('button', 'p-btn plugin-config-read', t('plugins.read'));
  read.type = 'button';
  const namespaceRow = node('div', 'plugin-config-namespace'); namespaceRow.append(namespace, read);
  const hint = node('p', 'plugins-note', t(plugin.builtin ? 'plugins.builtinNamespaceHint' : 'plugins.namespaceHint'));
  const label = node('label', 'plugin-config-label', t('plugins.json'));
  const editor = node('textarea', 'p-input plugin-config-editor');
  editor.id = `${box.id}-editor`; label.htmlFor = editor.id;
  editor.spellcheck = false; editor.autocomplete = 'off'; editor.rows = 10; editor.value = state.text;
  const feedback = node('p', 'plugins-message plugin-config-message'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const confirm = node('div', 'plugin-config-confirm');
  const discard = node('button', 'p-btn plugin-config-discard', t('plugins.discardRead'));
  const keep = node('button', 'p-btn', t('plugins.keepDraft'));
  discard.type = keep.type = 'button';
  confirm.append(node('p', 'plugins-note', t('plugins.discardHint')), discard, keep);
  const actions = node('div', 'plugin-config-actions');
  const status = node('span', 'plugin-status');
  const format = node('button', 'p-btn plugin-config-format', t('format'));
  const save = node('button', 'p-btn-primary plugin-config-save', t('plugins.saveConfig'));
  format.type = save.type = 'button'; actions.append(status, format, save);
  advanced.append(namespaceLabel, namespaceRow, hint, label, editor, confirm, feedback, actions, node('p', 'plugins-note', t(plugin.builtin ? 'plugins.builtinConfigApplies' : 'plugins.configApplies')));
  const dirty = () => state.text !== state.savedText;
  const ready = () => !!state.loadedNamespace && state.namespace === state.loadedNamespace;
  const parse = () => {
    const value = JSON.parse(state.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(t('plugins.objectRequired'));
    return value;
  };
  state.paint = () => {
    box.hidden = !state.opened;
    trigger.setAttribute('aria-expanded', String(state.opened)); trigger.setAttribute('aria-controls', box.id);
    trigger.textContent = t(state.opened ? 'plugins.hideConfig' : 'plugins.configure');
    namespace.disabled = read.disabled = state.busy;
    namespace.value = state.namespace;
    editor.disabled = state.busy || !ready();
    if (editor.value !== state.text) editor.value = state.text;
    save.disabled = format.disabled = state.busy || !ready();
    feedback.textContent = state.message ? (state.messageKey ? t(state.message) : state.message) : '';
    status.textContent = dirty() ? t('plugins.unsaved') : '';
    confirm.hidden = !state.confirmReload;
  };
  const notify = (key, literal = false) => { state.message = key; state.messageKey = !literal; state.paint(); };
  const loadConfig = async () => {
    if (state.busy) return;
    state.busy = true; state.confirmReload = false; notify('loading');
    const name = state.namespace;
    try {
      const result = await request(undefined, `/api/plugins/config?id=${encodeURIComponent(plugin.id)}&namespace=${encodeURIComponent(name)}`);
      state.loadedNamespace = result.namespace; state.revision = result.revision;
      state.text = state.savedText = JSON.stringify(result.config, null, 2);
      state.message = '';
    } catch (e) {
      state.message = `${t('plugins.configFailed')} · ${e.message}`; state.messageKey = false;
    } finally { state.busy = false; state.paint(); }
  };
  advanced.addEventListener('toggle', () => {
    if (!advanced.isConnected) return;
    state.advanced = advanced.open;
    if (state.opened && advanced.open && !state.loadedNamespace && !state.busy) void loadConfig();
  });
  trigger.addEventListener('click', () => {
    state.opened = !state.opened; state.paint();
    if (state.opened && advanced.open && !state.loadedNamespace && !state.busy) void loadConfig();
  });
  namespace.addEventListener('input', () => { state.namespace = namespace.value; state.confirmReload = false; state.paint(); });
  read.addEventListener('click', () => {
    if (dirty()) { state.confirmReload = true; state.paint(); }
    else void loadConfig();
  });
  discard.addEventListener('click', () => { void loadConfig(); });
  keep.addEventListener('click', () => { state.confirmReload = false; state.namespace = state.loadedNamespace; state.paint(); });
  editor.addEventListener('input', () => { state.text = editor.value; state.message = ''; state.paint(); });
  format.addEventListener('click', () => {
    try { state.text = JSON.stringify(parse(), null, 2); state.message = ''; state.paint(); }
    catch { notify('plugins.invalidJson'); }
  });
  save.addEventListener('click', async () => {
    if (state.busy || !ready()) return;
    let config;
    try { config = parse(); } catch { notify('plugins.invalidJson'); return; }
    state.busy = true; notify('plugins.saving');
    try {
      const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: plugin.id, namespace: state.loadedNamespace, config, revision: state.revision }) }, '/api/plugins/config');
      state.revision = result.revision; state.text = state.savedText = JSON.stringify(result.config, null, 2);
      state.message = 'plugins.configSaved'; state.messageKey = true;
    } catch (e) {
      state.message = e.status === 409 ? 'plugins.configConflict' : `${t('plugins.configFailed')} · ${e.message}`;
      state.messageKey = e.status === 409;
    } finally { state.busy = false; state.paint(); }
  });
  state.paint();
  return box;
}

initPluginInstall(panel, () => { if (!panel.hidden && !saving) void load(); });
