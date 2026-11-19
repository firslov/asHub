import { mountToolMenu } from './tool-menu.js';
import { registerPanel, closePanel } from '../panel-manager.js';
import { bundledFeatures, features, featureEnabled, loadFeature, featuresReady, refreshFeatures } from './feature-state.js';
import { panelKey } from './declarative-schema.js';
import { mountDeclarativeUI } from './declarative-ui.js';

let initialized = false;
export function initializeFeatureUI() {
  if (initialized) return;
  initialized = true;
  mountToolMenu(document.getElementById('toolbar'));
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
  window.electronAPI?.onRevealPluginResource?.(async ({ plugin, resource }) => {
    await refreshFeatures();
    const feature = features.snapshot().features.find(f => f.pluginId === plugin && f.enabled && f.ui?.panels?.some(p => p.components.some(c => c.type === 'resource' && c.id === resource)));
    if (feature) { contributions.get(feature.id)?.dispose(); contributions.delete(feature.id); features.emit(); }
    const panel = feature?.ui.panels.find(p => p.components.some(c => c.type === 'resource' && c.id === resource));
    const key = panel && panelKey(feature.id, panel.id);
    const trigger = key && document.getElementById(key + '-toggle');
    if (!trigger) { document.getElementById('plugins-toggle')?.click(); return; }
    // Remount a visible panel as well: its resource may have navigated to a form.
    closePanel(key);
    trigger.click();
  });
  void featuresReady();
  document.addEventListener('ash:extensions-changed', () => { void refreshFeatures(); });
  document.addEventListener('ash:host-state-changed', event => {
    if (!event.detail?.domains || event.detail.domains.includes('extensions')) void refreshFeatures();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshFeatures(); });
  window.addEventListener('focus', () => { void refreshFeatures(); });
}
