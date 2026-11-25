/** One-time compatibility bridge. New accounts, enrollment and networking live
 * in the optional plugin; this module only moves existing local authorization. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RemoteSecretStore } from './connector.js';
import type { PluginSecretStore } from '../extensions/backends.js';
import type { SharedConversations } from '../extensions/shared-conversations.js';
import { pluginCatalog, readPluginSettings, BUNDLED_ENABLED, PLUGIN_DISABLED, type PluginEntry } from '../plugins.js';
import { pluginDataDirectory } from '../extensions/data-directory.js';
import { updateSettingsFile } from '../settings-store.js';
export const legacyMobileFeature = {
  id: 'mobile-access', name: '移动访问', scope: 'application',
  description: '设备互联迁移尚未完成，暂时保留旧手机连接。可在此关闭旧连接。更新设备互联插件、确认系统安全存储可用后，重启 asHub 重试迁移。',
} as const;
function isDeviceMigrationTarget(entry: PluginEntry): boolean {
  return entry.manifest?.id === 'ashub-multi-machine' && entry.manifest.requires.capabilities.includes('shared-conversations');
}
export class DeviceMigrationConflict extends Error {
  constructor(readonly pluginId: string, cause: unknown, readonly allowLegacy = true, readonly fallbackStore?: RemoteSecretStore) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
/** Keep the old connector and its dependencies out of regular host startup. */
export async function loadLegacyMobile(options: { store?: RemoteSecretStore; dataDir: string; localToken?: string }) {
  const [{ MobileAccessExtension }, { RemoteConnector }] = await Promise.all([import('./extension.js'), import('./connector.js')]);
  return new MobileAccessExtension(new RemoteConnector(options));
}
function readTargetCredentials(entry: PluginEntry, secrets: PluginSecretStore) {
  const key=createHash('sha256').update(entry.id+'\0device').digest('hex');
  const value=secrets.read(key);
  return { key, prior:value?JSON.parse(value):null };
}
function stagedTargetId(settingsFile: string, secrets: PluginSecretStore | undefined) {
  if(!secrets) return;
  let entry: PluginEntry | undefined;
  try {
    entry=pluginCatalog(settingsFile).find(isDeviceMigrationTarget);
    if(entry && readTargetCredentials(entry,secrets).prior?.legacyMigrationPending===true) return entry.id;
  } catch {
    // A credential read can recover during activation. Treat an unreadable target conservatively.
    return entry?.id;
  }
}
type MigrationOptions = {settingsFile:string;sessionsDir:string;legacy?:RemoteSecretStore;secrets?:PluginSecretStore;sharing:SharedConversations};
const receiptFile = (dir: string) => path.join(dir, 'remote-requests.json');
function writeMigrationFile(file: string, value: unknown, suffix: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + suffix, JSON.stringify(value), { mode: 0o600, flush: true });
  fs.renameSync(file + suffix, file);
}
function mergeReceipts(source: string, target: string, deviceId?: string, ensureTarget = false) {
  const rank = { pending: 0, unknown: 1, done: 2 };
  type Receipt = {digest:string;state:keyof typeof rank};
  const readReceipts = (file: string): Record<string, Receipt> | undefined => {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((r: any) => !r || typeof r.digest !== 'string' || !Object.hasOwn(rank, r.state))) throw Error('Invalid device receipts');
    return Object.assign(Object.create(null) as Record<string, Receipt>, value);
  };
  const incoming = readReceipts(source);
  if (!incoming && !deviceId) return;
  const existing = readReceipts(target);
  const merged = existing ?? (Object.create(null) as Record<string, Receipt>);
  let changed = ensureTarget && !existing;
  for (const [id, receipt] of Object.entries(incoming ?? {} as Record<string, Receipt>)) {
    if (deviceId && !id.startsWith(deviceId + ':')) continue;
    const old = merged[id];
    if (old && (old.digest !== receipt.digest || (deviceId && old.state === 'done' && receipt.state === 'done' && !isDeepStrictEqual(old, receipt)))) throw Error('Conflicting device receipt');
    if (!old || rank[receipt.state] > rank[old.state]) { merged[id] = receipt; changed = true; }
  }
  if (changed) writeMigrationFile(target, merged, '.migrate');
}

