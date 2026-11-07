import { t } from '../i18n.js';
import { bundledFeatures, features, refreshFeatures } from './feature-state.js';

import { panelKey } from './declarative-schema.js';
import { isToolPinned, onToolPlacementChange, setToolPinned } from './tool-menu.js';

export function mountFeatureControls(container, ownerFor) {
  const title = document.createElement('h3'); title.className = 'feature-group-title';
  const note = document.createElement('p'); note.className = 'plugins-note';
  const feedback = document.createElement('p'); feedback.className = 'plugins-message'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const list = document.createElement('div');
  container.append(title, note, feedback, list);
  const rows = new Map();
  const render = snapshot => {
    title.textContent = t('features.title'); note.textContent = t('features.hint');
    feedback.textContent = snapshot.error ? `${t('features.failed')} · ${snapshot.error}` : snapshot.supported === false ? t('features.legacy') : snapshot.supported === null ? t('loading') : '';
    const present = new Set(snapshot.features.map(feature => feature.id));
    for (const [id, row] of rows) { if (!present.has(id)) { row.item.remove(); rows.delete(id); } }
    for (const feature of snapshot.features) {
      const owner = feature.pluginId && ownerFor?.(feature.pluginId);
      if (feature.pluginId && ownerFor && !owner) {
        rows.get(feature.id)?.item.remove();
        continue;
      }
      const definition = bundledFeatures.find(item => item.id === feature.id);
      let row = rows.get(feature.id);
      if (!row) {
        const item = document.createElement('section'); item.className = 'feature-item'; item.dataset.featureId = feature.id;
        const head = document.createElement('div'); head.className = 'plugin-heading';
        const name = document.createElement('span'); name.className = 'plugin-name';
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'p-btn feature-toggle'; toggle.setAttribute('role', 'switch');
        const description = document.createElement('p'); description.className = 'plugin-description';
        head.append(name, toggle); item.append(head, description); list.append(item);
        toggle.addEventListener('click', async () => {
          const snapshot = features.snapshot();
          const current = snapshot.features.find(item => item.id === feature.id);
          if (snapshot.busy || !current || toggle.disabled) return;
          try { await features.setEnabled(feature.id, !current.enabled); } catch {}
        });
        row = { item, name, toggle, description }; rows.set(feature.id, row);
      }
      const parent = owner || list;
      if (row.item.parentElement !== parent) parent.append(row.item);
      row.name.textContent = owner ? t('plugins.featureService') : definition ? t(definition.title) : feature.name;
      row.description.textContent = definition ? t(definition.description) : t('features.declarative');
      row.description.hidden = !!owner;
      if (owner && feature.ui?.panels) {
        row.entries ??= new Map();
        const present = new Set();
        for (const panel of feature.ui.panels) {
          const id = panelKey(feature.id, panel.id) + '-toggle';
          present.add(id);
          let control = row.entries.get(id);
          if (!control) {
            control = document.createElement('button');
            control.type = 'button'; control.className = 'p-btn plugin-entry-toggle';
            control.setAttribute('role', 'switch');
            control.onclick = () => setToolPinned(id, !isToolPinned(id));
            row.entries.set(id, control); row.item.append(control);
          }
          control.textContent = t('plugins.showEntry') + (feature.ui.panels.length > 1 ? ' · ' + panel.title : '');
          control.setAttribute('aria-checked', String(isToolPinned(id)));
          control.title = t('plugins.remainMore');
          control.disabled = !feature.enabled;
        }
        for (const [id, control] of row.entries) if (!present.has(id)) { control.remove(); row.entries.delete(id); }
      } else if (row.entries) {
        for (const control of row.entries.values()) control.remove();
        row.entries.clear();
      }
      row.toggle.textContent = snapshot.busy ? t('plugins.saving') : t(feature.enabled ? 'plugins.enabled' : 'plugins.disabled');
      row.toggle.setAttribute('aria-checked', String(feature.enabled));
      row.toggle.setAttribute('aria-label', `${t('features.toggle')} ${row.name.textContent}`);
      row.toggle.disabled = snapshot.supported !== true || feature.state === 'unavailable';
      row.toggle.setAttribute('aria-disabled', String(snapshot.busy || row.toggle.disabled));
    }
  };
  const unsubscribe = features.subscribe(render);
  const language = () => render(features.snapshot());
  document.addEventListener('langchange', language);
  void refreshFeatures();
  const stopPlacement = onToolPlacementChange(language);
  const dispose = () => {
    unsubscribe(); stopPlacement(); document.removeEventListener('langchange', language);
    for (const row of rows.values()) row.item.remove();
    container.replaceChildren();
  };
  return Object.assign(dispose, { refresh: language });
}
