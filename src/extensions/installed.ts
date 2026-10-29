import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ensureTsSupport } from 'agent-sh/extension-loader';
import { pluginCatalog, readPluginSettings } from '../plugins.js';
import type { ApplicationExtensionContext, ApplicationExtensionDefinition, ApplicationExtensionInstance } from './application.js';

export interface InstalledApplicationContext extends ApplicationExtensionContext {
  readonly pluginId: string;
  /** Only explicitly injected host services are available; no implicit conversation identity. */
  readonly services: Readonly<Record<string, unknown>>;
  getExtensionSettings<T extends Record<string, unknown>>(namespace: string, defaults: T): T;
}
/** Installed application/UI contributions use the same package catalog, disable flag and config
 * namespaces as session plugins. No executable module is imported during discovery. */
export function installedApplicationDefinitions(settingsFile: string, options: {
  services?: Readonly<Record<string, unknown>>;
} = {}): ApplicationExtensionDefinition[] {
  const entries = pluginCatalog(settingsFile);
  const selected = entries.filter(entry => entry.applicationSpecifier || entry.manifest?.ui);
  const featureId = (id: string) => `plugin-${id}`;
  const features = new Map(selected.map(entry => [entry.manifest!.id, featureId(entry.id)]));
  return selected.map(entry => {
    const manifest = entry.manifest!;
    const specifier = entry.applicationSpecifier;
    const stats = specifier && fs.existsSync(specifier) ? fs.statSync(specifier) : undefined;
    const revision = createHash('sha256').update(JSON.stringify({ manifest, version: entry.version, compatibilityError: entry.compatibilityError, modified: stats?.mtimeMs, size: stats?.size, enabled: entry.enabled })).digest('hex');
    return {
      id: featureId(entry.id), name: entry.name, scope: specifier ? 'application' : 'frontend',
      pluginId: entry.id, configNamespaces: manifest.configNamespaces,
      initiallyEnabled: entry.enabled, revision, compatibilityError: entry.compatibilityError,
      capabilities: manifest.requires.capabilities,
      dependencies: manifest.dependencies.flatMap(dependency => features.has(dependency.id) ? [features.get(dependency.id)!] : []),
      ...(manifest.ui ? { ui: manifest.ui } : {}),
      ...(specifier ? { create: async (context: ApplicationExtensionContext): Promise<ApplicationExtensionInstance | void> => {
        if (context.signal.aborted) throw new Error('Extension activation has ended');
        if (/\.(ts|tsx|mts)$/.test(specifier)) await ensureTsSupport();
        const module = await import(pathToFileURL(path.resolve(specifier)).href + '?ashub=' + revision);
        if (context.signal.aborted) throw new Error('Extension activation has ended');
        const activate = typeof module.default === 'function' ? module.default : typeof module.default?.default === 'function' ? module.default.default : module.activate;
        if (typeof activate !== 'function') throw new Error('Missing application activate(ctx) export');
        const settings = readPluginSettings(settingsFile);
        const pluginContext: InstalledApplicationContext = Object.freeze({
          ...context, pluginId: entry.id, services: Object.freeze({ ...options.services }),
          getExtensionSettings<T extends Record<string, unknown>>(namespace: string, defaults: T): T {
            if (context.signal.aborted) throw new Error('Extension activation has ended');
            if (!manifest.configNamespaces.includes(namespace)) throw new Error('Plugin settings namespace was not declared');
            const stored = settings[namespace];
            const base = manifest.defaults?.[namespace];
            return { ...defaults, ...(base && typeof base === 'object' ? base : {}), ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) } as T;
          },
        });
        const instance = await activate(pluginContext);
        if (typeof instance === 'function') return { stop: instance };
        if (instance !== undefined && (!instance || typeof instance !== 'object' || Object.keys(instance).some(key => !['stop', 'canStop'].includes(key))
          || (instance.stop !== undefined && typeof instance.stop !== 'function') || (instance.canStop !== undefined && typeof instance.canStop !== 'function'))) {
          throw new Error('Application activation must return void, cleanup, or {stop,canStop}');
        }
        return instance;
      } } : {}),
    } satisfies ApplicationExtensionDefinition;
  });
}
