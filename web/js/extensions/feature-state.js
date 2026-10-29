import { FeatureRegistry } from './feature-registry.js';

// The sole executable frontend catalog. Network/third-party metadata is declarative.
export const bundledFeatures = [
  { id: 'quick-prompts', name: 'Quick prompts', title: 'features.quick-prompts', description: 'features.quick-prompts.description', panel: 'prompts', toggle: 'prompt-toggle', element: 'prompt-overlay', load: () => import('../prompt-manager.js') },
  { id: 'skills-marketplace', name: 'Skills marketplace', title: 'features.skills-marketplace', description: 'features.skills-marketplace.description', panel: 'skills', toggle: 'skills-toggle', element: 'skills-overlay', load: () => import('../skills-panel.js') },
  { id: 'provider-balance', name: 'Provider balance', title: 'features.provider-balance', description: 'features.provider-balance.description' },
  { id: 'mobile-access', name: 'Mobile access', title: 'features.mobile-access', description: 'features.mobile-access.description', scope: 'application', panel: 'mobile-access', toggle: 'mobile-access-toggle', element: 'mobile-access-panel', load: () => import('../mobile-access.js') },
];
export const features = new FeatureRegistry(bundledFeatures);
export const featureEnabled = id => features.enabled(id);
export const loadFeature = async id => { await featuresReady(); return features.load(id); };
let ready;
export const refreshFeatures = () => features.refresh();
export const featuresReady = () => ready ||= refreshFeatures();
