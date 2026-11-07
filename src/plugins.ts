import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { updateSettingsFile } from './settings-store.js';
import { settingsValidationError } from './config-validation.js';
import { readPluginManifest, pluginCompatibility, validatePluginNamespace, validatePluginConfig, PLUGIN_ENTRY_FILES, type NormalizedPluginManifest, type PluginCompatibility, type PluginHostEnvironment } from './extensions/manifest.js';
export { validatePluginNamespace, PLUGIN_ENTRY_FILES } from './extensions/manifest.js';

export const PLUGIN_DISABLED = 'ashub.plugins.disabled';
export const BUNDLED_ENABLED = 'ashub.plugins.bundledEnabled';
export const BUNDLED_REMOVED = 'ashub.plugins.bundledRemoved';
const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/extensions');
const bundledApps = new Map(['kimi-coding-plan', 'project-management', 'browser-automation'].map(name => ['ashub-' + name, name]));
export function includedPackageIds(entry: PluginEntry): string[] {
  return [...new Set([entry.manifest?.id, entry.packageName, entry.specifier, entry.damagedAppId]
    .filter((id): id is string => !!id && bundledApps.has(id)))];
}
export const bundledPluginId = (name: string) => createHash('sha256').update('ashub-bundled:' + name).digest('hex').slice(0, 24);
const scripts = ['.js', '.mjs', '.ts', '.tsx', '.mts'];
export interface PluginEntry {
  id: string; name: string; source: string; enabled: boolean; specifier: string;
  bundled?: boolean; includedApp?: boolean; damagedAppId?: string; description?: string; directoryNames: string[]; configuredSpecs?: string[]; version?: string; configNamespaces?: string[]; packageRoot?: string; packageName?: string;
  manifest?: NormalizedPluginManifest; compatibility?: PluginCompatibility; compatibilityError?: string;
  sessionEnabled: boolean; sessionSpecifier?: string; applicationSpecifier?: string;
}
export interface PluginStatus { id: string; name: string; state: 'loading' | 'loaded' | 'error' | 'registered' | 'inactive' | 'frontend'; error?: string; configNamespaces?: string[] }
// Bundled integrations supported by this asHub/kernel version. They are not
// local modules: listing them must never import/activate a second instance.
const builtinProviders = [
  ['openai', 'OpenAI'], ['openrouter', 'OpenRouter'], ['deepseek', 'DeepSeek'],
  ['ollama', 'Ollama'], ['ollama-cloud', 'Ollama Cloud'],
  ['zai-coding-plan', 'Z.AI Coding Plan'], ['opencode', 'OpenCode Zen'],
  ['opencode-go', 'OpenCode Go'], ['openai-compatible', 'OpenAI Compatible'],
] as const;
export interface BuiltinPluginEntry {
  id: string; name: string; source: string; enabled: boolean; builtin: true;
  required?: boolean; providerId?: string; configNamespace?: string; description: string;
  extensionName?: string;
}
export function builtinPluginCatalog(file: string): BuiltinPluginEntry[] {
  const settings = readPluginSettings(file);
  const disabled = Array.isArray(settings.disabledBuiltins) ? settings.disabledBuiltins : [];
  return [
    { id: 'builtin:agent', name: 'agent-sh', source: 'agent-sh', builtin: true, enabled: true, required: true, description: 'plugins.descAgent' },
    ...builtinProviders.map(([providerId, name]): BuiltinPluginEntry => ({
      id: `builtin:provider:${providerId}`, name, source: 'agent-sh', builtin: true, enabled: true,
      providerId, configNamespace: `providers.${providerId}`, description: 'plugins.descProvider',
    })),
    { id: 'builtin:codex-provider', name: 'Codex', source: 'agent-sh', builtin: true,
      enabled: !disabled.includes('codex-provider'), extensionName: 'codex-provider',
      configNamespace: 'codex-provider', description: 'plugins.descCodex' },
    { id: 'builtin:slash-commands', name: 'Slash commands', source: 'agent-sh', builtin: true,
      enabled: !disabled.includes('slash-commands'), extensionName: 'slash-commands', description: 'plugins.descCommands' },
    { id: 'builtin:file-autocomplete', name: 'File autocomplete', source: 'asHub', builtin: true,
      enabled: true, extensionName: 'file-autocomplete', required: true, description: 'plugins.descAutocomplete' },
  ];
}