/** Older versions could record completion even though the target could not run.
 * The marker remains authoritative, with an added handoff bit only while the
 * verified old publisher may have newer receipts than the plugin. */
function recoverCompletedMigration(opts: MigrationOptions, marker: string) {
  let completed;
  try { completed = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return; }
  if (completed?.version !== 1 || typeof completed.pluginId !== 'string') return;
  const hadFallback = completed.legacyFallback === true;
  let blockedId = completed.pluginId;
  let mustBlock = hadFallback;
  try {
    const candidates = pluginCatalog(opts.settingsFile).filter(entry => [entry.manifest?.id, entry.packageName, entry.damagedAppId].includes('ashub-multi-machine'));
    if (candidates.length === 1) blockedId = candidates[0]!.id;
    const entry = candidates.length === 1 ? candidates[0] : undefined;
    if (!entry || !isDeviceMigrationTarget(entry) || entry.id !== completed.pluginId || !entry.applicationSpecifier || entry.sessionSpecifier) throw Error('Cannot identify the historical application publisher');
    if (!hadFallback && (!entry.compatibilityError || !entry.enabled)) return;
    const store = opts.legacy;
    if (!store || !opts.secrets) throw Error('Historical device credentials are unavailable');
    const saved = store.read();
    if (!saved) throw Error('Historical legacy identity is unavailable');
    const legacy = JSON.parse(saved);
    const { prior } = readTargetCredentials(entry, opts.secrets);
    if (!legacy || prior?.legacyMigrationPending !== true || prior.enabled === false ||
        !(['deviceId', 'deviceToken', 'username'] as const).every(key => typeof legacy[key] === 'string' && legacy[key] && legacy[key] === prior[key]) ||
        !Array.isArray(legacy.roots) || !legacy.roots.length || !legacy.roots.every((root: unknown) => typeof root === 'string' && path.isAbsolute(root)) ||
        !isDeepStrictEqual(prior.roots, legacy.roots) || typeof prior.grantId !== 'string' ||
        !isDeepStrictEqual(opts.sharing.bind(entry.id, new AbortController().signal).scope(prior.grantId), legacy.roots)) throw Error('Cannot verify historical device identity and sharing scope');
    const legacyEnabled = legacy.enabled !== false && !(readPluginSettings(opts.settingsFile)['ashub.features.disabled'] || []).includes(legacyMobileFeature.id);
    const oldJournal = receiptFile(path.join(opts.sessionsDir, 'remote'));
    const pluginJournal = receiptFile(pluginDataDirectory(opts.settingsFile, entry.id));
    // Takeover creates this journal even when there are no requests yet. Its
    // absence after takeover cannot be treated as an empty receipt history.
    if (hadFallback && !fs.existsSync(oldJournal)) throw Error('Historical fallback receipt journal is missing');
    if (entry.compatibilityError) {
      if (!entry.enabled || !legacyEnabled) {
        if (hadFallback) throw Error('Historical fallback is disabled until the receipt handoff');
        return;
      }
      mustBlock = true;
      mergeReceipts(pluginJournal, oldJournal, legacy.deviceId, true);
      if (!hadFallback) writeMigrationFile(marker, { ...completed, legacyFallback: true }, '.tmp');
      // Recheck the validated identity when the fallback actually consumes it.
      throw new DeviceMigrationConflict(entry.id, Error(entry.compatibilityError), true, {
        read() { if (store.read() !== saved) throw Error('Historical device credentials changed'); return saved; },
        write(value) { store.write(value); },
      });
    }
    mergeReceipts(oldJournal, pluginJournal, legacy.deviceId);
    // Honor a local stop/disconnect during fallback without touching its grant
    // or credentials. A compatible plugin may still be explicitly re-enabled.
    if (!legacyEnabled && entry.enabled) updateSettingsFile(opts.settingsFile, settings => {
      if (entry.bundled) settings[BUNDLED_ENABLED] = (settings[BUNDLED_ENABLED] || []).filter((id: string) => id !== entry.id);
      else settings[PLUGIN_DISABLED] = [...new Set([...(settings[PLUGIN_DISABLED] || []), entry.id])];
      return settings;
    });
    const { legacyFallback: _, ...original } = completed;
    writeMigrationFile(marker, original, '.tmp');
  } catch (cause) {
    if (cause instanceof DeviceMigrationConflict) throw cause;
    if (mustBlock) throw new DeviceMigrationConflict(blockedId, cause, false);
  }
}
export function migrateDeviceInterconnect(opts: MigrationOptions) {
  const marker=path.join(opts.sessionsDir,'device-interconnect-migrated.json');
  if(fs.existsSync(marker))return recoverCompletedMigration(opts,marker);
  if(!opts.legacy)return;
  let legacy;
  try {
    const saved=opts.legacy.read();
    if(!saved)return;
    legacy=JSON.parse(saved);
    if(!legacy || typeof legacy.deviceId!=='string' || typeof legacy.deviceToken!=='string' || typeof legacy.username!=='string' || !Array.isArray(legacy.roots) || !legacy.roots.length)throw Error('Invalid existing device identity');
  } catch(cause) {
    // A previous attempt may have staged credentials even if the old store is currently unreadable.
    const id=stagedTargetId(opts.settingsFile,opts.secrets);
    if(id)throw new DeviceMigrationConflict(id,cause);
    throw cause;
  }
  if(!opts.secrets)throw Error('Cannot migrate device identity without encrypted plugin storage');
  const entry=pluginCatalog(opts.settingsFile).find(isDeviceMigrationTarget);
  if(!entry)throw Error('Update the device interconnect plugin before migrating mobile access');
  let mayPublishLegacyIdentity=true;
  try {
    const {key,prior}=readTargetCredentials(entry,opts.secrets);
    const staged=prior?.legacyMigrationPending===true;
    mayPublishLegacyIdentity=staged || prior?.deviceId===legacy.deviceId;
    // Check availability after reading credentials: a deferred target may be
    // upgraded in-process, and must not publish a staged copy alongside fallback.
    if(entry.compatibilityError)throw Error(entry.compatibilityError);
    if(!entry.applicationSpecifier)throw Error('The device interconnect plugin requires an application entry for migration');
    const settings=readPluginSettings(opts.settingsFile);
    const enabled=legacy.enabled!==false && !(settings['ashub.features.disabled']||[]).includes(legacyMobileFeature.id);
    // Only transfer receipts to a publisher that inherits the legacy identity.
    if(!prior || mayPublishLegacyIdentity) mergeReceipts(receiptFile(path.join(opts.sessionsDir,'remote')),receiptFile(pluginDataDirectory(opts.settingsFile,entry.id)));
    // Keep a separately configured publisher's identity and grant.
    if(!prior || staged) {
      const service=opts.sharing.bind(entry.id,new AbortController().signal);
      const oldGrant=typeof prior?.grantId==='string'?prior.grantId:undefined;
      const reusable=oldGrant && JSON.stringify(service.scope(oldGrant))===JSON.stringify(legacy.roots);
      const grantId=reusable?oldGrant:opts.sharing.importGrant(entry.id,legacy.roots);
      // A store may throw after persisting credentials. Keep a single publisher on that path.
      mayPublishLegacyIdentity=true;
      try {opts.secrets.write(key,JSON.stringify({...legacy,enabled,grantId,legacyMigrationPending:true}));}
      catch(e){if(grantId!==oldGrant)opts.sharing.revoke(entry.id,grantId);throw e;}
      if(oldGrant && oldGrant!==grantId)opts.sharing.revoke(entry.id,oldGrant);
    }
    // The legacy switch only initializes the bundled plugin.
    if(enabled && entry.bundled && (!prior || staged)) updateSettingsFile(opts.settingsFile, settings=>{
      settings[BUNDLED_ENABLED]=[...new Set([...(settings[BUNDLED_ENABLED]||[]),entry.id])];return settings;
    });
    fs.mkdirSync(opts.sessionsDir,{recursive:true});
    fs.writeFileSync(marker+'.tmp',JSON.stringify({version:1,pluginId:entry.id}),{mode:0o600,flush:true});fs.renameSync(marker+'.tmp',marker);
  } catch(cause) {
    if(mayPublishLegacyIdentity)throw new DeviceMigrationConflict(entry.id,cause);
    throw cause;
  }
}
