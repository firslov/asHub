import { registerPanel, closePanel } from '../panel-manager.js';
import { bundledFeatures, features, featureEnabled, loadFeature, featuresReady, refreshFeatures } from './feature-state.js';
import { mountDeclarativeUI } from './declarative-ui.js';

let initialized = false;
export function initializeFeatureUI() {
  if (initialized) return;
  initialized = true;
  const contributions = new Map();
  const drafts = new Map();
  for (const feature of bundledFeatures) {
    if (!feature.panel) continue;
    registerPanel(feature.panel, {
      toggleBtnId: feature.toggle, panelId: feature.element,
      enabled: () => featureEnabled(feature.id), load: () => loadFeature(feature.id),
    });
  }
  features.subscribe(snapshot => {
    for (const feature of bundledFeatures) {
      const enabled = featureEnabled(feature.id);
      const trigger = document.getElementById(feature.toggle);
      if (trigger) { trigger.hidden = !enabled; trigger.disabled = !enabled; }
      if (!enabled && feature.panel) closePanel(feature.panel);
    }
    const present = new Set();
    const menuHost = document.getElementById('prompt-toggle')?.parentElement;
    if (!menuHost) return;
    for (const feature of snapshot.features) {
      if (!feature.enabled || !feature.ui || bundledFeatures.some(builtin => builtin.id === feature.id)) continue;
      const signature = JSON.stringify([feature.ui, feature.pluginId, feature.configNamespaces]);
      present.add(feature.id);
      if (contributions.get(feature.id)?.signature === signature) continue;
      contributions.get(feature.id)?.dispose();
      try {
        const dispose = mountDeclarativeUI(feature, { menuHost, panelHost: document.querySelector('.app') || document.body, drafts });
        contributions.set(feature.id, { signature, dispose });
      } catch { contributions.delete(feature.id); }
    }
    for (const [id, contribution] of contributions) {
      if (!present.has(id)) { contribution.dispose(); contributions.delete(id); }
    }
  });
  void featuresReady();
  document.addEventListener('ash:extensions-changed', () => { void refreshFeatures(); });
  document.addEventListener('ash:host-state-changed', event => {
    if (!event.detail?.domains || event.detail.domains.includes('extensions')) void refreshFeatures();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshFeatures(); });
  window.addEventListener('focus', () => { void refreshFeatures(); });
}