export function readPluginSettings(file: string): Record<string, any> {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid settings object');
  for (const key of ['extensions', 'disabledExtensions', PLUGIN_DISABLED, BUNDLED_ENABLED, BUNDLED_REMOVED]) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || !data[key].every((s: unknown) => typeof s === 'string'))) throw new Error(`Invalid ${key}`);
  }
  return data;
}
function pluginPackageRoot(resolved: string, extensionsRoot: string): string | undefined {
  // A managed package owns every path beneath it. Its declaration remains
  // authoritative even when compiled subdirectories contain package.json or
  // another nested manifest for their own module/dependency metadata.
  const relative = path.relative(extensionsRoot, resolved);
  if (relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..') {
    const managed = path.join(extensionsRoot, relative.split(path.sep)[0]!);
    if (fs.existsSync(path.join(managed, 'ashub-plugin.json'))) return managed;
  }
  let dir = resolved;
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  const legacyRoot = fs.existsSync(path.join(dir, 'package.json')) ? dir : undefined;
  // Explicit paths outside the managed directory also obey a parent plugin's
  // scope. Nested module-mode package.json files do not reset that boundary.
  for (let candidate = dir; ; candidate = path.dirname(candidate)) {
    if (fs.existsSync(path.join(candidate, 'ashub-plugin.json'))) return candidate;
    if (candidate === extensionsRoot || path.dirname(candidate) === candidate) break;
  }
  return legacyRoot;
}
export function pluginCatalog(file: string, host: PluginHostEnvironment = {}): PluginEntry[] {
  const settings = readPluginSettings(file), root = path.join(path.dirname(file), 'extensions');
  const entries = new Map<string, PluginEntry>();
  const explicitIds = new Map<string, string[]>();
  const add = (spec: string, directoryName?: string, bundledId?: string) => {
    let resolved = spec, packageRoot: string | undefined;
    let manifest: NormalizedPluginManifest | undefined, compatibility: PluginCompatibility | undefined;
    let damagedAppId: string | undefined;
    let metadata: { name?: string; description?: string; version?: string; configNamespaces?: string[]; packageName?: string } = {};
    // Backslashes and drive prefixes are Windows paths even when the first directory starts with @.
    const windowsPath = path.sep === '\\' && (spec.includes('\\') || /^[A-Za-z]:/.test(spec));
    const local = spec.startsWith('.') || path.isAbsolute(spec) || windowsPath || (spec.includes('/') && !spec.startsWith('@'));
    if (local) {
      resolved = path.resolve(spec);
      packageRoot = pluginPackageRoot(resolved, root);
      try {
        if (packageRoot) {
          const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
          if (typeof pkg.name === 'string') metadata.packageName = pkg.name;
          if (typeof pkg.version === 'string' && pkg.version.length < 80) metadata.version = pkg.version;
          if (typeof pkg.description === 'string') metadata.description = pkg.description.trim().slice(0, 300);
          manifest = readPluginManifest(packageRoot, pkg.name);
          if (manifest?.schemaVersion === 1 && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            // Legacy explicit files retain their original identity and entry,
            // including when a directory also has a higher-priority index.
            manifest = { ...manifest, entries: { session: path.relative(packageRoot, resolved) } };
          }
          if (manifest) {
            metadata.name = manifest.name; metadata.configNamespaces = manifest.configNamespaces;
            compatibility = pluginCompatibility(manifest, host);
            // A synthetic non-executable identity keeps declarative-only
            // packages visible without pretending they have a session entry.
            resolved = path.join(packageRoot, manifest.entries.session ?? manifest.entries.application ?? 'index.mjs');
          }
        }
      } catch (error) {
        // A partial upgrade may leave the package and manifest naming different
        // apps. Keep both identities reserved without trusting the broken code.
        if (packageRoot && !bundledId) {
          let declaredId: unknown;
          try { declaredId = JSON.parse(fs.readFileSync(path.join(packageRoot, 'ashub-plugin.json'), 'utf8')).id; } catch {}
          if (typeof declaredId === 'string' && bundledApps.has(declaredId)) damagedAppId = declaredId;
          else if (!metadata.packageName && directoryName && bundledApps.has(directoryName)) damagedAppId = directoryName;
        }
        compatibility = { compatible: false, errors: [error instanceof Error ? error.message : String(error)] };
      }
      if (!manifest) {
        try { if (fs.statSync(resolved).isDirectory()) resolved = PLUGIN_ENTRY_FILES.map(entry => path.join(resolved, entry)).find(p => fs.existsSync(p)) ?? path.join(resolved, 'index.mjs'); } catch {}
      }
    }
    const id = bundledId ? bundledPluginId(bundledId) : createHash('sha256').update(resolved).digest('hex').slice(0, 24);
    if (!directoryName && !bundledId) explicitIds.set(id, [...(explicitIds.get(id) ?? []), spec]);
    const existing = entries.get(id);
    const directoryNames = [...new Set([...(existing?.directoryNames ?? []), ...(directoryName ? [directoryName] : [])])];
    if (existing) {
      const declared = packageRoot && fs.existsSync(path.join(packageRoot, 'ashub-plugin.json'));
      const existingDeclared = existing.packageRoot && fs.existsSync(path.join(existing.packageRoot, 'ashub-plugin.json'));
      // A lower-authority explicit/legacy record must never hide the managed
      // manifest's scope, compatibility error or installation root on dedupe.
      if (existingDeclared || !declared) { existing.directoryNames = directoryNames; return; }
    }
    const base = path.basename(resolved).replace(/\.(tsx?|m?js|mts)$/, '');
    const sessionSpecifier = manifest ? (manifest.entries.session ? path.join(packageRoot!, manifest.entries.session) : undefined) : resolved;
    entries.set(id, { id, name: metadata.name ?? (base === 'index' ? path.basename(path.dirname(resolved)) : base),
      version: metadata.version, description: metadata.description, configNamespaces: metadata.configNamespaces, packageRoot, packageName: metadata.packageName, manifest, compatibility,
      compatibilityError: compatibility?.compatible === false ? compatibility.errors.join('; ') : undefined,
      sessionEnabled: !!sessionSpecifier && compatibility?.compatible !== false, sessionSpecifier,
      applicationSpecifier: manifest?.entries.application ? path.join(packageRoot!, manifest.entries.application) : undefined,
      source: resolved, specifier: resolved, directoryNames, enabled: true, ...(bundledId ? { bundled: true } : {}), ...(damagedAppId ? { damagedAppId } : {}) });
  };
  for (const spec of settings.extensions ?? []) add(spec);
  let children: fs.Dirent[] = [];
  try { children = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const entry of children) {
    const full = path.join(root, entry.name);
    let dir = entry.isDirectory();
    if (entry.isSymbolicLink()) { try { dir = fs.statSync(full).isDirectory(); } catch { continue; } }
    const index = dir ? PLUGIN_ENTRY_FILES.map(entry => path.join(full, entry)).find(p => fs.existsSync(p)) : undefined;
    if (dir && fs.existsSync(path.join(full, 'ashub-plugin.json'))) add(full, entry.name);
    else if (index || (!dir && scripts.some(ext => entry.name.endsWith(ext)))) add(index ?? full, entry.name.replace(/\.[^.]+$/, ''));
  }
  // A user's installed copy keeps its original identity, toggle and consent.
  const installed = new Set([...entries.values()].flatMap(includedPackageIds));
  for (const [id, name] of bundledApps) {
    const dir = path.join(bundledRoot, name);
    if (!installed.has(id) && !(settings[BUNDLED_REMOVED] ?? []).includes(id) && fs.existsSync(path.join(dir, 'ashub-plugin.json'))) add(dir, undefined, id);
  }
  for (const entry of entries.values()) {
    if (includedPackageIds(entry).length) entry.includedApp = true;
    entry.configuredSpecs = explicitIds.get(entry.id);
    const explicit = explicitIds.has(entry.id);
    if (entry.bundled) { entry.enabled = (settings[BUNDLED_ENABLED] ?? []).includes(entry.id); continue; }
    entry.enabled = !(settings[PLUGIN_DISABLED] ?? []).includes(entry.id) && (explicit || !entry.directoryNames.some(n => (settings.disabledExtensions ?? []).includes(n)));
  }
  // Reject duplicate extension IDs and cycles before runtime imports anything.
  const byId = new Map<string, PluginEntry[]>();
  for (const entry of entries.values()) { const extensionId = entry.manifest?.id ?? entry.packageName; if (extensionId) byId.set(extensionId, [...(byId.get(extensionId) ?? []), entry]); }
  const fail = (entry: PluginEntry, error: string) => {
    const errors = [...new Set([...(entry.compatibility?.errors ?? []), error])];
    entry.compatibility = { compatible: false, errors }; entry.compatibilityError = errors.join('; '); entry.sessionEnabled = false;
  };
  const copies = (values: PluginEntry[]) => new Set(values.map(entry => entry.packageRoot ?? path.dirname(entry.source))).size;
  for (const duplicates of byId.values()) if (copies(duplicates) > 1) for (const entry of duplicates) fail(entry, `Duplicate plugin ID: ${entry.manifest?.id ?? entry.packageName}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string, chain: string[]) => {
    if (visiting.has(id)) { for (const cycleId of chain.slice(chain.indexOf(id))) for (const entry of byId.get(cycleId) ?? []) fail(entry, 'Plugin dependency cycle'); return; }
    if (visited.has(id)) return; visiting.add(id);
    for (const dep of byId.get(id)?.[0]?.manifest?.dependencies ?? []) if (byId.has(dep.id)) visit(dep.id, [...chain, id]);
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id, []);
  // Propagate failures transitively; the finite graph reaches a fixed point.
  for (let pass = 0; pass < entries.size; pass++) {
    let changed = false;
    const dependencies = new Map([...byId].map(([id, values]) => [id, { version: values[0]!.version,
      enabled: copies(values) === 1 && values.some(entry => entry.enabled),
      compatible: values.some(entry => entry.enabled && entry.compatibility?.compatible !== false),
    }]));
    for (const entry of entries.values()) if (entry.manifest) {
      const result = pluginCompatibility(entry.manifest, { ...host, dependencies });
      for (const error of result.errors) if (!entry.compatibility?.errors.includes(error)) { fail(entry, error); changed = true; }
    }
    if (!changed) break;
  }
  return [...entries.values()];
}
// Only an explicit reinstall clears an uninstall marker. The application
// resources remain read-only, and a manual installation always takes priority.
export function restorableApps(file: string, catalog = pluginCatalog(file)): { id: string; name: string }[] {
  const removed: string[] = readPluginSettings(file)[BUNDLED_REMOVED] ?? [];
  const present = new Set(catalog.flatMap(includedPackageIds));
  return removed.flatMap(id => {
    const folder = bundledApps.get(id);
    if (!folder || present.has(id)) return [];
    try {
      const manifest = readPluginManifest(path.join(bundledRoot, folder), id);
      return manifest ? [{ id, name: manifest.name ?? id }] : [];
    } catch { return []; }
  });
}
export function setPluginEnabled(file: string, id: string, enabled: boolean): void {
  const plugin = pluginCatalog(file).find(p => p.id === id);
  if (!plugin) throw new Error('Plugin no longer installed; refresh the list');
  if (enabled && plugin.includedApp && plugin.compatibilityError) throw new Error(plugin.compatibilityError);
  updateSettingsFile(file, data => {
    if (plugin.bundled) {
      const selected = new Set<string>(data[BUNDLED_ENABLED] ?? []);
      if (enabled) selected.add(id); else selected.delete(id);
      data[BUNDLED_ENABLED] = [...selected];
      return data;
    }
    if (!enabled && plugin.includedApp) {
      const bundledIds = new Set(includedPackageIds(plugin).map(bundledPluginId));
      if (data[BUNDLED_ENABLED]) data[BUNDLED_ENABLED] = data[BUNDLED_ENABLED].filter((value: string) => !bundledIds.has(value));
    }
    const disabled = new Set<string>(data[PLUGIN_DISABLED] ?? []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    data[PLUGIN_DISABLED] = [...disabled];
    if (enabled && Array.isArray(data.disabledExtensions)) data.disabledExtensions = data.disabledExtensions.filter((n: string) => !plugin.directoryNames.includes(n));
    return data;
  });
}


export class PluginConfigConflict extends Error {}
function checkPluginNamespace(file: string, id: string, namespace: unknown): asserts namespace is string {
  if (id.startsWith('builtin:')) {
    const builtin = builtinPluginCatalog(file).find(p => p.id === id);
    if (!builtin?.configNamespace || namespace !== builtin.configNamespace) throw new Error('This built-in configuration is read-only or uses a different settings key');
    return;
  }
  const plugin = pluginCatalog(file).find(p => p.id === id);
  if (!plugin) throw new Error('Plugin no longer installed; refresh the list');
  validatePluginNamespace(namespace);
  if (plugin.manifest?.schemaVersion === 2 && !plugin.manifest.configNamespaces.includes(namespace)) throw new Error('Plugin configuration namespace is not declared');
  if (plugin.compatibility?.compatible === false) throw new Error('Plugin manifest or host compatibility is invalid');
}
const configRevision = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
function configTarget(data: Record<string, any>, id: string, namespace: string) {
  if (id.startsWith('builtin:provider:')) {
    if (data.providers !== undefined && (!data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers))) throw new Error('providers must be an object');
    const key = namespace.slice('providers.'.length);
    return { parent: data.providers ?? {}, key };
  }
  return { parent: data, key: namespace };
}
const configObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validateCodexConfig(config: Record<string, unknown>): void {
  for (const [key, max] of [["maxRetries", 6], ["headersTimeoutRetries", 1]] as const) {
    if (Object.hasOwn(config, key) && !(typeof config[key] === 'number' && Number.isInteger(config[key])
        && (config[key] as number) >= 0 && (config[key] as number) <= max)) {
      throw new Error(`codex-provider.${key} must be an integer from 0 to ${max}`);
    }
  }
  for (const key of ['providerId', 'upstreamURL', 'originator']) {
    if (Object.hasOwn(config, key) && (typeof config[key] !== 'string' || !(config[key] as string).trim())) {
      throw new Error(`codex-provider.${key} must be a nonempty string`);
    }
  }
  if (Object.hasOwn(config, 'models') && (!Array.isArray(config.models)
      || !config.models.every(model => typeof model === 'string' && model.trim()))) {
    throw new Error('codex-provider.models must be an array of nonempty model IDs');
  }
  for (const key of ['credentialsTimeoutMs', 'headersTimeoutMs', 'idleTimeoutMs']) {
    if (Object.hasOwn(config, key) && !(typeof config[key] === 'number' && Number.isFinite(config[key]) && (config[key] as number) > 0)) {
      throw new Error(`codex-provider.${key} must be a positive number`);
    }
  }
}
export function getPluginConfig(file: string, id: string, namespace: unknown) {
  checkPluginNamespace(file, id, namespace);
  const data = readPluginSettings(file), { parent, key } = configTarget(data, id, namespace);
  const value = Object.hasOwn(parent, key) ? parent[key] : undefined;
  if (value !== undefined && !configObject(value)) throw new Error('Existing plugin configuration is not a JSON object');
  return { namespace, config: value ?? {}, revision: configRevision(value) };
}
export function savePluginConfig(file: string, id: string, namespace: unknown, config: unknown, revision: unknown) {
  checkPluginNamespace(file, id, namespace);
  if (!configObject(config)) throw new Error('Plugin configuration must be a JSON object');
  const schema = pluginCatalog(file).find(p => p.id === id)?.manifest?.configSchema?.[namespace];
  if (schema) validatePluginConfig(schema, config, namespace);
  if (namespace === 'codex-provider') validateCodexConfig(config);
  if (id.startsWith('builtin:provider:')) {
    const error = settingsValidationError({ providers: { [namespace.slice('providers.'.length)]: config } });
    if (error) throw new Error(error);
  }
  if (typeof revision !== 'string') throw new Error('Load the plugin configuration before saving');
  updateSettingsFile(file, data => {
    const { parent, key } = configTarget(data, id, namespace);
    const previous = Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (configRevision(previous) !== revision) throw new PluginConfigConflict('Configuration changed elsewhere; reload it before saving');
    parent[key] = config;
    if (id.startsWith('builtin:provider:')) data.providers = parent;
    return data;
  });
  return { namespace, config, revision: configRevision(config) };
}
