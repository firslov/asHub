import path from 'node:path';
/** Package/profile scoped storage shared by application and session entries.
 * Returns a path only; plugins own storage, migrations and lifecycle. */
export function pluginDataDirectory(settingsFile: string, pluginId: string): string {
  if (!pluginId || pluginId === '.' || pluginId === '..') throw new Error('Invalid plugin identity');
  return path.join(path.dirname(path.resolve(settingsFile)), 'hub-sessions', 'plugin-data', encodeURIComponent(pluginId));
}
