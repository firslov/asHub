import fs from 'node:fs';
import path from 'node:path';
import { satisfies, valid, validRange } from 'semver';

export const HOST_PLUGIN_API_VERSION = '1.0.0';
export const HOST_PLUGIN_CAPABILITIES = ['session-extensions', 'application-lifecycle'] as const;
/** Match the client's JSON.stringify(ui).length limit (UTF-16 code units, not bytes). */
export const MAX_PLUGIN_UI_JSON_CHARS = 262144;
export const PLUGIN_ENTRY_FILES = ['index.js', 'index.mjs', 'index.ts', 'index.tsx', 'index.mts'];
const safeId = /^[a-z][a-z0-9-]{1,79}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v: object, key: string) => Object.hasOwn(v, key);
const reservedNamespaces = new Set([
  'extensions', 'historySize', 'providers', 'defaultProvider', 'defaultBackend',
  'thinkingLevel', 'shellTruncateThreshold', 'shellHeadLines', 'shellTailLines',
  'historyMaxBytes', 'historyStartupEntries', 'historyFilePath', 'autoCompact',
  'autoCompactThreshold', 'maxCommandOutputLines', 'readOutputMaxLines', 'diffMaxLines',
  'newFilePreviewLines', 'toolMode', 'coreTools', 'skillPaths', 'diagnose',
  'startupBanner', 'promptIndicator', 'disabledBuiltins', 'disabledExtensions',
  'subagentModels', 'subagentBudgets', 'anyProviderConfigured', '__proto__', 'constructor', 'prototype',
]);
export function validatePluginNamespace(namespace: unknown): asserts namespace is string {
  if (typeof namespace !== 'string' || !namespace.trim() || namespace !== namespace.trim() || namespace.length > 128
    || /[\x00-\x1f\x7f]/.test(namespace) || /^ashub(?:[.]|$)/i.test(namespace) || reservedNamespaces.has(namespace)) {
    throw new Error('Use a plugin settings namespace, not an application settings key');
  }
}
function text(value: unknown, max = 300): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid plugin metadata');
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unsupported ${label}: ${key}`);
}
export function pluginRelativePath(value: unknown): string {
  text(value, 500);
  if (value.includes('\\') || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..'
    || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Unsafe plugin path');
  return value;
}
export interface PluginDependency { id: string; minVersion: string }
/** Deliberately limited JSON Schema subset. Unknown keywords are rejected. */
export interface PluginConfigSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  title?: string; description?: string; default?: unknown; enum?: unknown[];
  properties?: Record<string, PluginConfigSchema>; required?: string[]; additionalProperties?: boolean;
  items?: PluginConfigSchema; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
}
interface ManifestBase {
  id: string; name?: string; platforms?: string[]; minNode?: string; dependencies?: PluginDependency[];
  setup?: { script: string; description: string }; permissions?: string[]; defaults?: Record<string, Record<string, unknown>>;
}
export interface PluginManifestV1 extends ManifestBase { schemaVersion: 1 }
export interface PluginManifestV2 extends ManifestBase {
  schemaVersion: 2; entries?: { session?: string; application?: string }; ui?: PluginDeclarativeUI; configNamespaces?: string[];
  requires?: { hostApi?: string; capabilities?: string[] };
  configSchema?: Record<string, PluginConfigSchema>;
}
export type PluginManifest = PluginManifestV1 | PluginManifestV2;
export interface NormalizedPluginManifest extends ManifestBase {
  schemaVersion: 1 | 2; entries: { session?: string; application?: string };
  requires: { hostApi: string; capabilities: string[] }; dependencies: PluginDependency[];
  configSchema?: Record<string, PluginConfigSchema>;
  configNamespaces: string[]; ui?: PluginDeclarativeUI;
}
export interface PluginDeclarativeUI { version: 1; panels: Array<{ id: string; title: string; components: PluginUIComponent[] }> }
export type PluginUIComponent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string; tone?: 'neutral' | 'success' | 'warning' }
  | { type: 'list'; items: string[] }
  | { type: 'action'; label: string; action: 'composer.insert'; value: string }
  | { type: 'form'; id: string; mode?: 'draft' | 'config'; namespace?: string; fields: PluginUIField[] };
export type PluginUIField = { id: string; label: string } & (
  | { type: 'text'; value?: string }
  | { type: 'number'; value?: number; min?: number; max?: number }
  | { type: 'boolean'; value?: boolean }
  | { type: 'select'; value?: string; options: Array<{ value: string; label: string }> });
function uiText(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw Error('Invalid UI text');
}
function uiId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(value) || reservedProperty(value)) throw Error('Invalid UI ID');
}
function validateUI(raw: unknown, namespaces: string[], schemas?: Record<string, PluginConfigSchema>): asserts raw is PluginDeclarativeUI {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.panels) || !raw.panels.length || raw.panels.length > 8) throw Error('Invalid declarative UI');
  if (JSON.stringify(raw).length > MAX_PLUGIN_UI_JSON_CHARS) throw Error(`Declarative UI exceeds ${MAX_PLUGIN_UI_JSON_CHARS} JSON characters`);
  keys(raw, ['version', 'panels'], 'UI field'); const panels = new Set<string>();
  for (const panel of raw.panels) {
    if (!object(panel)) throw Error('Invalid UI panel'); keys(panel, ['id', 'title', 'components'], 'panel field'); uiId(panel.id); uiText(panel.title, 200);
    if (panels.has(panel.id)) throw Error('Duplicate UI panel'); panels.add(panel.id);
    if (!Array.isArray(panel.components) || panel.components.length > 32) throw Error('Invalid UI components'); const forms = new Set<string>();
    for (const c of panel.components) {
      if (!object(c)) throw Error('Invalid UI component');
      if (c.type === 'text' || c.type === 'status') {
        keys(c, c.type === 'text' ? ['type', 'text'] : ['type', 'text', 'tone'], 'component field'); uiText(c.text, 8000, true);
        if (c.tone !== undefined && !['neutral', 'success', 'warning'].includes(c.tone)) throw Error('Invalid status tone');
      } else if (c.type === 'list') {
        keys(c, ['type', 'items'], 'component field');
        if (!Array.isArray(c.items) || c.items.length > 100) throw Error('Invalid UI list'); for (const item of c.items) uiText(item, 8000, true);
      } else if (c.type === 'action') {
        keys(c, ['type', 'label', 'action', 'value'], 'component field'); uiText(c.label, 200); uiText(c.value, 8000, true);
        if (c.action !== 'composer.insert') throw Error('Unsupported UI action');
      } else if (c.type === 'form') {
        keys(c, ['type', 'id', 'mode', 'namespace', 'fields'], 'component field'); uiId(c.id);
        if (forms.has(c.id)) throw Error('Duplicate UI form'); forms.add(c.id);
        if (c.mode !== undefined && !['draft', 'config'].includes(c.mode)) throw Error('Invalid form mode');
        if (c.mode === 'config') { if (typeof c.namespace !== 'string' || !namespaces.includes(c.namespace)) throw Error('Configuration form namespace must be declared'); }
        else if (c.namespace !== undefined) throw Error('Draft forms cannot bind a configuration namespace');
        if (!Array.isArray(c.fields) || c.fields.length > 32) throw Error('Invalid UI fields'); const fields = new Set<string>();
        for (const f of c.fields) {
          if (!object(f)) throw Error('Invalid UI field'); uiId(f.id); uiText(f.label, 200);
          if (fields.has(f.id)) throw Error('Duplicate UI field'); fields.add(f.id);
          const common = ['type', 'id', 'label', 'value'];
          if (f.type === 'text') { keys(f, common, 'form field'); if (f.value !== undefined) uiText(f.value, 8000, true); }
          else if (f.type === 'boolean') { keys(f, common, 'form field'); if (f.value !== undefined && typeof f.value !== 'boolean') throw Error('Invalid boolean field'); }
          else if (f.type === 'number') {
            keys(f, [...common, 'min', 'max'], 'form field');
            for (const key of ['value', 'min', 'max']) if (f[key] !== undefined && (typeof f[key] !== 'number' || !Number.isFinite(f[key]))) throw Error('Invalid numeric field');
            if (f.min > f.max || (f.value !== undefined && (f.value < f.min || f.value > f.max))) throw Error('Invalid numeric field range');
          } else if (f.type === 'select') {
            keys(f, [...common, 'options'], 'form field');
            if (!Array.isArray(f.options) || !f.options.length || f.options.length > 50) throw Error('Invalid select options'); const options = new Set<string>();
            for (const option of f.options) {
              if (!object(option)) throw Error('Invalid select option'); keys(option, ['value', 'label'], 'option field'); uiText(option.value, 200, true); uiText(option.label, 200);
              if (options.has(option.value)) throw Error('Duplicate select option'); options.add(option.value);
            }
            if (f.value !== undefined && !options.has(f.value)) throw Error('Invalid select value');
          } else throw Error('Unsupported UI form field type');
          if (c.mode === 'config' && schemas?.[c.namespace]) {
            const schema = schemas[c.namespace], fieldSchema = schema.properties?.[f.id];
            if (!fieldSchema) throw Error('Configuration form fields must exist in the namespace schema');
            const supported = f.type === 'number' ? ['number', 'integer'] : f.type === 'select' ? ['string'] : [f.type === 'text' ? 'string' : f.type];
            if (!supported.includes(fieldSchema.type)) throw Error('Configuration form field type differs from schema');
            if (f.value !== undefined) validatePluginConfig(fieldSchema, f.value, `${c.namespace}.${f.id}`);
          }
        }
      } else throw Error('Unsupported UI component type');
    }
  }
}
function validateSchema(value: unknown, depth = 0): asserts value is PluginConfigSchema {
  if (!object(value) || depth > 12) throw Error('Invalid configuration schema');
  keys(value, ['type', 'title', 'description', 'default', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum', 'minLength', 'maxLength'], 'configuration schema keyword');
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(value.type)) throw Error('Unsupported configuration schema type');
  for (const key of ['title', 'description']) if (value[key] !== undefined) text(value[key], 1000);
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 100)) throw Error('Invalid schema enum');
  if (value.type === 'object') {
    if (value.properties !== undefined) {
      if (!object(value.properties) || Object.keys(value.properties).length > 100) throw Error('Invalid schema properties');
      for (const [key, schema] of Object.entries(value.properties)) { if (reservedProperty(key)) throw Error('Unsafe configuration property'); validateSchema(schema, depth + 1); }
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || !value.required.every((key: unknown) => typeof key === 'string' && own(value.properties ?? {}, key)))) throw Error('Invalid schema required properties');
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') throw Error('Invalid additionalProperties');
  } else if (['properties', 'required', 'additionalProperties'].some(key => own(value, key))) throw Error('Object schema keywords require type object');
  if (value.type === 'array') { if (!value.items) throw Error('Array schema requires items'); validateSchema(value.items, depth + 1); }
  else if (own(value, 'items')) throw Error('items requires type array');
  for (const key of ['minimum', 'maximum']) if (own(value, key) && (!['number', 'integer'].includes(value.type) || typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw Error('Invalid numeric schema constraint');
  for (const key of ['minLength', 'maxLength']) if (own(value, key) && (value.type !== 'string' || !Number.isSafeInteger(value[key]) || value[key] < 0)) throw Error('Invalid string schema constraint');
  if (value.minimum > value.maximum || value.minLength > value.maxLength) throw Error('Invalid schema constraint range');
  if (value.enum) for (const candidate of value.enum) validatePluginConfig({ ...value, enum: undefined } as PluginConfigSchema, candidate, 'schema.enum');
  if (own(value, 'default')) validatePluginConfig(value as PluginConfigSchema, value.default);
}
function reservedProperty(key: string) { return ['__proto__', 'constructor', 'prototype'].includes(key); }
export function validatePluginConfig(schema: PluginConfigSchema, value: unknown, location = 'config', depth = 0): void {
  if (depth > 32) throw Error('Configuration is too deeply nested');
  const fail = (detail: string): never => { throw Error(`${location}: ${detail}`); };
  if (schema.type === 'object') {
    if (!object(value)) fail('must be an object');
    const config = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!own(config, key)) fail(`missing ${key}`);
    for (const [key, v] of Object.entries(config)) {
      if (reservedProperty(key)) fail('unsafe property');
      const child = schema.properties && own(schema.properties, key) ? schema.properties[key] : undefined;
      if (child) validatePluginConfig(child, v, `${location}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) fail(`unknown property ${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array');
    for (const item of value as unknown[]) validatePluginConfig(schema.items!, item, `${location}[]`, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('must be a string');
    const v = value as string;
    if ((schema.minLength !== undefined && v.length < schema.minLength) || (schema.maxLength !== undefined && v.length > schema.maxLength)) fail('invalid string length');
  } else if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail('must be a boolean'); }
  else {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail(`must be ${schema.type}`);
    if ((schema.minimum !== undefined && (value as number) < schema.minimum) || (schema.maximum !== undefined && (value as number) > schema.maximum)) fail('outside allowed range');
  }
  if (schema.enum && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) fail('not an allowed value');
}
export function parsePluginManifest(raw: unknown, packageName: string, legacySessionEntry = 'index.mjs'): NormalizedPluginManifest {
  if (!object(raw) || ![1, 2].includes(raw.schemaVersion) || !safeId.test(raw.id) || raw.id !== packageName) throw Error('Invalid installation manifest');
  const m = raw;
  if (m.schemaVersion === 2) keys(m, ['schemaVersion', 'id', 'name', 'platforms', 'minNode', 'dependencies', 'setup', 'permissions', 'defaults', 'entries', 'requires', 'configSchema', 'configNamespaces', 'ui'], 'manifest field');
  if (m.name !== undefined) text(m.name, 100);
  if (m.platforms !== undefined && (!Array.isArray(m.platforms) || !m.platforms.length || !m.platforms.every((v: unknown) => ['darwin', 'win32', 'linux'].includes(v as string)))) throw Error('Invalid platforms');
  if (m.minNode !== undefined && (typeof m.minNode !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.minNode) || !valid(m.minNode))) throw Error('Invalid minimum Node version');
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies) || m.dependencies.length > 10) throw Error('Invalid plugin dependencies');
    const seen = new Set<string>();
    for (const d of m.dependencies) {
      if (!object(d) || !safeId.test(d.id) || d.id === m.id || seen.has(d.id) || typeof d.minVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(d.minVersion) || !valid(d.minVersion)) throw Error('Invalid plugin dependencies');
      keys(d, ['id', 'minVersion'], 'dependency field'); seen.add(d.id);
    }
  }
  if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.length > 10 || !m.permissions.every((v: unknown) => { text(v); return true; }))) throw Error('Invalid permission hints');
  if (m.setup !== undefined) {
    if (!object(m.setup)) throw Error('Invalid setup'); keys(m.setup, ['script', 'description'], 'setup field');
    pluginRelativePath(m.setup.script); text(m.setup.description, 500);
    if (!/\.m?js$/.test(m.setup.script)) throw Error('Setup must be a Node script');
  }
  if (m.defaults !== undefined) {
    if (!object(m.defaults) || Object.keys(m.defaults).length > 5 || JSON.stringify(m.defaults).length > 16000) throw Error('Invalid configuration defaults');
    for (const [namespace, config] of Object.entries(m.defaults)) { validatePluginNamespace(namespace); if (!object(config)) throw Error('Default configuration must be an object'); }
  }
  let entries: NormalizedPluginManifest['entries'] = { session: legacySessionEntry }, hostApi = '*', capabilities: string[] = [], configNamespaces = Object.keys(m.defaults ?? {});
  if (m.schemaVersion === 2) {
    if (m.entries !== undefined && !object(m.entries)) throw Error('Invalid manifest entries');
    keys(m.entries ?? {}, ['session', 'application'], 'entry scope'); entries = {};
    for (const scope of ['session', 'application'] as const) if (m.entries?.[scope] !== undefined) {
      const entry = pluginRelativePath(m.entries[scope]);
      if (!/\.(?:m?js|ts|tsx|mts)$/.test(entry)) throw Error('Plugin entries must be JavaScript or TypeScript modules');
      entries[scope] = entry;
    }
    if (!entries.session && !entries.application && !m.ui) throw Error('Manifest requires an entry or declarative UI');
    if (entries.session && entries.session === entries.application) throw Error('Session and application entries must be distinct');
    if (m.requires !== undefined) {
      if (!object(m.requires)) throw Error('Invalid host requirements'); keys(m.requires, ['hostApi', 'capabilities'], 'host requirement');
      if (m.requires.hostApi !== undefined) { if (typeof m.requires.hostApi !== 'string' || !validRange(m.requires.hostApi)) throw Error('Invalid host API requirement'); hostApi = m.requires.hostApi; }
      if (m.requires.capabilities !== undefined) {
        if (!Array.isArray(m.requires.capabilities) || m.requires.capabilities.length > 30) throw Error('Invalid host capabilities');
        for (const capability of m.requires.capabilities) text(capability, 100);
        capabilities = [...new Set<string>(m.requires.capabilities)];
      }
    }
    configNamespaces = [];
    if (m.configNamespaces !== undefined) {
      if (!Array.isArray(m.configNamespaces) || m.configNamespaces.length > 5) throw Error('Invalid configuration namespaces');
      for (const namespace of m.configNamespaces) validatePluginNamespace(namespace);
      configNamespaces = [...new Set<string>(m.configNamespaces)];
    }
    for (const namespace of Object.keys(m.defaults ?? {})) if (!configNamespaces.includes(namespace)) throw Error('Default configuration namespace must be declared');
    if (m.configSchema !== undefined) {
      if (!object(m.configSchema) || Object.keys(m.configSchema).length > 5 || JSON.stringify(m.configSchema).length > 32000) throw Error('Invalid configuration schema');
      for (const [namespace, schema] of Object.entries(m.configSchema)) {
        validatePluginNamespace(namespace); validateSchema(schema);
        if (!configNamespaces.includes(namespace)) throw Error('Configuration schema namespace must be declared');
        if (schema.type !== 'object') throw Error('Configuration namespace schema must have type object');
        if (m.defaults && own(m.defaults, namespace)) validatePluginConfig(schema, m.defaults[namespace], namespace);
      }
    }
    if (m.ui !== undefined) validateUI(m.ui, configNamespaces, m.configSchema);
  }
  if (entries.session) capabilities.push('session-extensions');
  if (entries.application) capabilities.push('application-lifecycle');
  // v1 historically tolerated unrelated metadata. Do not turn an unvalidated
  // v1 field named ui/configSchema into a new v2 host contribution.
  return {
    schemaVersion: m.schemaVersion, id: m.id, name: m.name, platforms: m.platforms, minNode: m.minNode,
    setup: m.setup, permissions: m.permissions, defaults: m.defaults,
    entries, requires: { hostApi, capabilities: [...new Set(capabilities)] }, dependencies: m.dependencies ?? [], configNamespaces,
    ...(m.schemaVersion === 2 ? { ui: m.ui, configSchema: m.configSchema } : {}),
  } as NormalizedPluginManifest;
}
export function validatePluginEntries(root: string, manifest: NormalizedPluginManifest): void {
  const realRoot = fs.realpathSync(root);
  for (const entry of [...Object.values(manifest.entries), ...(manifest.setup ? [manifest.setup.script] : [])]) {
    const file = path.join(root, entry), real = fs.realpathSync(file);
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) throw Error('Plugin entry/setup must be a file inside its package');
  }
}
export function readPluginManifest(root: string, packageName?: string): NormalizedPluginManifest | undefined {
  const file = path.join(root, 'ashub-plugin.json');
  if (!fs.existsSync(file)) return;
  const pkg = packageName ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  const legacy = PLUGIN_ENTRY_FILES.find(entry => fs.existsSync(path.join(root, entry)));
  const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(file, 'utf8')), pkg, legacy);
  validatePluginEntries(root, manifest);
  return manifest;
}
export interface PluginCompatibility { compatible: boolean; errors: string[] }
export interface PluginHostEnvironment {
  platform?: string; nodeVersion?: string; hostApiVersion?: string; capabilities?: readonly string[];
  dependencies?: ReadonlyMap<string, { version?: string; enabled: boolean; compatible?: boolean }>;
}
export function pluginCompatibility(manifest: NormalizedPluginManifest, host: PluginHostEnvironment = {}): PluginCompatibility {
  const errors: string[] = [];
  const platform = host.platform ?? process.platform, node = host.nodeVersion ?? process.versions.node;
  const capabilities = new Set(host.capabilities ?? HOST_PLUGIN_CAPABILITIES);
  if (manifest.platforms && !manifest.platforms.includes(platform)) errors.push(`Unsupported platform: ${platform}`);
  if (!satisfies(node, `>=${manifest.minNode ?? '22.12.0'}`)) errors.push(`Node ${manifest.minNode ?? '22.12.0'} or newer required`);
  if (!satisfies(host.hostApiVersion ?? HOST_PLUGIN_API_VERSION, manifest.requires.hostApi)) errors.push(`Host API ${manifest.requires.hostApi} required`);
  for (const capability of manifest.requires.capabilities) if (!capabilities.has(capability)) errors.push(`Unsupported host capability: ${capability}`);
  if (host.dependencies) for (const dep of manifest.dependencies) {
    const installed = host.dependencies.get(dep.id);
    if (!installed?.enabled || installed.compatible === false || !installed.version || !valid(installed.version) || !satisfies(installed.version, `>=${dep.minVersion}`)) errors.push(`Dependency ${dep.id} >= ${dep.minVersion} must be installed, compatible and enabled`);
  }
  return { compatible: errors.length === 0, errors };
}
