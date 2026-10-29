import { t } from '../i18n.js';
import { bundledFeatures, features, refreshFeatures } from './feature-state.js';

export function mountFeatureControls(container) {
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
          const current = features.snapshot().features.find(item => item.id === feature.id);
          if (!current || toggle.disabled) return;
          try { await features.setEnabled(feature.id, !current.enabled); } catch {}
        });
        row = { item, name, toggle, description }; rows.set(feature.id, row);
      }
      row.name.textContent = definition ? t(definition.title) : feature.name;
      row.description.textContent = definition ? t(definition.description) : t('features.declarative');
      row.toggle.textContent = snapshot.busy ? t('plugins.saving') : t(feature.enabled ? 'plugins.enabled' : 'plugins.disabled');
      row.toggle.setAttribute('aria-checked', String(feature.enabled));
      row.toggle.setAttribute('aria-label', `${t('features.toggle')} ${row.name.textContent}`);
      row.toggle.disabled = snapshot.busy || snapshot.supported !== true || feature.state === 'unavailable';
    }
  };
  const unsubscribe = features.subscribe(render);
  const language = () => render(features.snapshot());
  document.addEventListener('langchange', language);
  void refreshFeatures();
  return () => { unsubscribe(); document.removeEventListener('langchange', language); container.replaceChildren(); };
}
