import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentShellCore } from 'agent-sh';
import { CONFIG_DIR } from 'agent-sh/settings';
import type { BridgeFactory, SessionKind } from './bridges/types.js';
import { updateSettingsFile } from './settings-store.js';

export const INTEGRATIONS_DISABLED = 'ashub.integrations.disabled';
export class BackendUnavailable extends Error {}
// Reserved historical identities, not implementations. Without these, an old
// provider could become a settings-only provider or be silently backfilled.
const legacyProviders = new Map([['gemini', ['gemini-4-hydrogen', 'gemini-4-neon']]]);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'builtin-plugins');
export interface IntegrationModel {
  id: string; modalities?: ('text' | 'image')[]; reasoning?: boolean; contextWindow?: number; reasoningLevels?: string[];
}
interface Provider { id: string; models: IntegrationModel[]; reasoningFormat?: 'effort' }
export interface ConversationBackendInfo { kind: SessionKind; label: string; providerLabel: string; switchFromAgent: boolean }
export type ProjectTaskProfile = 'inline-review';
export interface ProjectBackendInfo {
  id: string;
  label: string;
  taskProfile: ProjectTaskProfile;
  authorization: 'project';
}
export type ProjectWorkerBackend = ProjectBackendInfo & { kind: SessionKind };
export interface ConversationBackend extends ConversationBackendInfo {
  makeBridge: BridgeFactory;
  project?: ProjectBackendInfo;
}
interface Descriptor {
  id: string; name: string; provider?: Provider; desktop?: boolean;
  description: string;
}
export interface IntegrationModule {
  configureProvider?(context: ReturnType<AgentShellCore['extensionContext']>, provider: Provider): void;
  createBackend?(resolveProxy: (url: string) => Promise<string> | undefined): ConversationBackend;
}
function disabledIds(settings: Record<string, unknown>): string[] {
  const value = settings[INTEGRATIONS_DISABLED];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) {
    throw new Error(`Invalid ${INTEGRATIONS_DISABLED} in settings.json`);
  }
  return value;
}
function readDisabled(file: string): string[] {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof SyntaxError) throw new SyntaxError('Invalid JSON in settings.json');
    throw error;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings object');
  return disabledIds(settings);
}
let installed: Array<Descriptor & { entry: string }> | undefined;
function discover() {
  if (installed) return installed;
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return installed = []; throw error; }
  installed = dirs.filter(e => e.isDirectory() && /^[a-z][a-z0-9-]*$/.test(e.name)).sort((a,b) => a.name.localeCompare(b.name)).flatMap(({ name }) => {
    const dir = path.join(root, name), entry = path.join(dir, 'integration.js');
    const manifest = path.join(dir, 'assets', 'integration.json');
    // Source-mode test harnesses have .ts modules, and no compiled files.
    if (!fs.existsSync(manifest) || !(fs.existsSync(entry) || fs.existsSync(path.join(dir, 'integration.ts')))) return [];
    const descriptor = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Descriptor;
    return [{ ...descriptor, id: name, entry }];
  });
  return installed;
}
// An unreadable policy is not an empty policy. Latch the failure until
// restart so no optional integration is enabled by a later partial repair.
let launchDisabled: Set<string> | null | undefined;
export function initializeIntegrations() {
  if (launchDisabled !== undefined) return;
  try { launchDisabled = new Set(readDisabled(path.join(CONFIG_DIR, 'settings.json'))); }
  catch {
    launchDisabled = null;
    console.warn('[integrations] Could not read optional integration preferences from settings.json; all optional integrations are disabled until the file is repaired and asHub is restarted.');
  }
}
function enabledAtLaunch(id: string) {
  initializeIntegrations();
  return launchDisabled?.has(id) === false;
}
export function integrationProviders() {
  return discover().flatMap(d => d.provider && enabledAtLaunch(d.id) ? [d.provider] : []);
}
export function optionalProvider(id: string | undefined) { return integrationProviders().find(p => p.id === id); }
export function allowsProvider(id: string): boolean {
  return !(legacyProviders.has(id) || discover().some(d => d.provider?.id === id)) || !!optionalProvider(id);
}
export function reservedProvider(model?: string): string | undefined {
  if (!model) return undefined;
  for (const d of discover()) if (d.provider?.models.some(m => m.id === model)) return d.provider.id;
  for (const [id, models] of legacyProviders) if (models.includes(model)) return id;
  return undefined;
}
const modules = new Map<string, Promise<IntegrationModule>>();
function load(entry: string): Promise<IntegrationModule> {
  let pending = modules.get(entry);
  if (!pending) { pending = import(pathToFileURL(entry).href); modules.set(entry, pending); }
  return pending;
}
export async function configureIntegrationProviders(ctx: ReturnType<AgentShellCore['extensionContext']>) {
  for (const d of discover()) if (d.provider && enabledAtLaunch(d.id)) {
    const plugin = await load(d.entry);
    plugin.configureProvider!(ctx, d.provider);
  }
}
export async function desktopConversationBackends(resolveProxy: (url: string) => Promise<string> | undefined): Promise<ConversationBackend[]> {
  const result: ConversationBackend[] = [];
  for (const d of discover()) if (d.desktop && enabledAtLaunch(d.id)) {
    try { result.push((await load(d.entry)).createBackend!(resolveProxy)); }
    catch (error) { console.error(`[integrations] Could not load ${d.id}:`, error); }
  }
  return result;
}
const pluginId = (d: Descriptor) => d.provider ? `builtin:provider:${d.provider.id}` : `builtin:integration:${d.id}`;
export function integrationPluginCatalog(file: string) {
  const desired = new Set(readDisabled(file));
  return discover().map(d => ({
    id: pluginId(d), name: d.name, source: 'asHub', builtin: true as const, optional: true as const,
    enabled: !desired.has(d.id), restartRequired: !desired.has(d.id) !== enabledAtLaunch(d.id), description: d.description,
    ...(d.provider ? { providerId: d.provider.id, configNamespace: `providers.${d.provider.id}` } : {}),
  }));
}
export function setIntegrationEnabled(file: string, id: string, enabled: boolean): boolean {
  const d = discover().find(d => pluginId(d) === id);
  if (!d) return false;
  initializeIntegrations();
  updateSettingsFile(file, data => {
    const disabled = new Set(disabledIds(data));
    if (enabled) disabled.delete(d.id); else disabled.add(d.id);
    data[INTEGRATIONS_DISABLED] = [...disabled];
    return data;
  });
  return true;
}
