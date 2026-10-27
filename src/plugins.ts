import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { updateSettingsFile } from './settings-store.js';
import { settingsValidationError } from './config-validation.js';

export const PLUGIN_DISABLED = 'ashub.plugins.disabled';
const scripts = ['.js', '.mjs', '.ts', '.tsx', '.mts'];
export interface PluginEntry {
  id: string; name: string; source: string; enabled: boolean; specifier: string;
  directoryNames: string[];
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
  for (const key of ['extensions', 'disabledExtensions', PLUGIN_DISABLED]) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || !data[key].every((s: unknown) => typeof s === 'string'))) throw new Error(`Invalid ${key}`);
  }
  return data;
}
export function pluginCatalog(file: string): PluginEntry[] {
  const settings = readPluginSettings(file), root = path.join(path.dirname(file), 'extensions');
  const entries = new Map<string, PluginEntry>();
  const explicitIds = new Set<string>();
  const add = (spec: string, directoryName?: string) => {
    let resolved = spec;
    if (spec.startsWith('.') || path.isAbsolute(spec) || (spec.includes('/') && !spec.startsWith('@'))) {
      resolved = path.resolve(spec);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        resolved = scripts.map(ext => path.join(resolved, `index${ext}`)).find(p => fs.existsSync(p)) ?? resolved;
      }
    }
    const id = createHash('sha256').update(resolved).digest('hex').slice(0, 24);
    if (!directoryName) explicitIds.add(id);
    const existing = entries.get(id);
    if (existing) { if (directoryName) existing.directoryNames.push(directoryName); return; }
    const base = path.basename(resolved).replace(/\.(tsx?|m?js|mts)$/, '');
    entries.set(id, { id, name: base === 'index' ? path.basename(path.dirname(resolved)) : base,
      source: resolved, specifier: resolved, directoryNames: directoryName ? [directoryName] : [], enabled: true });
  };
  for (const spec of settings.extensions ?? []) add(spec);
  let children: fs.Dirent[] = [];
  try { children = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const entry of children) {
    const full = path.join(root, entry.name);
    let dir = entry.isDirectory();
    if (entry.isSymbolicLink()) { try { dir = fs.statSync(full).isDirectory(); } catch { continue; } }
    const index = dir ? scripts.map(ext => path.join(full, `index${ext}`)).find(p => fs.existsSync(p)) : undefined;
    if (index || (!dir && scripts.some(ext => entry.name.endsWith(ext)))) add(index ?? full, entry.name.replace(/\.[^.]+$/, ''));
  }
  for (const entry of entries.values()) {
    // Explicit settings entries bypass the kernel's directory-only disable flag.
    const explicit = explicitIds.has(entry.id);
    entry.enabled = !(settings[PLUGIN_DISABLED] ?? []).includes(entry.id) && (explicit || !entry.directoryNames.some(n => (settings.disabledExtensions ?? []).includes(n)));
  }
  return [...entries.values()];
}
export function setPluginEnabled(file: string, id: string, enabled: boolean): void {
  const plugin = pluginCatalog(file).find(p => p.id === id);
  if (!plugin) throw new Error('Plugin no longer installed; refresh the list');
  updateSettingsFile(file, data => {
    const disabled = new Set<string>(data[PLUGIN_DISABLED] ?? []);
    if (enabled) disabled.delete(id); else disabled.add(id);
    data[PLUGIN_DISABLED] = [...disabled];
    if (enabled && Array.isArray(data.disabledExtensions)) data.disabledExtensions = data.disabledExtensions.filter((n: string) => !plugin.directoryNames.includes(n));
    return data;
  });
}


// Plugin namespaces are top-level settings keys; global application settings
// must continue to be edited through their own controls.
const reservedNamespaces = new Set([
  'extensions', 'historySize', 'providers', 'defaultProvider', 'defaultBackend',
  'thinkingLevel', 'shellTruncateThreshold', 'shellHeadLines', 'shellTailLines',
  'historyMaxBytes', 'historyStartupEntries', 'historyFilePath', 'autoCompact',
  'autoCompactThreshold', 'maxCommandOutputLines', 'readOutputMaxLines', 'diffMaxLines',
  'newFilePreviewLines', 'toolMode', 'coreTools', 'skillPaths', 'diagnose',
  'startupBanner', 'promptIndicator', 'disabledBuiltins', 'disabledExtensions',
  'subagentModels', 'subagentBudgets', 'anyProviderConfigured', '__proto__', 'constructor', 'prototype',
]);
export class PluginConfigConflict extends Error {}
function checkPluginNamespace(file: string, id: string, namespace: unknown): asserts namespace is string {
  if (id.startsWith('builtin:')) {
    const builtin = builtinPluginCatalog(file).find(p => p.id === id);
    if (!builtin?.configNamespace || namespace !== builtin.configNamespace) throw new Error('This built-in configuration is read-only or uses a different settings key');
    return;
  }
  if (!pluginCatalog(file).some(p => p.id === id)) throw new Error('Plugin no longer installed; refresh the list');
  if (typeof namespace !== 'string' || !namespace.trim() || namespace !== namespace.trim() || namespace.length > 128
      || /[\x00-\x1f\x7f]/.test(namespace) || /^ashub(?:[.]|$)/i.test(namespace) || reservedNamespaces.has(namespace)) {
    throw new Error('Use a plugin settings namespace, not an application settings key');
  }
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
