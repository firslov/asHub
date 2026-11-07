import { AsyncLocalStorage } from 'node:async_hooks';
import { pluginCatalog, readPluginSettings } from './plugins.js';
import { updateSettingsFile } from './settings-store.js';

const identity = new AsyncLocalStorage<string>();
export const PLUGIN_AUTO_APPROVE = 'ashub.plugins.autoApprove';

/** The runtime supplies identity; model arguments and plugin defaults cannot grant consent. */
export function withPluginIdentity<T>(id: string, run: () => T): T {
  return identity.run(id, run);
}
export function currentPluginIdentity(): string | undefined {
  return identity.getStore();
}
export function pluginAutoApprovalIds(file: string): string[] {
  const value = readPluginSettings(file)[PLUGIN_AUTO_APPROVE];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}
export function canAutoApprovePlugin(file: string, id?: string): boolean {
  if (!id) return false;
  try {
    return pluginAutoApprovalIds(file).includes(id)
      && pluginCatalog(file).some(plugin => plugin.id === id && plugin.enabled && !plugin.compatibilityError);
  } catch { return false; }
}
export function setPluginAutoApproval(file: string, id: string, enabled: boolean): void {
  if (!pluginCatalog(file).some(plugin => plugin.id === id)) throw new Error('Unknown installed plugin');
  updateSettingsFile(file, settings => {
    const value = settings[PLUGIN_AUTO_APPROVE];
    const ids = new Set<string>(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []);
    if (enabled) ids.add(id); else ids.delete(id);
    return { ...settings, [PLUGIN_AUTO_APPROVE]: [...ids] };
  });
}
