import { initPluginInstall } from './plugin-install.js';
import { t } from './i18n.js';
import { registerPanel } from './panel-manager.js';
const panel = document.getElementById('plugins-overlay');
const list = document.getElementById('plugins-list');
const message = document.getElementById('plugins-message');
const refresh = document.getElementById('plugins-refresh');
let generation = 0, saving = false;
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
function render(plugins) {
  list.replaceChildren();
  if (!plugins.length) { list.append(node('p', 'p-empty', t('plugins.empty'))); return; }
  let group;
  for (const plugin of plugins) {
    const nextGroup = plugin.builtin ? 'plugins.builtins' : 'plugins.local';
    if (nextGroup !== group) {
      group = nextGroup; list.append(node('h3', 'plugin-group-title', t(group)));
      if (plugin.builtin) list.append(node('p', 'plugins-note', t('plugins.registrationHint')));
    }
    const item = node('section', 'plugin-item');
    const head = node('div', 'plugin-heading');
    const title = node('div', 'plugin-name', plugin.name);
    const toggle = node('button', 'p-btn plugin-toggle', t(plugin.enabled ? 'plugins.enabled' : 'plugins.disabled'));
    toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(plugin.enabled));
    toggle.setAttribute('aria-label', `${t('plugins.toggle')} ${plugin.name}`);
    toggle.disabled = saving;
    toggle.addEventListener('click', async () => {
      if (saving) return;
      saving = true; const mine = ++generation;
      list.querySelectorAll('.plugin-toggle').forEach(b => { b.disabled = true; }); refresh.disabled = true;
      message.textContent = t('plugins.saving');
      try {
        const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: plugin.id, enabled: !plugin.enabled }) });
        if (mine !== generation) return;
        render(result.plugins); message.textContent = t('plugins.saved');
      } catch (e) {
        if (mine === generation) message.textContent = `${t('plugins.failed')} · ${e.message}`;
      } finally {
        saving = false;
        if (mine === generation) { list.querySelectorAll('.plugin-toggle').forEach(b => { b.disabled = false; }); refresh.disabled = false; }
        else if (!panel.hidden) void load();
      }
    });
    const configure = node('button', 'p-btn plugin-configure', t('plugins.configure'));
    configure.type = 'button';
    const editor = !plugin.builtin || plugin.configNamespace ? pluginEditor(plugin, configure) : null;
    head.append(title);
    if (plugin.version) head.append(node('span', 'plugin-badge', plugin.version));
    if (!plugin.builtin || plugin.configNamespace) head.append(configure);
    if (plugin.builtin) {
      item.dataset.builtin = 'true';
      head.append(node('span', 'plugin-badge', t(plugin.required ? 'plugins.required' : 'plugins.builtin')));
    } else head.append(toggle);
    const source = node('div', plugin.builtin ? 'plugin-description' : 'plugin-source', plugin.builtin ? t(plugin.description) : plugin.source);
    const sessions = plugin.sessions || [];
    const loaded = sessions.filter(s => s.state === 'loaded').length;
    const failed = sessions.filter(s => s.state === 'error').length;
    const summary = node('div', 'plugin-status', sessions.length
      ? `${t('plugins.loadedCount')} ${loaded}${failed ? ` · ${t('plugins.errors')} ${failed}` : ''}${sessions.some(s => s.state === 'loading') ? ` · ${t('loading')}` : ''}`
      : t('plugins.unstarted'));
    if (plugin.builtin) {
      const counts = new Map();
      for (const session of sessions) counts.set(session.state, (counts.get(session.state) || 0) + 1);
      summary.textContent = sessions.length
        ? [...counts].map(([state, count]) => `${t(`plugins.${state}`)} ${count}`).join(' · ')
        : t('plugins.bundledHint');
      if (plugin.enabled === false) summary.textContent = `${t('plugins.disabled')} · ${summary.textContent}`;
    }
    item.append(head, source, summary);
    if (sessions.length) {
      const details = node('details', 'plugin-details');
      details.append(node('summary', '', t('plugins.sessions')));
      for (const session of sessions) {
        const row = node('div', 'plugin-session');
        row.append(node('span', '', session.title), node('span', 'plugin-status', t(`plugins.${session.state}`)));
        if (session.error) row.append(node('pre', 'plugin-error', session.error));
        details.append(row);
      }
      item.append(details);
    }
    if (editor) item.append(editor);
    list.append(item);
  }
}
async function load() {
  const mine = ++generation;
  refresh.disabled = true; message.textContent = t('loading'); list.replaceChildren();
  try {
    const result = await request();
    if (mine !== generation) return;
    render(result.plugins); message.textContent = '';
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
function pluginEditor(plugin, trigger) {
  let state = editors.get(plugin.id);
  if (!state) {
    const known = [...new Set([...(plugin.configNamespaces || []), ...(plugin.sessions || []).flatMap(s => s.configNamespaces || [])])];
    state = { namespace: plugin.configNamespace || known[0] || plugin.name, loadedNamespace: '', text: '', savedText: '', revision: '', opened: false, busy: false, message: '', confirmReload: false };
    editors.set(plugin.id, state);
  }
  const box = node('section', 'plugin-config');
  box.id = `plugin-config-${plugin.id}`;
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
  box.append(namespaceLabel, namespaceRow, hint, label, editor, confirm, feedback, actions, node('p', 'plugins-note', t(plugin.builtin ? 'plugins.builtinConfigApplies' : 'plugins.configApplies')));
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
  trigger.addEventListener('click', () => {
    state.opened = !state.opened; state.paint();
    if (state.opened && !state.loadedNamespace && !state.busy) void loadConfig();
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
