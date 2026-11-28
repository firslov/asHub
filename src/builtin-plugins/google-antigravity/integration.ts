import type { IntegrationModule } from '../../integrations.js';
import { createAntigravityPlugin, ANTIGRAVITY_SERVICE_URL } from './bridge.js';

export const createBackend: NonNullable<IntegrationModule['createBackend']> = resolveProxy => {
  const plugin = createAntigravityPlugin(() => resolveProxy(ANTIGRAVITY_SERVICE_URL));
  return {
    kind: 'antigravity', label: 'Google Antigravity', providerLabel: 'Google', switchFromAgent: true,
    makeBridge: plugin.makeBridge, project: plugin.projectSessionBackends[0],
  };
};
