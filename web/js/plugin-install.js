import { t } from './i18n.js';

/** Installation has its own state so switching panels never loses a running job. */
export function initPluginInstall(panel, onInstalled) {
  const choose = document.getElementById('plugins-install');
  const input = document.getElementById('plugin-archive');
  const box = document.getElementById('plugin-install-preview');
  let preview = null, previewToken = '', job = null, busy = false, error = '', phase = '', pollTimer, notified = false;
  const el = (tag, cls, value) => { const n = document.createElement(tag); n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  const api = async (query, options) => {
    const r = await fetch(`/api/plugins/install${query}`, options);
    if (!r.ok) throw Object.assign(Error(await r.text() || `HTTP ${r.status}`), { status: r.status });
    return r.json();
  };
  const storageKey = 'ashub.pluginInstallJob';
  const previewKey = 'ashub.pluginInstallPreview';
  const remember = id => { try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch {} };
  const rememberPreview = id => {
    previewToken = id || '';
    try { if (id) sessionStorage.setItem(previewKey, id); else sessionStorage.removeItem(previewKey); } catch {}
  };
  const paint = () => {
    choose.disabled = busy || !!preview || !!previewToken || !!job;
    box.hidden = !preview && !job && !busy && !error;
    box.replaceChildren();
    if (preview) {
      const heading = el('div', 'plugin-install-heading');
      heading.append(el('strong', '', preview.name), el('span', 'plugin-status', preview.previousVersion ? `${preview.previousVersion} → ${preview.version}` : preview.version));
      box.append(heading);
      const fields = el('dl', 'plugin-install-fields');
      fields.append(el('dt', '', t('plugins.destination')), el('dd', '', preview.target));
      for (const c of preview.checks) fields.append(el('dt', '', t(`plugins.check.${c.label}`)), el('dd', c.ok ? '' : 'plugin-install-blocked', `${c.ok ? '✓' : '—'} ${c.detail}`));
      box.append(fields);
      if (preview.npm) box.append(el('p', 'plugins-note', t('plugins.npmInstall')));
      if (preview.setup) {
        box.append(el('p', 'plugins-note', preview.setup.description), el('code', 'plugin-install-script', preview.setup.script));
      }
      if (Object.keys(preview.defaults || {}).length) {
        const details = el('details', 'plugin-details'); details.append(el('summary', '', t('plugins.installDefaults')), el('pre', 'plugin-install-defaults', JSON.stringify(preview.defaults, null, 2))); box.append(details);
      }
      for (const permission of preview.permissions) box.append(el('p', 'plugins-note', permission));
      if (!job) box.append(el('p', 'plugins-note', t(preview.legacy ? 'plugins.legacyInstall' : 'plugins.trustedInstall')));
    }
    if (!preview && job?.name) box.append(el('strong', 'plugin-install-heading', `${job.name} ${job.version || ''}`));
    if (busy || job) {
      const status = el('p', 'plugin-install-status', t(`plugins.install.${job?.state === 'failed' ? 'failed' : job?.state === 'succeeded' ? 'done' : phase || job?.step || 'preparing'}`));
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      if (busy) status.classList.add('is-working');
      box.append(status);
    }
    if (job?.state === 'succeeded') box.append(el('p', 'plugins-note', t('plugins.installRestart')));
    if (error) { const n = el('p', 'plugins-message plugin-install-error', error); n.setAttribute('role', 'alert'); box.append(n); }
    if (!busy) {
      const actions = el('div', 'plugin-install-actions');
      const cancel = el('button', 'p-btn', t(job ? 'close' : 'plugins.installCancel')); cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        if (busy) return;
        const token = preview?.token || job?.id || previewToken;
        // Serialize cancellation with confirmation and uploads. A late DELETE
        // response must never clear a newer preview or a submitted job.
        busy = true; choose.disabled = true;
        actions.querySelectorAll('button').forEach(button => { button.disabled = true; });
        cancel.textContent = t('loading');
        try {
          if (token) await api(`?id=${encodeURIComponent(token)}`, { method: 'DELETE' });
          preview = job = null; remember(null); rememberPreview(null); error = '';
        } catch (e) { error = e.message; }
        finally { busy = false; paint(); if (!preview && !job && !previewToken) choose.focus(); }
      });
      actions.append(cancel);
      if (preview && !job) {
        const confirm = el('button', 'p-btn-primary', t(preview.previousVersion ? 'plugins.confirmUpgrade' : 'plugins.confirmInstall'));
        confirm.type = 'button'; confirm.disabled = !preview.canInstall;
        confirm.addEventListener('click', async () => {
          if (busy) return;
          busy = true; error = ''; phase = 'preparing'; paint();
          // The preview token is also the job ID. Persist it before submitting:
          // the server may start setup even if its response is lost or we reload.
          const token = preview.token;
          remember(token);
          try {
            job = await api('?action=confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
            remember(job.id); phase = ''; paint(); void poll();
          } catch (e) {
            error = e.message;
            if (e.status && e.status < 500) { remember(null); busy = false; paint(); }
            else {
              job = { id: token, name: preview.name, version: preview.version, state: 'running' };
              phase = ''; paint(); void poll();
            }
          }
        });
        actions.append(confirm);
      }
      box.append(actions);
    }
  };
  const poll = async () => {
    clearTimeout(pollTimer);
    if (!job) return;
    try {
      job = await api(`?id=${encodeURIComponent(job.id)}`);
      error = job.error || ''; busy = job.state === 'running'; phase = '';
      if (!notified && job.state === 'succeeded') { notified = true; onInstalled(); }
      paint();
      if (busy) pollTimer = setTimeout(poll, 1000);
    } catch (e) {
      // A lost response is not a failed install. Keep polling the same job.
      error = `${t('plugins.installReconnect')} ${e.message}`;
      if (e.status === 404) { busy = false; job.state = 'failed'; paint(); return; }
      paint(); pollTimer = setTimeout(poll, 3000);
    }
  };
  const upload = async file => {
    if (!file || busy || preview || previewToken || job) return;
    error = ''; notified = false;
    if (!file.name.toLowerCase().endsWith('.zip') || !file.size || file.size > 32 * 1024 * 1024) { error = t('plugins.zipLimit'); paint(); return; }
    busy = true; phase = 'checking'; paint();
    try {
      preview = await api('?action=preview', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      rememberPreview(preview.token);
    }
    catch (e) { error = e.message; }
    finally { busy = false; phase = ''; input.value = ''; paint(); }
  };
  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { void upload(input.files?.[0]); });
  panel.addEventListener('dragover', e => { if (!e.dataTransfer?.types.includes('Files')) return; e.preventDefault(); if (!busy && !preview && !previewToken && !job) panel.classList.add('plugin-drop-active'); });
  panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('plugin-drop-active'); });
  panel.addEventListener('drop', e => { e.preventDefault(); panel.classList.remove('plugin-drop-active'); void upload(e.dataTransfer?.files?.[0]); });
  document.addEventListener('langchange', paint);
  const restorePreview = async id => {
    rememberPreview(id); busy = true; phase = 'checking'; paint();
    try { preview = await api(`?action=preview&id=${encodeURIComponent(id)}`); }
    catch (e) {
      if (e.status === 409) { job = { id, state: 'running' }; remember(id); }
      else { error = e.message; if (e.status === 404) rememberPreview(null); }
    } finally { busy = !!job; phase = ''; paint(); if (job) void poll(); }
  };
  try {
    const id = sessionStorage.getItem(storageKey), token = sessionStorage.getItem(previewKey);
    if (id) { job = { id, state: 'running' }; busy = true; void poll(); }
    else if (token) void restorePreview(token);
  } catch {}
  paint();
}
